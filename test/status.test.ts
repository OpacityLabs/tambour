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
    expect(status$.get()).toEqual({ pending: false, inFlight: 0, error: undefined, success: false })

    const p1 = sync()
    expect(status$.get().pending).toBe(true)
    expect(status$.get().inFlight).toBe(1)

    const p2 = sync() // coalesced: same promise, no second in-flight
    expect(p2).toBe(p1)
    expect(status$.get().inFlight).toBe(1)

    gate.resolve('ok')
    await p1
    await sleep(1)
    expect(status$.get()).toEqual({ pending: false, inFlight: 0, error: undefined, success: true })
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
    expect(statusOf(doWork).get()).toEqual({ pending: false, inFlight: 0, error: undefined, success: true })
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

describe('statusOf(event).success — settle discrimination for mutations', () => {
  it('distinguishes "never fired" from "settled successfully"', async () => {
    const save = event('t/save', async () => 'ok')
    expect(statusOf(save).get().success).toBe(false) // idle, not "succeeded"

    await save()
    await sleep(1)
    expect(statusOf(save).get().success).toBe(true)
  })

  it('a re-fire clears success while pending — spinner, not a stale checkmark', async () => {
    const gate = deferred<string>()
    let first = true
    const save = event('t/resave', () => {
      if (first) { first = false; return Promise.resolve('ok') }
      return gate.promise
    })

    await save()
    await sleep(1)
    expect(statusOf(save).get().success).toBe(true)

    const p2 = save()
    expect(statusOf(save).get().success).toBe(false) // cleared at fire
    expect(statusOf(save).get().pending).toBe(true)

    gate.resolve('ok again')
    await p2
    await sleep(1)
    expect(statusOf(save).get().success).toBe(true)
  })

  it('an error settle records the error and leaves success false', async () => {
    const save = event('t/failsave', async () => { throw new Error('boom') })
    await save().catch(() => {})
    await sleep(1)
    const s = statusOf(save).get()
    expect(s.success).toBe(false)
    expect((s.error as Error).message).toBe('boom')
  })

  it('a superseded run never claims success, even if its handler completes anyway', async () => {
    const done: ReturnType<typeof deferred<string>>[] = []
    const load = event(
      't/switchsave',
      (_id: string, _signal: AbortSignal) => {
        const d = deferred<string>()
        done.push(d)
        return d.promise // deliberately ignores the abort signal
      },
      { concurrency: 'switch' },
    )

    load('a')
    load('b') // supersedes 'a'
    done[0]!.resolve('a-finished-anyway')
    await sleep(1)
    const mid = statusOf(load).get()
    expect(mid.success).toBe(false) // only the surviving run may speak
    expect(mid.pending).toBe(true)

    done[1]!.resolve('b-data')
    await sleep(1)
    expect(statusOf(load).get()).toEqual({ pending: false, inFlight: 0, error: undefined, success: true })
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
