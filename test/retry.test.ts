import { describe, expect, it, vi } from 'vitest'
import { defaultRetryDelay, event, TimeoutError } from '../src/events'
import { statusOf } from '../src/status'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('event retry', () => {
  it('retry: n — a flaky handler succeeds within budget; pending spans attempts', async () => {
    let calls = 0
    const flaky = event('r/flaky', async () => {
      calls++
      if (calls < 3) throw new Error(`fail ${calls}`)
      return 'ok'
    }, { retry: 2, retryDelay: 0 })

    const pendingListener = vi.fn()
    statusOf(flaky).pending.onChange(pendingListener)

    await expect(flaky()).resolves.toBe('ok')
    expect(calls).toBe(3) // 1 try + 2 retries
    await sleep(1)
    expect(statusOf(flaky).get()).toEqual({
      pending: false, inFlight: 0, error: undefined, success: true,
    })
    // ONE logical run: pending flipped true at fire and false at the final
    // settle — no flicker between attempts
    expect(pendingListener).toHaveBeenCalledTimes(2)
  })

  it('default is ZERO retries — a failing handler runs exactly once', async () => {
    let calls = 0
    const once = event('r/once', async () => { calls++; throw new Error('boom') })
    await expect(once()).rejects.toThrow('boom')
    expect(calls).toBe(1)
  })

  it('budget exhausted — rejects with the LAST error; status records it', async () => {
    let calls = 0
    const doomed = event('r/doomed', async () => {
      calls++
      throw new Error(`fail ${calls}`)
    }, { retry: 2, retryDelay: 0 })

    await expect(doomed()).rejects.toThrow('fail 3')
    expect(calls).toBe(3)
    await sleep(1)
    const s = statusOf(doomed).get()
    expect((s.error as Error).message).toBe('fail 3')
    expect(s.success).toBe(false)
  })

  it('predicate form — (failureCount, error) gates what is retryable', async () => {
    let calls = 0
    const picky = event('r/picky', async () => {
      calls++
      throw new Error(calls === 1 ? 'retryable' : 'fatal')
    }, { retry: (_n, e) => (e as Error).message === 'retryable', retryDelay: 0 })

    await expect(picky()).rejects.toThrow('fatal')
    expect(calls).toBe(2) // retried once, then the fatal error stopped it
  })

  it('retryDelay receives (failureCount, error) per retry', async () => {
    const seen: Array<[number, string]> = []
    let calls = 0
    const spaced = event('r/spaced', async () => {
      calls++
      if (calls < 3) throw new Error(`e${calls}`)
      return 'ok'
    }, {
      retry: 5,
      retryDelay: (n, e) => { seen.push([n, (e as Error).message]); return 0 },
    })

    await spaced()
    expect(seen).toEqual([[1, 'e1'], [2, 'e2']])
  })

  it('defaultRetryDelay is exponential, capped at 30s', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(defaultRetryDelay))
      .toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
  })

  it('switch: supersession during backoff stops retrying; the failure stays silent', async () => {
    const attempts: string[] = []
    const load = event('r/switchy', async (id: string, _signal: AbortSignal) => {
      attempts.push(id)
      if (id === 'a') throw new Error('a fails')
      return 'b ok'
    }, { concurrency: 'switch', retry: 5, retryDelay: 60 })

    const pa = load('a').catch(e => e)
    await sleep(10) // 'a' failed once, now waiting out its 60ms backoff
    await expect(load('b')).resolves.toBe('b ok') // supersedes during the wait

    expect((await pa) instanceof Error).toBe(true) // caller still sees a's rejection
    await sleep(80) // well past a's backoff window
    expect(attempts).toEqual(['a', 'b']) // 'a' was never re-attempted

    const s = statusOf(load).get()
    expect(s.error).toBeUndefined() // superseded failure not recorded
    expect(s.success).toBe(true) // the surviving run's outcome
  })
})

describe('event timeout', () => {
  it('a slow attempt fails with TimeoutError; the late result is ignored', async () => {
    const slow = event('r/slow',
      () => new Promise(r => setTimeout(() => r('late'), 100)),
      { timeout: 20 })

    await expect(slow()).rejects.toBeInstanceOf(TimeoutError)
    await sleep(1)
    expect(statusOf(slow).get().error).toBeInstanceOf(TimeoutError)
    await sleep(120) // the late resolution lands on a settled promise: no effect
    expect(statusOf(slow).get().error).toBeInstanceOf(TimeoutError)
  })

  it('timeout + retry compose: a timed-out attempt retries, a fast one wins', async () => {
    let calls = 0
    const eventually = event('r/eventually', () => {
      calls++
      const ms = calls === 1 ? 100 : 1
      return new Promise(r => setTimeout(() => r(`try ${calls}`), ms))
    }, { timeout: 30, retry: 1, retryDelay: 0 })

    await expect(eventually()).resolves.toBe('try 2')
    expect(calls).toBe(2)
    await sleep(1)
    expect(statusOf(eventually).get().success).toBe(true)
  })
})
