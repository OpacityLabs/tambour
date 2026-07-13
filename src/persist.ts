import { observable } from '@legendapp/state'
import type { ConcordiaStorage } from './storage'

export interface PersistConfig {
  storage: ConcordiaStorage
  /** Current schema version (default 1). Bump when the persisted shape changes. */
  version?: number
  /** Stepwise migrations, keyed by TARGET version: `{ 2: v1 => v2shape, 3: v2 => v3shape }`.
   *  Data stored at version 1 replays 2 then 3. Each is written once, against
   *  a shape you knew at the time, and never edited again. */
  migrations?: Record<number, (previous: any) => any>
  /** Storage key — defaults to the atom name. */
  key?: string
}

export interface PersistHandle {
  hydrated$: any               // Legend observable<boolean> (kept internal-typed)
  whenHydrated: Promise<void>
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
export function persistAtom(node$: any, atomName: string, config: PersistConfig): PersistHandle {
  const key = config.key ?? atomName
  const targetVersion = config.version ?? 1
  const hydrated$ = observable(false)
  let applyingStored = false

  const applyStored = (raw: string | null | undefined): void => {
    if (raw != null) {
      try {
        const stored = JSON.parse(raw) as Stored
        let data = stored.data
        for (let v = (stored.v ?? 1) + 1; v <= targetVersion; v++) {
          const migrate = config.migrations?.[v]
          if (migrate) data = migrate(data)
        }
        applyingStored = true
        try {
          node$.set(data)
        } finally {
          applyingStored = false
        }
      } catch (error) {
        console.error(`[concordia] failed to hydrate atom '${atomName}':`, error)
      }
    }
    hydrated$.set(true)
  }

  const raw = config.storage.getString(key)
  const whenHydrated =
    raw instanceof Promise
      ? raw.then(applyStored, error => {
          console.error(`[concordia] storage read failed for atom '${atomName}':`, error)
          hydrated$.set(true)
        })
      : (applyStored(raw), Promise.resolve())

  node$.onChange(({ value }: { value: unknown }) => {
    if (applyingStored) return
    void config.storage.setString(key, JSON.stringify({ v: targetVersion, data: value }))
  })

  return { hydrated$, whenHydrated }
}
