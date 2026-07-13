import { observable, batch } from '@legendapp/state'
import type { Atom } from './types'

interface RegistryEntry {
  name: string
  node$: any
  initial: unknown
}

const registry = new Map<string, RegistryEntry>()

/**
 * Register a named root state node. The name is a real registration: devtools
 * identity, persistence key (Phase 4), and the entry that powers resetAll /
 * snapshot / restore. Every node underneath is independently observable — the
 * atom is the unit of registration, not of reactivity.
 */
export function atom<T>(name: string, initial: T): Atom<T> {
  if (registry.has(name)) {
    throw new Error(
      `[concordia] duplicate atom name '${name}'. Atom names must be unique; ` +
      `in tests, call clearRegistry() between cases.`,
    )
  }
  const node$ = observable(structuredClone(initial))
  registry.set(name, { name, node$, initial: structuredClone(initial) })
  return node$ as unknown as Atom<T>
}

/** Internal/devtools: the writable node for a registered atom. */
export function getAtomNode(name: string): unknown {
  return registry.get(name)?.node$
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
