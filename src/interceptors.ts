import type { Patch } from 'immer'

/** Which flavor fired: a command `event` or a `streamEvent`. Streams never
 *  settle, so consumers pairing fire/settle should key off this. */
export type EventKind = 'event' | 'stream'

/** Why a query fetch started: a virgin key's first observation, a staleness
 *  revalidation (age, or a prior error), or an invalidation. */
export type QueryFetchReason = 'activate' | 'stale' | 'invalidate'

/** Outcome of one persisted atom's hydration. `source` is where the atom's
 *  post-hydration value came from: 'storage' (the stored envelope applied,
 *  with fromVersion → toVersion describing any migration replay) or 'initial'
 *  (a virgin key whose initial was materialized — or, when `error` is set, a
 *  failure that kept the initial). */
export interface HydrationRecord {
  atomName: string
  source: 'storage' | 'initial'
  /** Version the envelope was stored at (source 'storage' only). */
  fromVersion?: number
  /** The atom's current schema version (source 'storage' only). */
  toVersion?: number
  /** Parse/migration/storage-read failure — the atom kept its initial value. */
  error?: unknown
}

export interface UpdateRecord {
  name: string
  args: unknown[]
  scope: string[]
  patches: Patch[]
  inverse: Patch[]
  /** Causal attribution: the event/reaction that (synchronously) invoked this
   *  update, or null for direct calls. Best-effort across awaits (no zones). */
  origin: string | null
}

export interface Interceptor {
  /** Runs before the recipe. Throw to veto — a clean no-op for all atoms. */
  before?: (name: string, args: unknown[], scope: string[]) => void
  /** Runs after patches apply, with the full record (devtools/log/undo feed). */
  after?: (record: UpdateRecord) => void
  /** Every event/streamEvent fire — the devtools timeline feed. Command
   *  events emit once per LOGICAL run (an exhaust-coalesced call joins the
   *  in-flight run and does not re-fire). */
  onEventFire?: (eventName: string, args: unknown[], kind: EventKind) => void
  /** Handler errors from events — fires whether or not the caller awaited. */
  onEventError?: (eventName: string, error: unknown, args: unknown[]) => void
  /** Once per logical COMMAND-event run, on its final outcome (after
   *  retries; `error` undefined = clean settle). `superseded` marks a
   *  switch-superseded run — not an outcome. `args` is the run's own args
   *  array, reference-equal to the one onEventFire received, so fire/settle
   *  pair by identity across overlapping runs. streamEvents never settle.
   *  (Added 2026-07-17 for the auto-span recipe: fire+error alone cannot
   *  close a span on success.) */
  onEventSettle?: (
    eventName: string,
    error: unknown | undefined,
    args: unknown[],
    superseded: boolean,
  ) => void
  /** A reaction loop was circuit-broken (reported once per burst). */
  onReactionLoop?: (name: string, recentChain: string[]) => void
  /** A query fetch ACTUALLY starting — emitted after the in-flight dedupe
   *  guard, so every call is a real request. `keyArgs` is the entry's own
   *  args array, reference-equal on the matching onQuerySettle (one in-flight
   *  per key by construction), so fetch/settle pair by identity. */
  onQueryFetch?: (queryName: string, keyArgs: unknown[], reason: QueryFetchReason) => void
  /** A query fetch settling: `error` undefined = fulfilled (data landed),
   *  otherwise the rejection (last data held, entry stays stale). */
  onQuerySettle?: (queryName: string, keyArgs: unknown[], error: unknown | undefined) => void
  /** An invalidate() call — `keyArgs` is 'all' for a whole-family target.
   *  `origin` is the event/mutation whose settle (synchronously) triggered
   *  it, or null for direct calls (a retry button). Any refetches it causes
   *  arrive as their own onQueryFetch('invalidate') calls. */
  onQueryInvalidate?: (queryName: string, keyArgs: unknown[] | 'all', origin: string | null) => void
  /** A persisted atom finished hydrating — stored data applied, a virgin
   *  key's initial materialized, or a failure keeping the initial. Fires
   *  after the atom's hydrated node flips true. Sync storage (MMKV) hydrates
   *  during atom() registration, so an interceptor installed later sees
   *  nothing live — read hydrationRecords() for what already happened. */
  onHydrate?: (record: HydrationRecord) => void
}

const interceptors: Interceptor[] = []

export function addInterceptor(interceptor: Interceptor): () => void {
  interceptors.push(interceptor)
  return () => {
    const i = interceptors.indexOf(interceptor)
    if (i >= 0) interceptors.splice(i, 1)
  }
}

export function runBefore(name: string, args: unknown[], scope: string[]): void {
  for (const i of interceptors) i.before?.(name, args, scope)
}

export function runAfter(record: UpdateRecord): void {
  for (const i of interceptors) i.after?.(record)
}

export function runEventFire(eventName: string, args: unknown[], kind: EventKind): void {
  for (const i of interceptors) i.onEventFire?.(eventName, args, kind)
}

export function runEventError(eventName: string, error: unknown, args: unknown[]): void {
  for (const i of interceptors) i.onEventError?.(eventName, error, args)
}

/** Dispatched from the run's settle path (a promise continuation) — a throwing
 *  interceptor there would surface as an unrelated unhandled rejection, so
 *  errors are contained per-interceptor. */
export function runEventSettle(
  eventName: string,
  error: unknown | undefined,
  args: unknown[],
  superseded: boolean,
): void {
  for (const i of interceptors) {
    try {
      i.onEventSettle?.(eventName, error, args, superseded)
    } catch (err) {
      console.error('[tambour] onEventSettle interceptor threw:', err)
    }
  }
}

/** Dispatched from inside Legend's notification path — interceptor errors are
 *  contained here, because an exception thrown through Legend's dispatch
 *  corrupts its internal state (verified empirically). */
export function runReactionLoop(name: string, recentChain: string[]): void {
  for (const i of interceptors) {
    try {
      i.onReactionLoop?.(name, recentChain)
    } catch (err) {
      console.error('[tambour] onReactionLoop interceptor threw:', err)
    }
  }
}

/** The query dispatchers all contain interceptor errors: they run from an
 *  activation microtask, promise continuations, and mid-invalidation loops —
 *  a throw in any of those corrupts in-flight bookkeeping or surfaces as an
 *  unrelated unhandled rejection. */
export function runQueryFetch(queryName: string, keyArgs: unknown[], reason: QueryFetchReason): void {
  for (const i of interceptors) {
    try {
      i.onQueryFetch?.(queryName, keyArgs, reason)
    } catch (err) {
      console.error('[tambour] onQueryFetch interceptor threw:', err)
    }
  }
}

export function runQuerySettle(queryName: string, keyArgs: unknown[], error: unknown | undefined): void {
  for (const i of interceptors) {
    try {
      i.onQuerySettle?.(queryName, keyArgs, error)
    } catch (err) {
      console.error('[tambour] onQuerySettle interceptor threw:', err)
    }
  }
}

export function runQueryInvalidate(
  queryName: string,
  keyArgs: unknown[] | 'all',
  origin: string | null,
): void {
  for (const i of interceptors) {
    try {
      i.onQueryInvalidate?.(queryName, keyArgs, origin)
    } catch (err) {
      console.error('[tambour] onQueryInvalidate interceptor threw:', err)
    }
  }
}

/** Dispatched from hydration paths — module-import time for sync storage,
 *  promise continuations for async — so interceptor errors are contained. */
export function runHydrate(record: HydrationRecord): void {
  for (const i of interceptors) {
    try {
      i.onHydrate?.(record)
    } catch (err) {
      console.error('[tambour] onHydrate interceptor threw:', err)
    }
  }
}
