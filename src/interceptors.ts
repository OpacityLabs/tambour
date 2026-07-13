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
  /** Every event/streamEvent fire — the devtools timeline feed. */
  onEventFire?: (eventName: string, args: unknown[]) => void
  /** Handler errors from events — fires whether or not the caller awaited. */
  onEventError?: (eventName: string, error: unknown, args: unknown[]) => void
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

/** Dispatched from inside Legend's notification path — interceptor errors are
 *  contained here, because an exception thrown through Legend's dispatch
 *  corrupts its internal state (verified empirically). */
export function runReactionLoop(name: string, recentChain: string[]): void {
  for (const i of interceptors) {
    try {
      i.onReactionLoop?.(name, recentChain)
    } catch (err) {
      console.error('[concordia] onReactionLoop interceptor threw:', err)
    }
  }
}
