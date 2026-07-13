import { Observable } from 'rxjs'
import { currentOrigin, runWithOrigin } from './context'
import { runEventError } from './interceptors'

export interface EventOptions {
  /**
   * 'exhaust' — while an invocation runs, re-fires return the in-flight promise
   *             (double-submit protection).
   * 'switch'  — a new call aborts the running one; the handler receives an
   *             AbortSignal as its trailing parameter.
   * omitted   — plain async: call twice, runs twice, nothing tracked.
   */
  concurrency?: 'switch' | 'exhaust'
}

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
  options: { concurrency: 'switch' },
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

  let inFlight: Promise<unknown> | null = null           // exhaust
  let controller: AbortController | null = null          // switch

  const fire = (...args: unknown[]): Promise<unknown> => {
    if (concurrency === 'exhaust' && inFlight) return inFlight

    notify(ev, args)

    let handlerArgs = args
    if (concurrency === 'switch') {
      controller?.abort()
      controller = new AbortController()
      handlerArgs = [...args, controller.signal]
    }

    const promise = (async () => {
      // async wrapper: a synchronously-throwing handler still rejects (never throws)
      return await runWithOrigin(name, () => handler(...handlerArgs))
    })()

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
