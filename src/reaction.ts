import { observe } from '@legendapp/state'
import { runWithOrigin } from './context'
import { runReactionLoop } from './interceptors'
import type { ReadonlyNodeBase } from './types'

export interface ReactionOptions {
  /** Evaluate against current state at registration (the hydration case).
   *  Default: fire on change only. */
  immediate?: boolean
}

type Node<T> = ReadonlyNodeBase<T>

/**
 * State-triggered synchronous effect: n deps, then a react function receiving
 * plain values. The react function may call updates, fire events, or noop —
 * but never `await` (async work belongs in event handlers).
 *
 * Edge-triggering is composition: depend on a boolean selector and it fires
 * exactly on transitions. Dep values are identity-compared between runs, so
 * equals-selectors (stable refs) and unchanged primitives never re-fire.
 *
 * Returns a dispose function.
 */
export function reaction<A>(name: string, a: Node<A>, react: (a: A) => void, options?: ReactionOptions): () => void
export function reaction<A, B>(name: string, a: Node<A>, b: Node<B>, react: (a: A, b: B) => void, options?: ReactionOptions): () => void
export function reaction<A, B, C>(name: string, a: Node<A>, b: Node<B>, c: Node<C>, react: (a: A, b: B, c: C) => void, options?: ReactionOptions): () => void
export function reaction<A, B, C, D>(name: string, a: Node<A>, b: Node<B>, c: Node<C>, d: Node<D>, react: (a: A, b: B, c: C, d: D) => void, options?: ReactionOptions): () => void
export function reaction(name: string, ...rest: unknown[]): () => void {
  const last = rest[rest.length - 1]
  const options: ReactionOptions | undefined =
    typeof last === 'object' && last !== null && typeof (last as any).get !== 'function'
      ? (rest.pop() as ReactionOptions)
      : undefined

  const react = rest.pop() as (...values: unknown[]) => void
  if (typeof react !== 'function') {
    throw new Error('[tambour] reaction: last non-options argument must be a function')
  }
  const deps = rest as Node<unknown>[]
  if (deps.length === 0) {
    throw new Error('[tambour] reaction: at least one dependency is required')
  }

  let lastValues: unknown[] | null = null

  const dispose = observe(() => {
    const values = deps.map(d => d.get())   // .get() inside observe = tracked
    if (lastValues && values.every((v, i) => Object.is(v, lastValues![i]))) return
    const isFirstRun = lastValues === null
    lastValues = values
    if (isFirstRun && !options?.immediate) return
    runWithOrigin(name, () => guarded(name, () => react(...values)))
  })

  return dispose
}

// ---- loop protection: machinery, not advice -------------------------------
// A reaction -> update -> atom -> reaction loop is synchronous: it cannot
// yield to the microtask queue. So we count guarded runs per synchronous
// task (reset via queueMicrotask) — robust regardless of whether the runtime
// dispatches re-runs nested or sequentially. A genuine loop blows past the
// threshold before any reset can happen; converging cascades stay tiny.
//
// The breaker SKIPS runs rather than throwing: an exception thrown through
// Legend's notification dispatch corrupts its internal state (verified — it
// kills observers registered afterwards). Detection is reported out-of-band:
// console.error + the onReactionLoop interceptor, once per burst.

const MAX_RUNS_PER_TASK = 100
let runsThisTask = 0
let resetScheduled = false
let reportedThisTask = false
let recentChain: string[] = []

function guarded(name: string, fn: () => void): void {
  runsThisTask++
  recentChain.push(name)
  if (recentChain.length > 8) recentChain.shift()
  if (!resetScheduled) {
    resetScheduled = true
    queueMicrotask(() => {
      runsThisTask = 0
      resetScheduled = false
      reportedThisTask = false
      recentChain = []
    })
  }
  if (runsThisTask > MAX_RUNS_PER_TASK) {
    if (!reportedThisTask) {
      reportedThisTask = true
      console.error(
        `[tambour] reaction loop detected (${runsThisTask} reaction runs in one ` +
        `synchronous task; recent chain: ${recentChain.join(' → ')}). A reaction is ` +
        `(transitively) re-triggering itself through an update. Circuit-breaking.`,
      )
      runReactionLoop(name, [...recentChain])
    }
    return   // circuit-break: skip the run so the cascade dies out
  }
  fn()
}
