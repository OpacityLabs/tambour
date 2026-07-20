import { observable, batch } from '@legendapp/state'
import { persistAtom, type PersistConfig, type PersistHandle } from './persist'
import type { Atom, ReadonlyNode } from './types'

export interface AtomOptions {
  persist?: PersistConfig
  /** Array GROWTH inside `update()` uses Legend's in-place `push` instead of
   *  replacing the array (~100x cheaper on large keyed arrays, and the only
   *  reason to reach for this). Covers plain appends AND middle inserts —
   *  Immer emits growth as replaces plus a trailing add. The cost: arrays
   *  KEEP THEIR IDENTITY while growing (removes still replace), so
   *  identity-keyed React consumers (useMemo deps, React.memo props) will
   *  not see additions — readers of a fast atom must derive through
   *  selectors or inline. Applies when an update's write scope names this
   *  atom's root node; child-node (scoped) writes always take safe appends.
   *  Reserve for measured hot paths. */
  fastAppends?: boolean
}

interface RegistryEntry {
  name: string
  node$: any
  initial: unknown
  persist?: PersistHandle
  fastAppends?: boolean
}

const registry = new Map<string, RegistryEntry>()
const byNode = new WeakMap<object, RegistryEntry>()
const ALWAYS_HYDRATED$ = observable(true)

/**
 * Register a named root state node. The name is a real registration: devtools
 * identity, persistence key (Phase 4), and the entry that powers resetAll /
 * snapshot / restore. Every node underneath is independently observable — the
 * atom is the unit of registration, not of reactivity.
 */
export function atom<T>(name: string, initial: T, options?: AtomOptions): Atom<T> {
  if (registry.has(name)) {
    throw new Error(
      `[tambour] duplicate atom name '${name}'. Atom names must be unique; ` +
      `in tests, call clearRegistry() between cases.`,
    )
  }
  const node$ = observable(structuredClone(initial))
  const entry: RegistryEntry = { name, node$, initial: structuredClone(initial) }
  if (options?.fastAppends) entry.fastAppends = true
  if (options?.persist) {
    entry.persist = persistAtom(node$, name, options.persist)
  }
  registry.set(name, entry)
  byNode.set(node$, entry)
  return node$ as unknown as Atom<T>
}

/** Hydration status node for an atom — always `true` for unpersisted atoms
 *  and for sync storage (MMKV). A function accessor rather than the spec's
 *  original `cart$.hydrated$` because attaching properties to a Legend proxy
 *  would create a state child named `hydrated$`. */
export function hydrationOf(atom$: Atom<any>): ReadonlyNode<boolean> {
  const entry = byNode.get(atom$ as unknown as object)
  return (entry?.persist?.hydrated$ ?? ALWAYS_HYDRATED$) as ReadonlyNode<boolean>
}

/** Resolves when every persisted atom registered SO FAR has hydrated.
 *  `await hydrated()` is the PersistGate replacement — call it after all
 *  module-level atoms have been imported. */
export function hydrated(): Promise<void> {
  const pending = [...registry.values()]
    .filter(e => e.persist)
    .map(e => e.persist!.whenHydrated)
  return Promise.all(pending).then(() => undefined)
}

/** Internal/devtools: the writable node for a registered atom. */
export function getAtomNode(name: string): unknown {
  return registry.get(name)?.node$
}

/** Internal: whether a write-scope node is an atom registered with
 *  `fastAppends`. Child-node scopes resolve false by design — scoped updates
 *  can't be traced to their owning atom without reaching into Legend
 *  internals, so they take the safe (identity-fresh) append path. */
export function fastAppendsFor(node$: object): boolean {
  return byNode.get(node$)?.fastAppends === true
}

export function atomNames(): string[] {
  return [...registry.keys()]
}

/** Restore every atom to its captured initial value (one batch). Clears
 *  nothing else — interceptors and registrations survive. */
export function resetAll(): void {
  batch(() => {
    for (const { node$, initial } of registry.values()) {
      node$.set(structuredClone(initial))
    }
  })
}

/** Deep-cloned view of all atom values, keyed by atom name. */
export function snapshot(): Record<string, unknown> {
  const snap: Record<string, unknown> = {}
  for (const { name, node$ } of registry.values()) {
    snap[name] = structuredClone(node$.peek())
  }
  return snap
}

/** Restore atoms from a snapshot() result (one batch). Atoms absent from the
 *  snapshot are left untouched. */
export function restore(snap: Record<string, unknown>): void {
  batch(() => {
    for (const [name, value] of Object.entries(snap)) {
      const entry = registry.get(name)
      if (entry) entry.node$.set(structuredClone(value))
    }
  })
}

/** Test utility: forget all registrations so names can be reused. Does not
 *  touch the underlying nodes. */
export function clearRegistry(): void {
  registry.clear()
}
