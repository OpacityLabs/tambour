import { batch, observable } from '@legendapp/state'
import { Observable } from 'rxjs'
import { currentOrigin, runWithOrigin } from './context'
import { runEventError, runEventFire } from './interceptors'
import type { ReadonlyNode } from './types'

/** Observable in-flight status of a command event (see `statusOf`). */
export interface EventStatus {
  /** At least one invocation is currently running. */
  pending: boolean
  /** Number of running invocations (plain concurrency can overlap). */
  inFlight: number
  /** The last rejection; cleared on the next fire. Supersessions from
   *  `concurrency: 'switch'` do not count as errors. */
  error: unknown
  /** The last winning settle completed without error. False until the first
   *  fire (distinguishes "settled successfully" from "never fired") and
   *  cleared on each fire — a re-submit shows a spinner, not a stale
   *  checkmark. Superseded runs never set it, even if they complete. */
  success: boolean
}

const EVENT_STATUS = new WeakMap<object, any>()

/** Internal: the status node for a command event, undefined for anything else
 *  (streamEvents have no handler — nothing can be pending). */
export function eventStatus(target: unknown): ReadonlyNode<EventStatus> | undefined {
  return typeof target === 'function' ? EVENT_STATUS.get(target) : undefined
}

export interface EventOptions {
  /**
   * 'exhaust' — while an invocation runs, re-fires return the in-flight promise
   *             (double-submit protection).
   * 'switch'  — a new call aborts the running one; the handler receives an
   *             AbortSignal as its trailing parameter.
   * omitted   — plain async: call twice, runs twice, nothing tracked.
   */
  concurrency?: 'switch' | 'exhaust'
  /**
   * Retries after a failed attempt: a number allows up to that many retries
   * (`retry: 3` → at most 4 attempts); a predicate receives (failureCount
   * starting at 1, error) and returns true to retry. DEFAULT: 0 — the runtime
   * cannot know a handler is idempotent, so repeating a server write is
   * opt-in per event. Retries happen inside ONE logical run: `pending` spans
   * attempts, `error`/`success` settle only on the final outcome, and a
   * switch-superseded run never retries.
   */
  retry?: number | ((failureCount: number, error: unknown) => boolean)
  /**
   * Delay before each retry, in ms — a number, or (failureCount, error) => ms.
   * Default: exponential 1s, 2s, 4s… capped at 30s (`defaultRetryDelay`).
   */
  retryDelay?: number | ((failureCount: number, error: unknown) => number)
  /**
   * Per-ATTEMPT budget in ms: a late attempt fails with TimeoutError (and
   * retries, if `retry` allows). The underlying work is NOT cancelled — the
   * late result is ignored. Deliberately not wired to the switch AbortSignal,
   * whose abort means supersession (silent), never failure.
   */
  timeout?: number
}

/** Default retry backoff: 1s, 2s, 4s… capped at 30s. */
export const defaultRetryDelay = (failureCount: number): number =>
  Math.min(1000 * 2 ** (failureCount - 1), 30_000)

/** Thrown when an attempt exceeds `timeout` ms. Retryable like any failure. */
export class TimeoutError extends Error {
  constructor(eventName: string, ms: number) {
    super(`[concordia] event '${eventName}' attempt timed out after ${ms}ms`)
    this.name = 'TimeoutError'
  }
}

/** INTERNAL seam (not exported from the package index): called exactly once
 *  per run at settle with the ORIGINAL call args — never the switch signal,
 *  never per-attempt. mutation() hangs `invalidates` here so invalidation
 *  can't run for intermediate retry failures or superseded runs. */
export const kOnSettle = Symbol('concordia.onSettle')

type OnSettle = (superseded: boolean, error: unknown, args: unknown[]) => void

type Listener = (payload: unknown) => void

const LISTENERS = Symbol('concordia.listeners')
const EVENT_NAME = Symbol('concordia.eventName')

interface EventInternals {
  [LISTENERS]: Set<Listener>
  [EVENT_NAME]: string
  readonly name: string
}

export type CommandEvent<A extends unknown[], R> = ((...args: A) => Promise<R>) & EventInternals
export type StreamEvent<T> = ((payload: T) => void) & EventInternals

function makeInternals<F extends (...args: never[]) => unknown>(fn: F, name: string): F & EventInternals {
  const listeners = new Set<Listener>()
  Object.defineProperties(fn, {
    [LISTENERS]: { value: listeners },
    [EVENT_NAME]: { value: name },
    name: { value: name },
  })
  return fn as F & EventInternals
}

function notify(ev: EventInternals, args: unknown[]): void {
  runEventFire(ev[EVENT_NAME], args)
  const payload = args.length <= 1 ? args[0] : args
  for (const l of ev[LISTENERS]) l(payload)
}

/**
 * A named, awaitable async command — calling it executes exactly the handler
 * you wrote and returns its promise. The wrapper adds: the name (timeline /
 * causal attribution for updates called synchronously inside), the
 * eventToStream tap, opt-in concurrency, and error routing (unawaited fires
 * still reach interceptors instead of vanishing).
 */
export function event<A extends unknown[], R>(
  name: string,
  handler: (...args: [...A, AbortSignal]) => R | Promise<R>,
  options: EventOptions & { concurrency: 'switch' },
): CommandEvent<A, R>
export function event<A extends unknown[], R>(
  name: string,
  handler: (...args: A) => R | Promise<R>,
  options?: EventOptions,
): CommandEvent<A, R>
export function event(
  name: string,
  handler: (...args: any[]) => any,
  options?: EventOptions,
): CommandEvent<any[], any> {
  const concurrency = options?.concurrency
  const retryOpt = options?.retry ?? 0
  const shouldRetry =
    typeof retryOpt === 'function' ? retryOpt : (n: number) => n <= retryOpt
  const delayOpt = options?.retryDelay ?? defaultRetryDelay
  const delayFor = typeof delayOpt === 'function' ? delayOpt : () => delayOpt
  const timeoutMs = options?.timeout
  const onSettle = (options as Record<symbol, unknown> | undefined)?.[kOnSettle] as
    | OnSettle
    | undefined

  let inFlight: Promise<unknown> | null = null           // exhaust
  let controller: AbortController | null = null          // switch

  const status$ = observable<EventStatus>({
    pending: false, inFlight: 0, error: undefined, success: false,
  })

  const settle = (superseded: boolean, error?: unknown): void => {
    batch(() => {
      const n = Math.max(0, status$.inFlight.peek() - 1)
      // a supersession is not an outcome — only the surviving run may write
      // error/success, even if the superseded handler ran to completion
      if (superseded) status$.assign({ pending: n > 0, inFlight: n })
      else if (error !== undefined) status$.assign({ pending: n > 0, inFlight: n, error, success: false })
      else status$.assign({ pending: n > 0, inFlight: n, success: true })
    })
  }

  const fire = (...args: unknown[]): Promise<unknown> => {
    if (concurrency === 'exhaust' && inFlight) return inFlight // coalesced: status untouched

    notify(ev, args)

    let handlerArgs = args
    if (concurrency === 'switch') {
      controller?.abort()
      controller = new AbortController()
      handlerArgs = [...args, controller.signal]
    }
    const myController = controller

    batch(() => {
      status$.assign({
        pending: true, inFlight: status$.inFlight.peek() + 1, error: undefined, success: false,
      })
    })

    // one attempt, optionally raced against the per-attempt timeout budget.
    // The losing run keeps going but its result lands on an already-settled
    // promise (handled — no unhandled rejection, no cancellation implied).
    const attempt = (): Promise<unknown> => {
      const run = (async () => await runWithOrigin(name, () => handler(...handlerArgs)))()
      if (timeoutMs === undefined) return run
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new TimeoutError(name, timeoutMs)), timeoutMs)
        run.then(
          value => { clearTimeout(timer); resolve(value) },
          error => { clearTimeout(timer); reject(error) },
        )
      })
    }

    const promise = (async () => {
      // async wrapper: a synchronously-throwing handler still rejects (never
      // throws). Retries live INSIDE this one logical run — pending spans
      // attempts; only the final outcome settles into error/success.
      let failureCount = 0
      for (;;) {
        try {
          return await attempt()
        } catch (error) {
          if (myController?.signal.aborted) throw error // superseded: never retry
          failureCount += 1
          if (!shouldRetry(failureCount, error)) throw error
          const delay = delayFor(failureCount, error)
          if (delay > 0) await new Promise(r => setTimeout(r, delay))
          if (myController?.signal.aborted) throw error // superseded during backoff
        }
      }
    })()

    const fireOnSettle = (superseded: boolean, error?: unknown): void => {
      if (!onSettle) return
      try {
        onSettle(superseded, error, args)
      } catch (hookError) {
        runEventError(name, hookError, args) // e.g. a bad invalidation target
      }
    }

    promise.then(
      () => {
        const superseded = myController?.signal.aborted ?? false
        settle(superseded)
        fireOnSettle(superseded)
      },
      error => {
        const superseded = myController?.signal.aborted ?? false
        settle(superseded, error)
        fireOnSettle(superseded, error)
      },
    )

    if (concurrency === 'exhaust') {
      inFlight = promise
      promise.finally(() => { inFlight = null }).catch(() => {})
    }

    // route errors to interceptors even if nobody awaits; the extra .catch
    // marks the rejection handled so unawaited fires don't crash the process,
    // while awaiting callers still see the rejection on the returned promise
    promise.catch(error => runEventError(name, error, args)).catch(() => {})

    return promise
  }

  const ev = makeInternals(fire, name)
  EVENT_STATUS.set(ev, status$)
  return ev
}

/**
 * A typed payload source — never has a handler, returns void (nothing to
 * await). Fire it like a function; consume it via eventToStream.
 */
export function streamEvent<T = void>(name: string): StreamEvent<T> {
  const fire = (payload: T): void => {
    notify(ev, [payload])
  }
  const ev = makeInternals(fire, name)
  return ev as StreamEvent<T>
}

/**
 * Event -> Rx stream of payloads. Works on both kinds: streamEvent is the
 * primary customer; tapping a command event (analytics observing fires) is
 * legal too. No replay — events are moments, not states; late subscribers see
 * only future fires. Command events with multiple args emit the args tuple.
 */
export function eventToStream<T>(ev: StreamEvent<T>): Observable<T>
export function eventToStream<A extends unknown[], R>(
  ev: CommandEvent<A, R>,
): Observable<A extends [infer P] ? P : A>
export function eventToStream(ev: EventInternals): Observable<unknown> {
  return new Observable(subscriber => {
    const listener: Listener = payload => subscriber.next(payload)
    ev[LISTENERS].add(listener)
    return () => ev[LISTENERS].delete(listener)
  })
}

export { currentOrigin }
