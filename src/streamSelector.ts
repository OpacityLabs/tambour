import { observable } from '@legendapp/state'
import { synced } from '@legendapp/state/sync'
import type { Observable as RxObservable, Subscription } from 'rxjs'
import type { ReadonlyNode } from './types'

export interface StreamSelectorOptions<T> {
  default?: T
}

/**
 * An Rx pipeline landing in a Legend node — the "async selector". Lazily
 * activates on first observer, refCounts, and tears down after the last
 * leaves (re-activation is async: emissions during the gap are missed).
 * Errors log and the node holds its last value.
 *
 * `default` changes the TYPE: without it the node is honestly `T | undefined`
 * ("not loaded yet" is a state consumers must handle); with it, undefined is
 * unrepresentable.
 */
export function streamSelector<T>(
  source: RxObservable<T>,
  opts: { default: T },
): ReadonlyNode<T>
export function streamSelector<T>(
  source: RxObservable<T>,
  opts?: StreamSelectorOptions<T>,
): ReadonlyNode<T | undefined>
export function streamSelector<T>(
  source: RxObservable<T>,
  opts?: StreamSelectorOptions<T>,
): ReadonlyNode<T | undefined> {
  const node$ = observable<T | undefined>(
    synced({
      initial: opts?.default,
      subscribe: ({ update }) => {
        const sub: Subscription = source.subscribe({
          // mode 'set' is load-bearing: Legend's default update path MERGES
          // keyed arrays, so a shrinking emission ([a,b,c,d] → [d]) would
          // corrupt the node ([d,b,c,d]). Emissions replace wholesale.
          next: value => update({ value, mode: 'set' }),
          // errors must not kill the node: log and hold last value
          error: err => console.error('[streamSelector] pipeline error:', err),
        })
        return () => sub.unsubscribe()
      },
    }) as any,
  )
  return node$ as unknown as ReadonlyNode<T | undefined>
}
