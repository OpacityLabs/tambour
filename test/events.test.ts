import { beforeEach, describe, expect, it, vi } from 'vitest'
import { firstValueFrom, toArray } from 'rxjs'
import { take } from 'rxjs/operators'
import { atom, clearRegistry } from '../src/atom'
import { event, eventToStream, streamEvent } from '../src/events'
import { addInterceptor } from '../src/interceptors'
import { update } from '../src/update'

beforeEach(() => clearRegistry())

const tick = () => new Promise<void>(r => setTimeout(r, 0))

describe('event: a named awaitable command', () => {
  it('executes the handler and returns its promise', async () => {
    const double = event('test/double', async (n: number) => n * 2)
    await expect(double(21)).resolves.toBe(42)
  })

  it('awaited calls reject normally; interceptors also see the error', async () => {
    const seen: any[] = []
    const off = addInterceptor({ onEventError: (name, err, args) => seen.push({ name, err, args }) })
    const boom = event('test/boom', async (x: number) => { throw new Error(`no ${x}`) })

    await expect(boom(7)).rejects.toThrow('no 7')
    await tick()
    expect(seen).toEqual([{ name: 'test/boom', err: new Error('no 7'), args: [7] }])
    off()
  })

  it('unawaited fires do not crash and still reach interceptors', async () => {
    const seen: string[] = []
    const off = addInterceptor({ onEventError: name => seen.push(name) })
    const boom = event('test/boom2', async () => { throw new Error('silent') })

    boom()          // deliberately not awaited
    await tick()
    expect(seen).toEqual(['test/boom2'])
    off()
  })

  it('a synchronously-throwing handler rejects instead of throwing', async () => {
    const bad = event('test/syncThrow', (): number => { throw new Error('sync') })
    await expect(bad()).rejects.toThrow('sync')
  })
})

describe('event: concurrency policies', () => {
  it('exhaust: re-fires during flight return the in-flight promise', async () => {
    let runs = 0
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const sync = event('test/sync', async () => { runs++; await gate; return runs }, { concurrency: 'exhaust' })

    const p1 = sync()
    const p2 = sync()
    expect(p2).toBe(p1)         // same promise back
    release()
    await expect(p1).resolves.toBe(1)
    expect(runs).toBe(1)

    await expect(sync()).resolves.toBe(2)   // after settle, fires run again
  })

  it('switch: a new call aborts the previous invocation via its trailing signal', async () => {
    const outcomes: string[] = []
    const load = event('test/load', async (id: string, signal: AbortSignal) => {
      await tick()
      outcomes.push(signal.aborted ? `${id}:aborted` : `${id}:done`)
    }, { concurrency: 'switch' })

    const p1 = load('a')
    const p2 = load('b')        // supersedes 'a'
    await Promise.all([p1, p2])
    expect(outcomes).toEqual(['a:aborted', 'b:done'])
  })
})

describe('streamEvent + eventToStream', () => {
  it('emits fired payloads to subscribers', async () => {
    const input = streamEvent<string>('search/input')
    const collected = firstValueFrom(eventToStream(input).pipe(take(2), toArray()))
    input('gro')
    input('groc')
    expect(await collected).toEqual(['gro', 'groc'])
  })

  it('no replay: late subscribers see only future fires', async () => {
    const input = streamEvent<number>('test/nums')
    input(1)
    const collected = firstValueFrom(eventToStream(input).pipe(take(1), toArray()))
    input(2)
    expect(await collected).toEqual([2])
  })

  it('command events are tappable too', async () => {
    const save = event('test/save', async (id: string) => id)
    const collected = firstValueFrom(eventToStream(save).pipe(take(1), toArray()))
    await save('x1')
    expect(await collected).toEqual(['x1'])
  })
})

describe('causal attribution', () => {
  it('updates called synchronously inside a handler carry the event as origin', async () => {
    const a$ = atom('a', { v: 0 })
    const setV = update('a/set', { a: a$ }, (d, v: number) => { d.a.v = v })
    const origins: (string | null)[] = []
    const off = addInterceptor({ after: r => origins.push(r.origin) })

    const apply = event('test/apply', (v: number) => { setV(v) })
    await apply(5)
    setV(9)   // direct call — no origin

    expect(origins).toEqual(['test/apply', null])
    off()
  })
})

describe('update hardening', () => {
  it('before interceptor can veto: recipe never runs, atoms untouched', () => {
    const a$ = atom('a', { v: 1 })
    const recipe = vi.fn((d: any) => { d.a.v = 99 })
    const setV = update('a/set', { a: a$ }, recipe)
    const off = addInterceptor({
      before: name => { if (name === 'a/set') throw new Error('vetoed') },
    })

    expect(() => setV()).toThrow('vetoed')
    expect(recipe).not.toHaveBeenCalled()
    expect(a$.v.peek()).toBe(1)
    off()
  })

  it('reads scope: readable on the draft, but writing to it throws cleanly', () => {
    const cart$ = atom('cart', { total: 10 })
    const settings$ = atom('settings', { taxRate: 0.1 })

    const applyTax = update('cart/applyTax',
      { writes: { cart: cart$ }, reads: { settings: settings$ } },
      (d) => { d.cart.total = d.cart.total * (1 + d.settings.taxRate) })
    applyTax()
    expect(cart$.total.peek()).toBeCloseTo(11)

    const corrupt = update('cart/corrupt',
      { writes: { cart: cart$ }, reads: { settings: settings$ } },
      (d) => { d.settings.taxRate = 0.5 })
    expect(() => corrupt()).toThrow(/wrote to 'settings'/)
    expect(settings$.taxRate.peek()).toBe(0.1)   // untouched
  })
})

describe('onEventSettle: the interceptor settle seam', () => {
  it('fires once per logical run with the SAME args array onEventFire saw; error undefined on clean settle', async () => {
    const fires: unknown[][] = []
    const settles: { error: unknown; args: unknown[]; superseded: boolean }[] = []
    const off = addInterceptor({
      onEventFire: (_n, args) => fires.push(args),
      onEventSettle: (_n, error, args, superseded) => settles.push({ error, args, superseded }),
    })
    const go = event('settle/clean', async (n: number) => n)

    await go(1)
    await tick()

    expect(settles.length).toBe(1)
    expect(settles[0]!.error).toBeUndefined()
    expect(settles[0]!.superseded).toBe(false)
    expect(settles[0]!.args).toBe(fires[0]) // reference identity — pairing key
    off()
  })

  it('under retry: settles ONCE with the final error, never per attempt', async () => {
    const settles: unknown[] = []
    const off = addInterceptor({
      onEventSettle: (_n, error) => settles.push(error),
    })
    let attempts = 0
    const flaky = event(
      'settle/flaky',
      async () => {
        attempts += 1
        throw new Error(`attempt ${attempts}`)
      },
      { retry: 2, retryDelay: 0 },
    )

    await flaky().catch(() => {})
    await tick()

    expect(attempts).toBe(3)
    expect(settles.length).toBe(1)
    expect((settles[0] as Error).message).toBe('attempt 3')
    off()
  })

  it('a switch-superseded run settles with superseded: true even if its handler completed', async () => {
    const settles: { args: unknown[]; superseded: boolean }[] = []
    const off = addInterceptor({
      onEventSettle: (_n, _e, args, superseded) => settles.push({ args, superseded }),
    })
    let release1!: () => void
    const gate1 = new Promise<void>(r => (release1 = r))
    const look = event(
      'settle/switch',
      async (key: string) => {
        if (key === 'a') await gate1
        return key
      },
      { concurrency: 'switch' },
    )

    const first = look('a')
    const second = look('b')
    release1()
    await Promise.allSettled([first, second])
    await tick()

    expect(settles.length).toBe(2)
    const byKey = new Map(settles.map(s => [s.args[0], s.superseded]))
    expect(byKey.get('a')).toBe(true) // superseded, though its handler finished
    expect(byKey.get('b')).toBe(false)
    off()
  })

  it('exhaust: a coalesced call neither re-fires nor re-settles — one pair per logical run', async () => {
    let fires = 0
    let settles = 0
    const off = addInterceptor({
      onEventFire: () => (fires += 1),
      onEventSettle: () => (settles += 1),
    })
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    const go = event('settle/exhaust', async () => gate, { concurrency: 'exhaust' })

    const p1 = go()
    const p2 = go() // coalesced
    release()
    await Promise.all([p1, p2])
    await tick()

    expect(fires).toBe(1)
    expect(settles).toBe(1)
    off()
  })

  it('streamEvents fire but never settle', async () => {
    let fires = 0
    let settles = 0
    const off = addInterceptor({
      onEventFire: () => (fires += 1),
      onEventSettle: () => (settles += 1),
    })
    const ping = streamEvent<number>('settle/ping')

    ping(1)
    await tick()

    expect(fires).toBe(1)
    expect(settles).toBe(0)
    off()
  })

  it('a throwing settle interceptor is contained — the caller and other interceptors are unaffected', async () => {
    const seen: string[] = []
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const off1 = addInterceptor({
      onEventSettle: () => {
        throw new Error('bad interceptor')
      },
    })
    const off2 = addInterceptor({ onEventSettle: name => seen.push(name) })
    const go = event('settle/contained', async () => 'ok')

    await expect(go()).resolves.toBe('ok')
    await tick()

    expect(seen).toEqual(['settle/contained'])
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
    off1()
    off2()
  })
})
