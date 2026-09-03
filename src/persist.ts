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

/**
 * Wire persistence for one atom: hydrate (sync storage hydrates before this
 * returns — no flash of initial state), migrate stepwise if the stored
 * version is behind, then write-through on every change (one write per batch,
 * serialized from the change event's value — never a peek). Hydration
 * failures log and leave the initial value; the app keeps working.
 */
export function persistAtom(node: any, atomName: string, config: PersistConfig): PersistHandle {
  const key = config.key ?? atomName
  const targetVersion = config.version ?? 1
  const hydrated = observable(false)
  let applyingStored = false
  let record: HydrationRecord | undefined

  // record lands before the flip and the hook, so an onHydrate interceptor
  // reading either sees a settled atom
  const settle = (outcome: HydrationRecord): void => {
    record = outcome
    hydrated.set(true)
    runHydrate(outcome)
  }

  const applyStored = (raw: string | null | undefined): void => {
    let outcome: HydrationRecord
    if (raw != null) {
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
      void config.storage.setString(
        key,
        JSON.stringify({ v: targetVersion, data: node.peek() }),
      )
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
  const write = (value: unknown): void => {
    void config.storage.setString(key, JSON.stringify({ v: targetVersion, data: value }))
  }

  let lastWriteAt = -Infinity
  let trailing: ReturnType<typeof setTimeout> | null = null
  let latest: unknown

  node.onChange(({ value }: { value: unknown }) => {
    if (applyingStored) return
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
