import { observable, type Observable as LegendObservable } from '@legendapp/state'
import { synced } from '@legendapp/state/sync'
import type { Observable as RxObservable, Subscription } from 'rxjs'

export interface StreamSelectorOptions<T> {
  default?: T
}

/**
 * An Rx pipeline landing in a Legend node — the "async selector".
 * Spike goals: verify lazy activation (the pipeline is NOT subscribed until the
 * node is first observed), value flow, and teardown behavior.
 */
export function streamSelector<T>(
  source: RxObservable<T>,
  opts?: StreamSelectorOptions<T>,
): LegendObservable<T | undefined> {
  const node$ = observable<T | undefined>(
    synced({
      initial: opts?.default,
      subscribe: ({ update }) => {
        const sub: Subscription = source.subscribe({
          next: value => update({ value }),
          // errors must not kill the node: log and hold last value
          error: err => console.error('[streamSelector] pipeline error:', err),
        })
        return () => sub.unsubscribe()
      },
    }) as any,
  )
  return node$ as LegendObservable<T | undefined>
}
