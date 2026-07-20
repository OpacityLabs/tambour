import type { Patch } from 'immer'

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
  onEventFire?: (eventName: string, args: unknown[]) => void
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

export function runEventFire(eventName: string, args: unknown[]): void {
  for (const i of interceptors) i.onEventFire?.(eventName, args)
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
