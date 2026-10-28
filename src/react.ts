import { use$ as legendUse } from '@legendapp/state/react'
import type { ReadonlyNodeBase } from './types'

/**
 * Subscribe a component to any tambour node — atom path, selector, family
 * entry, or streamSelector — and return its current VALUE. The component
 * re-renders only when the node's value actually changes (equals-selectors
 * return stable references, so their suppressed updates never re-render).
 *
 * Always passes a tracked selector function to Legend, which makes every node
 * kind work uniformly — including the equals wrapper, which is not a raw
 * Legend observable.
 *
 * Named `useValue` (not Legend's `use$`) on purpose: the React Compiler and
 * eslint-plugin-react-hooks detect hooks by /^use[A-Z0-9]/ — `$` fails the
 * check, so a component calling a `use$`-named hook gets memoized AROUND the
 * call and the hook is SKIPPED on re-renders ("Should have a queue" /
 * hook-order crashes at runtime; found on-device in the opacity migration).
 * See NAMING.md for the full convention.
 */
export function useValue<T>(node: ReadonlyNodeBase<T>): T {
  return legendUse(() => node.get())
}

/** Re-exports from Legend's React bindings — already optimal, not rewrapped. */
export { observer, Memo, Show } from '@legendapp/state/react'
