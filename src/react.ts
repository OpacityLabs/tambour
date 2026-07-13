import { use$ as legendUse$ } from '@legendapp/state/react'
import type { ReadonlyNodeBase } from './types'

/**
 * Subscribe a component to any concordia node — atom path, selector, family
 * entry, or streamSelector. The component re-renders only when the node's
 * value actually changes (equals-selectors return stable references, so their
 * suppressed updates never re-render).
 *
 * Always passes a tracked selector function to Legend, which makes every node
 * kind work uniformly — including the equals wrapper, which is not a raw
 * Legend observable.
 */
export function use$<T>(node: ReadonlyNodeBase<T>): T {
  return legendUse$(() => node.get())
}

/** Re-exports from Legend's React bindings — already optimal, not rewrapped. */
export { observer, Memo, Show } from '@legendapp/state/react'
