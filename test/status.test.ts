import { describe, expect, it } from 'vitest'
import { event } from '../src/events'
import { query } from '../src/query'
import { statusOf } from '../src/status'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('statusOf(event)', () => {
  it('tracks pending across an invocation, and exhaust-coalesced re-fires stay truthful', async () => {
    const gate = deferred<string>()
    const sync = event('t/sync', () => gate.promise, { concurrency: 'exhaust' })

    const status$ = statusOf(sync)
    expect(status$.get()).toEqual({ pending: false, inFlight: 0, error: undefined })

    const p1 = sync()
    expect(status$.get().pending).toBe(true)
    expect(status$.get().inFlight).toBe(1)

    const p2 = sync() // coalesced: same promise, no second in-flight
    expect(p2).toBe(p1)
    expect(status$.get().inFlight).toBe(1)

    gate.resolve('ok')
    await p1
    await sleep(1)
    expect(status$.get()).toEqual({ pending: false, inFlight: 0, error: undefined })
  })

  it('records rejections, clears the error on the next fire', async () => {
    let fail = true
    const doWork = event('t/flaky', async () => {
      if (fail) throw new Error('nope')
      return 'ok'
    })

    await doWork().catch(() => {})
    await sleep(1)
    expect((statusOf(doWork).get().error as Error).message).toBe('nope')

    fail = false
    const p = doWork()
    expect(statusOf(doWork).get().error).toBeUndefined() // cleared at fire
    await p
    await sleep(1)
    expect(statusOf(doWork).get()).toEqual({ pending: false, inFlight: 0, error: undefined })
  })

  it('a switch supersession is not recorded as an error', async () => {
    const done: ReturnType<typeof deferred<string>>[] = []
    const load = event(
      't/load',
      (id: string, signal: AbortSignal) => {
        const d = deferred<string>()
        done.push(d)
        signal.addEventListener('abort', () => d.reject(new DOMException('aborted', 'AbortError')))
        return d.promise
      },
      { concurrency: 'switch' },
    )

    const p1 = load('a').catch(() => {})
    load('b')
    await p1 // first run aborted by the second fire
    await sleep(1)
    const s = statusOf(load).get()
    expect(s.error).toBeUndefined() // supersession, not failure
    expect(s.pending).toBe(true) // the superseding run is still going
    expect(s.inFlight).toBe(1)

    done[1]!.resolve('b-data')
    await sleep(1)
    expect(statusOf(load).get().pending).toBe(false)
  })
})

describe('statusOf scope', () => {
  it('resolves command events only — query metadata lives on the query node itself', async () => {
    const ev = event('t/ev', async () => {})
    expect(statusOf(ev).get().pending).toBe(false)

    const q = query('t/q', async () => 1)
    expect((q() as any).get().pending).toBe(false) // envelope, not an accessor
    expect(() => statusOf(q() as any)).toThrow(/command event/)
    expect(() => statusOf({} as any)).toThrow(/command event/)
  })
})
