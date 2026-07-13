import { beforeEach, describe, expect, it, vi } from 'vitest'
import { atom, clearRegistry, hydrated, hydrationOf, resetAll } from '../src/atom'
import { asyncStorage, memoryStorage } from '../src/storage'
import { update } from '../src/update'

beforeEach(() => clearRegistry())

const envelope = (data: unknown, v = 1) => JSON.stringify({ v, data })

describe('persistence: sync storage (MMKV-style)', () => {
  it('hydrates synchronously at registration — no flash of initial state', () => {
    const storage = memoryStorage({ cart: envelope({ items: ['stored'], total: 5 }) })
    const cart$ = atom('cart', { items: [] as string[], total: 0 }, { persist: { storage } })

    expect(cart$.peek()).toEqual({ items: ['stored'], total: 5 })   // already hydrated
    expect(hydrationOf(cart$).peek()).toBe(true)
  })

  it('missing stored value: initial state, hydrated immediately', () => {
    const storage = memoryStorage()
    const cart$ = atom('cart', { total: 0 }, { persist: { storage } })
    expect(cart$.peek()).toEqual({ total: 0 })
    expect(hydrationOf(cart$).peek()).toBe(true)
  })

  it('writes through on every update, one write per batch', () => {
    const storage = memoryStorage()
    const cart$ = atom('cart', { items: [] as string[], total: 0 }, { persist: { storage } })
    const add = update('cart/add', { cart: cart$ }, (d, item: string) => {
      d.cart.items.push(item)
      d.cart.total += 1
    })

    add('apple')
    expect(JSON.parse(storage.data.get('cart')!)).toEqual({
      v: 1,
      data: { items: ['apple'], total: 1 },
    })
  })

  it('unpersisted atoms are always hydrated and never touch storage', () => {
    const session$ = atom('session', { active: false })
    expect(hydrationOf(session$).peek()).toBe(true)
  })

  it('resetAll persists the initial value', () => {
    const storage = memoryStorage({ cart: envelope({ total: 9 }) })
    const cart$ = atom('cart', { total: 0 }, { persist: { storage } })
    expect(cart$.total.peek()).toBe(9)

    resetAll()
    expect(cart$.total.peek()).toBe(0)
    expect(JSON.parse(storage.data.get('cart')!).data).toEqual({ total: 0 })
  })

  it('custom key overrides the atom name', () => {
    const storage = memoryStorage({ 'v2:cart': envelope({ total: 3 }) })
    const cart$ = atom('cart', { total: 0 }, { persist: { storage, key: 'v2:cart' } })
    expect(cart$.total.peek()).toBe(3)
  })
})

describe('persistence: migrations', () => {
  it('replays stepwise migrations from the stored version', () => {
    const storage = memoryStorage({ cart: envelope({ total: 10 }, 1) })
    const cart$ = atom('cart', { total: 0, coupon: null as string | null, currency: 'USD' }, {
      persist: {
        storage,
        version: 3,
        migrations: {
          2: (v1: any) => ({ ...v1, coupon: null }),
          3: (v2: any) => ({ ...v2, currency: 'USD' }),
        },
      },
    })
    expect(cart$.peek()).toEqual({ total: 10, coupon: null, currency: 'USD' })
  })

  it('data already at the current version runs no migrations', () => {
    const migrate = vi.fn()
    const storage = memoryStorage({ cart: envelope({ total: 1 }, 2) })
    atom('cart', { total: 0 }, {
      persist: { storage, version: 2, migrations: { 2: (d: any) => { migrate(); return d } } },
    })
    expect(migrate).not.toHaveBeenCalled()
  })

  it('subsequent writes are stamped with the current version', () => {
    const storage = memoryStorage({ cart: envelope({ total: 10 }, 1) })
    const cart$ = atom('cart', { total: 0 }, {
      persist: { storage, version: 2, migrations: { 2: (d: any) => d } },
    })
    const bump = update('cart/bump', { cart: cart$ }, d => { d.cart.total += 1 })
    bump()
    expect(JSON.parse(storage.data.get('cart')!).v).toBe(2)
  })
})

describe('persistence: async storage', () => {
  it('starts at initial, flips hydration when the read resolves', async () => {
    const storage = asyncStorage(memoryStorage({ cart: envelope({ total: 42 }) }))
    const cart$ = atom('cart', { total: 0 }, { persist: { storage } })

    expect(cart$.total.peek()).toBe(0)                 // not yet hydrated
    expect(hydrationOf(cart$).peek()).toBe(false)

    await hydrated()                                   // the PersistGate replacement
    expect(cart$.total.peek()).toBe(42)
    expect(hydrationOf(cart$).peek()).toBe(true)
  })

  it('hydrated() aggregates multiple persisted atoms', async () => {
    const s = memoryStorage({ a: envelope({ v: 1 }), b: envelope({ v: 2 }) })
    const a$ = atom('a', { v: 0 }, { persist: { storage: asyncStorage(s) } })
    const b$ = atom('b', { v: 0 }, { persist: { storage: asyncStorage(s) } })
    await hydrated()
    expect(a$.v.peek()).toBe(1)
    expect(b$.v.peek()).toBe(2)
  })
})

describe('persistence: failure modes', () => {
  it('corrupted JSON: keeps initial state, still reports hydrated', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const storage = memoryStorage({ cart: '{not json' })
    const cart$ = atom('cart', { total: 0 }, { persist: { storage } })

    expect(cart$.total.peek()).toBe(0)
    expect(hydrationOf(cart$).peek()).toBe(true)       // app is not blocked
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('hydrate'), expect.anything())
    spy.mockRestore()
  })

  it('async read rejection: initial state, hydrated, error logged', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const storage = {
      getString: () => Promise.reject(new Error('disk gone')),
      setString: () => {},
      remove: () => {},
    }
    const cart$ = atom('cart', { total: 0 }, { persist: { storage } })
    await hydrated()
    expect(cart$.total.peek()).toBe(0)
    expect(hydrationOf(cart$).peek()).toBe(true)
    spy.mockRestore()
  })
})
