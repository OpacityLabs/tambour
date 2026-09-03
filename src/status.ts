import { eventStatus, type CommandEvent, type EventStatus } from './events'
import type { ReadonlyNode } from './types'

/**
 * @deprecated Use the event's own `.status` property — every command event
 * (and mutation) carries its status node: `useValue(syncNow.status)`,
 * `selector(a.status, b.status, (sa, sb) => sa.pending || sb.pending)`.
 * `statusOf(ev)` returns exactly `ev.status`; it survives only so existing
 * call sites keep working during migration (see NAMING.md).
 *
 * Queries never needed either form: a query node's value is the result
 * envelope itself — `useValue(myQuery(args))` → `{ data, pending, stale,
 * error, fetchedAt }`.
 */
export function statusOf<A extends unknown[], R>(ev: CommandEvent<A, R>): ReadonlyNode<EventStatus>
export function statusOf(target: unknown): ReadonlyNode<EventStatus> {
  const status = eventStatus(target)
  if (!status) {
    throw new Error(
      '[tambour] statusOf: expected a command event. Query metadata lives on the ' +
        'query node itself: useValue(myQuery(args)) → { data, pending, stale, error, fetchedAt }',
    )
  }
  return status
}
