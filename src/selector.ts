import { isObservable, observable } from '@legendapp/state'
import type { ReadonlyNode, ReadonlyNodeBase } from './types'

/** Node check that never touches properties on Legend observables: accessing
 *  even the `.get` PROPERTY of a synced node (streamSelector, family entry)
 *  activates it — a module-level `selector(stream$, ...)` declaration would
 *  start the pipeline at import time. isObservable is symbol-based and inert;
 *  the property fallback only runs for plain wrapper nodes (equals-selectors),
 *  which have no activation semantics. */
const isNode = (v: unknown): boolean =>
  isObservable(v) || typeof (v as { get?: unknown } | null | undefined)?.get === 'function'

export interface SelectorOptions<R> {
  equals?: (a: R, b: R) => boolean
}

type Node<T> = ReadonlyNodeBase<T>

/**
 * Synchronous derivation. Two forms:
 *
 *   deps-then-combiner (the default — combiner is a pure function of plain values):
 *     const visible$ = selector(todos$.items, ui$.filter, (items, filter) => ...)
 *
 *   thunk (escape hatch for genuinely dynamic dependencies, Legend auto-tracking):
 *     const x$ = selector(() => (mode$.get() === 'a' ? a$.get() : b$.get()))
 *
 * Options trail: selector(...deps, combiner, { equals: shallowEqual })
 */
export function selector<R>(compute: () => R, options?: SelectorOptions<R>): ReadonlyNode<R>
export function selector<A, R>(a: Node<A>, combiner: (a: A) => R, options?: SelectorOptions<R>): ReadonlyNode<R>
export function selector<A, B, R>(a: Node<A>, b: Node<B>, combiner: (a: A, b: B) => R, options?: SelectorOptions<R>): ReadonlyNode<R>
export function selector<A, B, C, R>(a: Node<A>, b: Node<B>, c: Node<C>, combiner: (a: A, b: B, c: C) => R, options?: SelectorOptions<R>): ReadonlyNode<R>
export function selector<A, B, C, D, R>(a: Node<A>, b: Node<B>, c: Node<C>, d: Node<D>, combiner: (a: A, b: B, c: C, d: D) => R, options?: SelectorOptions<R>): ReadonlyNode<R>
export function selector<A, B, C, D, E, R>(a: Node<A>, b: Node<B>, c: Node<C>, d: Node<D>, e: Node<E>, combiner: (a: A, b: B, c: C, d: D, e: E) => R, options?: SelectorOptions<R>): ReadonlyNode<R>
export function selector<A, B, C, D, E, F, R>(a: Node<A>, b: Node<B>, c: Node<C>, d: Node<D>, e: Node<E>, f: Node<F>, combiner: (a: A, b: B, c: C, d: D, e: E, f: F) => R, options?: SelectorOptions<R>): ReadonlyNode<R>
export function selector(...args: unknown[]): any {
  const last = args[args.length - 1]
  const options: SelectorOptions<any> | undefined =
    typeof last === 'object' && last !== null && !isNode(last)
      ? (args.pop() as SelectorOptions<any>)
      : undefined

  const combiner = args.pop() as (...values: unknown[]) => unknown
  if (typeof combiner !== 'function') {
    throw new Error('[tambour] selector: last non-options argument must be a function')
  }
  const deps = args as Node<unknown>[]
  for (const d of deps) {
    if (!isNode(d)) {
      throw new Error('[tambour] selector: dependencies must be state nodes (atoms, node paths, or selectors)')
    }
  }

  const compute: () => unknown =
    deps.length === 0
      ? (combiner as () => unknown)                       // thunk form: auto-tracked
      : () => combiner(...deps.map(d => d.get()))         // deps form: tracked via .get()

  const inner$ = observable(compute)
  return options?.equals ? equalsNode(inner$, options.equals) : inner$
}

/**
 * Legend notifies on every object recompute regardless of value equality, so
 * equality filtering lives in a thin wrapper node: get()/peek() return a
 * memoized stable reference while values stay `equals`-equal (which also lets
 * useSyncExternalStore skip re-renders in the React bindings), and onChange
 * only forwards when the reference advances. Note: an equals-selector exposes
 * the node surface (get/peek/onChange) but not child path nodes — derived
 * values are consumed whole.
 */
function equalsNode(inner$: any, equals: (a: any, b: any) => boolean): any {
  let last: unknown
  let has = false
  const memo = (next: unknown) => {
    if (has && equals(last, next)) return last
    last = next
    has = true
    return last
  }
  return {
    get: () => memo(inner$.get()),
    peek: () => memo(inner$.peek()),
    onChange: (cb: (e: { value: unknown }) => void) =>
      inner$.onChange(({ value }: { value: unknown }) => {
        const prev = last
        const hadValue = has
        const next = memo(value)
        if (!hadValue || next !== prev) cb({ value: next })
      }),
  }
}
