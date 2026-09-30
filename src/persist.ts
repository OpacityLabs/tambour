import { observable } from '@legendapp/state'
import { runHydrate, type HydrationRecord } from './interceptors'
import type { TambourStorage } from './storage'

export interface PersistConfig {
  storage: TambourStorage
  /** Current schema version (default 1). Bump when the persisted shape changes. */
  version?: number
  /** Stepwise migrations, keyed by TARGET version: `{ 2: v1 => v2shape, 3: v2 => v3shape }`.
   *  Data stored at version 1 replays 2 then 3. Each is written once, against
   *  a shape you knew at the time, and never edited again. */
  migrations?: Record<number, (previous: any) => any>
  /** Storage key — defaults to the atom name. */
  key?: string
  /** Collapse write bursts: the first change after a quiet period writes
   *  immediately (leading edge); further changes inside the window coalesce
   *  into one trailing write of the LATEST value. For large atoms whose
   *  updates arrive in bursts (dial/slider commits), this bounds the
   *  stringify+write cost to one per window instead of one per change.
   *  Trade-off: a hard kill inside the window can lose up to `throttleMs` of
   *  changes — keep it small. Default 0 (write through on every change). */
  throttleMs?: number
}

export interface PersistHandle {
  hydrated: any               // Legend observable<boolean> (kept internal-typed)
  whenHydrated: Promise<void>
  /** Hydration outcome — undefined only while an async read is in flight.
   *  Kept so tools that attach after hydration can read what happened (sync
   *  MMKV hydrates during module import, before any interceptor installs). */
  readonly record?: HydrationRecord
}

/** Envelope written to storage. */
interface Stored {
  v: number
  data: unknown
}

const isPlainObject = (v: object): boolean => {
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * JSON.stringify enforcing the persistence contract: persisted atoms hold
 * plain JSON data. Anything JSON would silently reshape — a Date into a
 * string, a Map/Set/class instance into `{}`, NaN into null, a function into
 * nothing — hydrates as a different type, so it throws (naming the path)
 * instead of writing; `write` logs it and memory stays authoritative. Checked
 * inside the one stringify pass: no extra traversal. `undefined` is accepted
 * (an absent key reads the same).
 */
function serialize(atomName: string, envelope: Stored): string {
  const paths = new Map<unknown, string>()
  return JSON.stringify(envelope, function (this: object, key, value: unknown) {
    if (key === '' || (this === envelope && key === 'v')) return value   // the envelope itself
    const raw = (this as Record<string, unknown>)[key]                    // pre-toJSON: a Date is still a Date
    const path =
      this === envelope ? atomName : `${paths.get(this)}${Array.isArray(this) ? `[${key}]` : `.${key}`}`
    let kind: string | undefined
    if (typeof raw === 'object' && raw !== null) {
      if (Array.isArray(raw) || isPlainObject(raw)) paths.set(raw, path)
      else kind = raw.constructor?.name ?? 'object'
    } else if (typeof raw === 'number') {
      if (!Number.isFinite(raw)) kind = String(raw)
    } else if (typeof raw === 'function' || typeof raw === 'symbol' || typeof raw === 'bigint') {
      kind = typeof raw
    }
    if (kind) {
      throw new Error(
        `${path} is not plain JSON data (got ${kind}). Persisted atoms hold strings, finite ` +
          `numbers, booleans, null, plain objects and arrays — store a Date as an ISO string ` +
          `or epoch ms, a Map/Set as an object/array.`,
      )
    }
    return value
  })
}

/**
 * Wire persistence for one atom: hydrate (sync storage hydrates before this
 * returns — no flash of initial state), migrate stepwise if the stored
 * version is behind, then write-through on every change (one write per batch,
 * serialized from the change event's value — never a peek). Hydration
 * failures log and leave the initial value; the app keeps working.
 *
 * Async precedence: a write made while the read is in flight wins. It has
 * already gone through to storage, so the stored value is discarded rather
 * than applied over it — memory and storage always converge (a logout's
 * resetAll() inside the window stays reset).
 */
export function persistAtom(node: any, atomName: string, config: PersistConfig): PersistHandle {
  const key = config.key ?? atomName
  const targetVersion = config.version ?? 1
  const hydrated = observable(false)
  let applyingStored = false
  let settled = false
  let writtenBeforeHydration = false
  let record: HydrationRecord | undefined

  // record lands before the flip and the hook, so an onHydrate interceptor
  // reading either sees a settled atom
  const settle = (outcome: HydrationRecord): void => {
    settled = true
    record = outcome
    hydrated.set(true)
    runHydrate(outcome)
  }

  // Runs inside node.onChange: a throw here would escape into Legend's
  // dispatch (corrupting it) and fail the triggering set. Storage failures
  // log and keep memory authoritative; the app keeps working.
  const writeFailed = (error: unknown): void => {
    console.error(`[tambour] failed to persist atom '${atomName}':`, error)
  }
  const write = (value: unknown): void => {
    try {
      const result = config.storage.setString(key, serialize(atomName, { v: targetVersion, data: value }))
      if (result instanceof Promise) result.catch(writeFailed)
    } catch (error) {
      writeFailed(error)
    }
  }

  const applyStored = (raw: string | null | undefined): void => {
    let outcome: HydrationRecord
    if (writtenBeforeHydration) {
      // memory wins (see above); nothing came from storage
      outcome = { atomName, source: 'initial' }
    } else if (raw != null) {
      try {
        const stored = JSON.parse(raw) as Stored
        const fromVersion = stored.v ?? 1
        let data = stored.data
        for (let v = fromVersion + 1; v <= targetVersion; v++) {
          const migrate = config.migrations?.[v]
          if (migrate) data = migrate(data)
        }
        applyingStored = true
        try {
          node.set(data)
        } finally {
          applyingStored = false
        }
        outcome = { atomName, source: 'storage', fromVersion, toVersion: targetVersion }
      } catch (error) {
        console.error(`[tambour] failed to hydrate atom '${atomName}':`, error)
        outcome = { atomName, source: 'initial', error }
      }
    } else {
      // No stored value: materialize the initial value NOW. This makes
      // legacy-data migrations durable on first run — waiting for the first
      // write leaves a window where the legacy source can be destroyed
      // (learned the hard way: redux-persist rewrites its root envelope and
      // drops unknown keys the moment its reducer set shrinks).
      write(node.peek())
      outcome = { atomName, source: 'initial' }
    }
    settle(outcome)
  }

  const raw = config.storage.getString(key)
  const whenHydrated =
    raw instanceof Promise
      ? raw.then(applyStored, error => {
          console.error(`[tambour] storage read failed for atom '${atomName}':`, error)
          settle({ atomName, source: 'initial', error })
        })
      : (applyStored(raw), Promise.resolve())

  const throttleMs = config.throttleMs ?? 0
  let lastWriteAt = -Infinity
  let trailing: ReturnType<typeof setTimeout> | null = null
  let latest: unknown

  node.onChange(({ value }: { value: unknown }) => {
    if (applyingStored) return
    if (!settled) writtenBeforeHydration = true
    if (!throttleMs) {
      write(value)
      return
    }
    latest = value
    if (trailing) return               // a trailing write will pick up `latest`
    const sinceLast = Date.now() - lastWriteAt
    if (sinceLast >= throttleMs) {
      lastWriteAt = Date.now()
      write(value)
    } else {
      trailing = setTimeout(() => {
        trailing = null
        lastWriteAt = Date.now()
        write(latest)
      }, throttleMs - sinceLast)
    }
  })

  return { hydrated, whenHydrated, get record() { return record } }
}
