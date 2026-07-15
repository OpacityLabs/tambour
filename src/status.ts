import { eventStatus, type CommandEvent, type EventStatus } from './events'
import type { ReadonlyNode } from './types'

/**
 * EXPERIMENTAL — observable in-flight status for COMMAND EVENTS:
 *
 *   statusOf(syncNow) → { pending, inFlight, error }
 *
 * Events need an accessor because a command has no node to carry metadata.
 * Queries do NOT: a query node's value is the result envelope itself —
 * `use$(myQuery(args))` → `{ data, pending, stale, error, fetchedAt }`.
 *
 * An accessor rather than a property for the hydrationOf reason: attaching
 * anything to the event function would be fine, but the returned node is
 * ordinary and composes — `selector(statusOf(a), statusOf(b), (sa, sb) =>
 * sa.pending || sb.pending)`.
 */
export function statusOf<A extends unknown[], R>(ev: CommandEvent<A, R>): ReadonlyNode<EventStatus>
export function statusOf(target: unknown): ReadonlyNode<EventStatus> {
  const status$ = eventStatus(target)
  if (!status$) {
    throw new Error(
      '[concordia] statusOf: expected a command event. Query metadata lives on the ' +
        'query node itself: use$(myQuery(args)) → { data, pending, stale, error, fetchedAt }',
    )
  }
  return status$
}
