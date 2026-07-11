import { describe, expect, it, vi } from 'vitest'
import { observable } from '@legendapp/state'
import { addAfterInterceptor, update } from '../src/update'

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
    const off = addAfterInterceptor(r => seen.push(r))
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
