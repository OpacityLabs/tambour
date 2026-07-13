import { describe, expect, it, vi } from 'vitest'
import { observable, batch } from '@legendapp/state'
import { combineLatest, Observable, Subject } from 'rxjs'
import { map } from 'rxjs/operators'
import { streamSelector } from '../src/streamSelector'
import { atomToStream } from '../src/bridges'

describe('streamSelector: lazy activation', () => {
  it('does not subscribe to the pipeline until first observed', () => {
    const source = new Subject<number>()
    const subscribed = vi.fn()
    const wrapped = new Observable<number>(sub => {
      subscribed()
      const s = source.subscribe(sub)
      return () => s.unsubscribe()
    })

    const node$ = streamSelector<number>(wrapped)
    expect(subscribed).not.toHaveBeenCalled()   // nothing observed yet

    const listener = vi.fn()
    node$.onChange(listener)                    // first observation
    node$.get()
    expect(subscribed).toHaveBeenCalledTimes(1)

    source.next(42)
    expect(node$.peek()).toBe(42)
  })

  it('default value is present before first emission', () => {
    const source = new Subject<number[]>()
    const node$ = streamSelector(source.asObservable(), { default: [] as number[] })
    expect(node$.get()).toEqual([])
    source.next([1, 2])
    expect(node$.peek()).toEqual([1, 2])
  })

  it('re-activates cleanly: observe -> dispose -> observe again', async () => {
    const source = new Subject<number>()
    let activations = 0
    const wrapped = new Observable<number>(sub => {
      activations++
      const s = source.subscribe(sub)
      return () => s.unsubscribe()
    })
    const node$ = streamSelector<number>(wrapped)

    const d1 = node$.onChange(() => {})
    node$.get()
    expect(activations).toBe(1)
    source.next(1)
    expect(node$.peek()).toBe(1)

    d1()                                          // last observer leaves
    await new Promise(r => setTimeout(r, 10))     // legend deactivation is async

    const d2 = node$.onChange(() => {})           // observe again
    node$.get()
    await new Promise(r => setTimeout(r, 10))     // re-subscription is ALSO async —
    source.next(2)                                // emissions during the gap are missed
    expect(node$.peek()).toBe(2)                  // values flow after re-activation
    expect(activations).toBe(2)                   // pipeline genuinely re-subscribed
    d2()
  })

  it('holds last value if the pipeline errors', () => {
    const source = new Subject<number>()
    const node$ = streamSelector(source.asObservable())
    node$.get()
    source.next(7)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    source.error(new Error('boom'))
    spy.mockRestore()
    expect(node$.peek()).toBe(7)
  })
})

describe('the glitch rule: combine in space with Legend, in time with Rx', () => {
  it('demonstrates that combineLatest over two atomToStreams glitches on a batch write', () => {
    const a$ = observable(1) as any
    const b$ = observable(10) as any

    const emissions: number[] = []
    const sub = combineLatest([atomToStream<number>(a$), atomToStream<number>(b$)])
      .pipe(map(([a, b]) => a + b))
      .subscribe(v => emissions.push(v))

    batch(() => { a$.set(2); b$.set(20) })
    sub.unsubscribe()

    // initial emission [1,10]=11, then... does the batch produce one emission (22)
    // or a torn intermediate (12 or 21) plus 22? This test DOCUMENTS the behavior.
    console.log('[glitch probe] emissions:', emissions)
    expect(emissions[0]).toBe(11)
    expect(emissions[emissions.length - 1]).toBe(22)
  })

  it('a sync Legend computed over both atoms is glitch-free by batching', () => {
    const a$ = observable(1) as any
    const b$ = observable(10) as any
    const sum$ = observable(() => a$.get() + b$.get()) as any

    const values: number[] = []
    sum$.onChange(({ value }: any) => values.push(value))
    sum$.get()

    batch(() => { a$.set(2); b$.set(20) })
    console.log('[computed probe] notifications:', values)
    expect(values).toEqual([22])   // exactly one notification, no torn value
  })
})
