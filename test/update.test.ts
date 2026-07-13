import { describe, expect, it, vi } from 'vitest'
import { observable } from '@legendapp/state'
import { addInterceptor } from '../src/interceptors'
import { update } from '../src/update'

describe('update: multi-atom transitions', () => {
  it('routes patches to the right atoms, atomically', () => {
    const cart$ = observable({ items: ['x'], total: 10 }) as any
    const orders$ = observable({ list: [] as string[] }) as any

    const checkout = update('checkout/complete', { cart: cart$, orders: orders$ },
      (d, orderId: string) => {
        d.orders.list.push(orderId)
        d.cart.items = []
        d.cart.total = 0
      })

    checkout('order-1')
    expect(cart$.peek()).toEqual({ items: [], total: 0 })
    expect(orders$.peek()).toEqual({ list: ['order-1'] })
  })

  it('subscribers see one notification per update, not one per set', () => {
    const a$ = observable({ x: 0, y: 0 }) as any
    const listener = vi.fn()
    a$.onChange(listener)

    const setBoth = update('test/setBoth', { a: a$ }, d => { d.a.x = 1; d.a.y = 2 })
    setBoth()
    expect(a$.peek()).toEqual({ x: 1, y: 2 })
    expect(listener).toHaveBeenCalledTimes(1)   // batched
  })

  it('a throwing recipe leaves all atoms untouched', () => {
    const a$ = observable({ v: 1 }) as any
    const b$ = observable({ v: 2 }) as any
    const bad = update('test/bad', { a: a$, b: b$ }, d => {
      d.a.v = 99
      d.b.v = 99
      throw new Error('nope')
    })
    expect(() => bad()).toThrow('nope')
    expect(a$.peek()).toEqual({ v: 1 })
    expect(b$.peek()).toEqual({ v: 2 })
  })

  it('interceptors receive name, args, scope, patches, inverse', () => {
    const a$ = observable({ v: 1 }) as any
    const seen: any[] = []
    const off = addInterceptor({ after: r => seen.push(r) })
    const setV = update('test/setV', { a: a$ }, (d, v: number) => { d.a.v = v })
    setV(42)
    off()
    expect(seen).toHaveLength(1)
    expect(seen[0].name).toBe('test/setV')
    expect(seen[0].args).toEqual([42])
    expect(seen[0].scope).toEqual(['a'])
    expect(seen[0].patches.length).toBeGreaterThan(0)
    expect(seen[0].inverse.length).toBeGreaterThan(0)
  })
})

describe('update: base cache', () => {
  it('consecutive updates see each other (cache-hit path)', () => {
    const a$ = observable({ list: [1] }) as any
    const push = update('t/push', { a: a$ }, (d, v: number) => { d.a.list.push(v) })
    push(2)
    push(3)
    expect(a$.peek()).toEqual({ list: [1, 2, 3] })
  })

  it('a foreign direct set between updates invalidates the cache', () => {
    const a$ = observable({ v: 1, other: 'x' }) as any
    const bump = update('t/bump', { a: a$ }, d => { d.a.v += 1 })
    bump()                       // cache now holds { v: 2, other: 'x' }
    a$.v.set(100)                // foreign write — must not be masked by the cache
    bump()
    expect(a$.v.peek()).toBe(101)
  })

  it('a foreign whole-atom set between updates invalidates the cache', () => {
    const a$ = observable({ v: 1 }) as any
    const bump = update('t/bump2', { a: a$ }, d => { d.a.v += 1 })
    bump()
    a$.set({ v: 50 })
    bump()
    expect(a$.v.peek()).toBe(51)
  })

  it('two different updates on the same atom share the cache correctly', () => {
    const a$ = observable({ v: 0, w: 0 }) as any
    const bumpV = update('t/bumpV', { a: a$ }, d => { d.a.v += 1 })
    const bumpW = update('t/bumpW', { a: a$ }, d => { d.a.w += 1 })
    bumpV(); bumpW(); bumpV(); bumpW()
    expect(a$.peek()).toEqual({ v: 2, w: 2 })
  })

  it('read-scope atoms also read through the cache without corruption', () => {
    const cart$ = observable({ total: 10 }) as any
    const settings$ = observable({ rate: 0.5 }) as any
    const applyRate = update('t/rate', { writes: { cart: cart$ }, reads: { settings: settings$ } },
      d => { d.cart.total = d.cart.total * (1 + d.settings.rate) })
    applyRate()
    settings$.rate.set(1.0)      // foreign write to a read atom
    applyRate()
    expect(cart$.total.peek()).toBe(30)   // 10*1.5=15, then 15*2=30 — saw the new rate
  })
})

describe('update: surgical notification (the fine-grained promise)', () => {
  it('an untouched leaf does NOT notify when a sibling changes', () => {
    const cart$ = observable({
      items: [{ id: 'a', qty: 1 }, { id: 'b', qty: 2 }],
      total: 10,
    }) as any

    const totalListener = vi.fn()
    const itemAListener = vi.fn()
    const itemBListener = vi.fn()
    cart$.total.onChange(totalListener)
    cart$.items[0].qty.onChange(itemAListener)
    cart$.items[1].qty.onChange(itemBListener)

    const bumpB = update('cart/bumpB', { cart: cart$ }, d => { d.cart.items[1].qty += 1 })
    bumpB()

    expect(itemBListener).toHaveBeenCalledTimes(1)
    expect(itemAListener).not.toHaveBeenCalled()      // sibling leaf untouched
    expect(totalListener).not.toHaveBeenCalled()      // sibling key untouched
  })
})
