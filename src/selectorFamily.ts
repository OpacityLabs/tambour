import { observable } from '@legendapp/state'
import { synced } from '@legendapp/state/sync'
import type { ReadonlyNode } from './types'

export interface FamilyOptions {
  /** How long an entry survives after its last observer leaves. Default 100ms —
   *  long enough that list re-renders don't thrash, short enough not to leak. */
  graceMs?: number
}

/**
 * Parameterized selectors with a keyed cache and refCount eviction:
 *
 *   const todoById = selectorFamily((id: string) =>
 *     selector(todos.items, items => items.find(t => t.id === id)))
 *
 * Same args -> same cached node. An entry evicts `graceMs` after its last
 * observer unsubscribes (re-observation within the grace window cancels
 * eviction). Args must be JSON-serializable (they form the cache key).
 */
export function selectorFamily<Args extends unknown[], R>(
  factory: (...args: Args) => ReadonlyNode<R>,
  options?: FamilyOptions,
): (...args: Args) => ReadonlyNode<R> {
  const graceMs = options?.graceMs ?? 100
  const cache = new Map<string, { node: any; evictTimer: ReturnType<typeof setTimeout> | null }>()

  return (...args: Args) => {
    const key = JSON.stringify(args)
    const hit = cache.get(key)
    if (hit) return hit.node

    const inner = factory(...args)
    const entry = {
      evictTimer: null as ReturnType<typeof setTimeout> | null,
      node: undefined as any,
    }
    // synced gives us the lifecycle: `subscribe` runs on first observer, its
    // cleanup on last-observer-detach — which is where eviction is scheduled.
    entry.node = observable(
      synced({
        get: () => inner.get(),
        subscribe: () => {
          if (entry.evictTimer) {
            clearTimeout(entry.evictTimer)
            entry.evictTimer = null
          }
          return () => {
            entry.evictTimer = setTimeout(() => cache.delete(key), graceMs)
          }
        },
      }) as any,
    )
    cache.set(key, entry)
    return entry.node as ReadonlyNode<R>
  }
}
