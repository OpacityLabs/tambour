import { use$ as legendUse$ } from '@legendapp/state/react'
import type { ReadonlyNodeBase } from './types'

/**
 * Subscribe a component to any tambour node — atom path, selector, family
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

/**
 * Compiler-safe alias of `use$` — SAME function, different name.
 *
 * The React Compiler (and eslint-plugin-react-hooks) detect hooks by name
 * with /^use[A-Z0-9]/ — `$` fails the check, so a component calling `use$`
 * gets memoized AROUND the call and the hook is SKIPPED on re-renders:
 * "Should have a queue" / hook-order crashes at runtime. Found on-device in
 * the opacity migration gate pass (every migrated screen crashed under
 * `reactCompiler: true`; headless bundles and non-React tests can't catch
 * it). Apps with the compiler enabled MUST use this name (or alias their
 * import to any /^use[A-Z0-9]/ name); `use$` remains for everyone else.
 */
export const useNode = use$

/** Re-exports from Legend's React bindings — already optimal, not rewrapped. */
export { observer, Memo, Show } from '@legendapp/state/react'
