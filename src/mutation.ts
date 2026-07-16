import {
  event,
  eventStatus,
  kOnSettle,
  type CommandEvent,
  type EventOptions,
  type EventStatus,
} from './events'
import { invalidate } from './query'
import type { ReadonlyNode } from './types'

export interface MutationOptions<A extends unknown[] = unknown[]> extends EventOptions {
  /**
   * Queries to invalidate after every winning settle — success OR error,
   * matching TanStack's onSettled guidance: a failed request may still have
   * landed server-side, and the refetch is the cheap way to re-sync truth.
   * Switch-superseded runs never invalidate; the surviving run will.
   *
   * Entries are families (every cached key) or nodes (one key):
   *
   *   invalidates: [libraryBooks]                       // all cached searches
   *   invalidates: [libraryBooks('austen')]             // one static key
   *   invalidates: ([id]) => [todoList, todoDetail(id)] // keyed by the CALL's args
   *
   * The function form receives the call's argument tuple (never the switch
   * AbortSignal) — destructure what you need. A tuple parameter rather than
   * spread parameters on purpose: a spread callback using only a PREFIX of
   * the args (the common case) trips TS's rest-tuple variance check, and a
   * prefix-signature union breaks contextual typing of unannotated params.
   * Result-dependent targets stay in the handler body, which has the result:
   * `invalidate(bookDetail(saved.id))`.
   */
  invalidates?: object[] | ((args: A) => object[])
}

/** A command event that carries its status node with it. */
export type Mutation<A extends unknown[], R> = CommandEvent<A, R> & {
  /** The same node `statusOf(mutation)` returns: { pending, inFlight, error, success }. */
  readonly status: ReadonlyNode<EventStatus>
}

/**
 * EXPERIMENTAL — a server write with the batteries attached: an `event`
 * (identical semantics, timeline entry, concurrency, statusOf, eventToStream)
 * whose status node rides on the function and whose settle can invalidate
 * queries declaratively.
 *
 *   export const donate = mutation('library/donate', b => api.donate(b), {
 *     invalidates: [libraryBooks],       // settle → stale → active keys refetch
 *     concurrency: 'exhaust',            // submit-style: mash-safe
 *   })
 *
 *   const { pending, success, error } = use$(donate.status)
 *   await donate(book)
 *
 * Deliberately NOT here: optimistic updates (straight-line code in the
 * handler — see the recipe in SPEC.md), a `data` field (results belong in
 * atoms via updates, or to the awaiting caller), and any concurrency default
 * (exhaust would coalesce re-fires with DIFFERENT args into the first run's
 * promise — silent arg loss for per-entity mutations like deleteTodo(id)).
 */
export function mutation<A extends unknown[], R>(
  name: string,
  handler: (...args: [...A, AbortSignal]) => R | Promise<R>,
  options: MutationOptions<NoInfer<A>> & { concurrency: 'switch' },
): Mutation<A, R>
export function mutation<A extends unknown[], R>(
  name: string,
  handler: (...args: A) => R | Promise<R>,
  options?: MutationOptions<NoInfer<A>>,
): Mutation<A, R>
export function mutation(
  name: string,
  handler: (...args: any[]) => any,
  options?: MutationOptions,
): Mutation<any[], any> {
  const invalidates = options?.invalidates

  // invalidation rides the event's settle seam, NOT a handler wrapper: with
  // retry it must run once on the final outcome (never per attempt), and a
  // superseded run must never invalidate. The seam receives the ORIGINAL
  // call args — the switch AbortSignal never reaches the callback.
  const ev = event(name, handler, {
    ...options,
    [kOnSettle]: invalidates
      ? (superseded: boolean, _error: unknown, args: unknown[]) => {
          if (superseded) return
          const targets = typeof invalidates === 'function' ? invalidates(args) : invalidates
          for (const t of targets) invalidate(t)
        }
      : undefined,
  } as EventOptions)
  Object.defineProperty(ev, 'status', { value: eventStatus(ev) })
  return ev as unknown as Mutation<any[], any>
}
