import { beforeEach, describe, expect, it, vi } from 'vitest'
import { atom, clearRegistry, hydrated, hydrationOf, hydrationRecords, resetAll } from '../src/atom'
import { addInterceptor, type HydrationRecord } from '../src/interceptors'
import { asyncStorage, memoryStorage } from '../src/storage'
import { update } from '../src/update'

beforeEach(() => clearRegistry())

const envelope = (data: unknown, v = 1) => JSON.stringify({ v, data })

describe('persistence: sync storage (MMKV-style)', () => {
  it('hydrates synchronously at registration — no flash of initial state', () => {
    const storage = memoryStorage({ cart: envelope({ items: ['stored'], total: 5 }) })
    const cart = atom('cart', { items: [] as string[], total: 0 }, { persist: { storage } })

    expect(cart.peek()).toEqual({ items: ['stored'], total: 5 })   // already hydrated
    expect(hydrationOf(cart).peek()).toBe(true)
  })

  it('missing stored value: initial state, hydrated immediately', () => {
    const storage = memoryStorage()
    const cart = atom('cart', { total: 0 }, { persist: { storage } })
    expect(cart.peek()).toEqual({ total: 0 })
    expect(hydrationOf(cart).peek()).toBe(true)
  })

  it('missing stored value: materializes the initial value to storage immediately', () => {
    // Migration durability: an atom seeded from a legacy source must not wait
    // for its first write to own its storage key — the legacy source may be
    // destroyed in the meantime.
    const storage = memoryStorage()
    atom('cart', { total: 7, fromLegacy: true }, { persist: { storage } })
    expect(JSON.parse(storage.data.get('cart')!)).toEqual({
      v: 1,
      data: { total: 7, fromLegacy: true },
    })
  })

  it('writes through on every update, one write per batch', () => {
    const storage = memoryStorage()
    const cart = atom('cart', { items: [] as string[], total: 0 }, { persist: { storage } })
    const add = update('cart/add', { cart: cart }, (d, item: string) => {
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
    const session = atom('session', { active: false })
    expect(hydrationOf(session).peek()).toBe(true)
  })

  it('resetAll persists the initial value', () => {
    const storage = memoryStorage({ cart: envelope({ total: 9 }) })
    const cart = atom('cart', { total: 0 }, { persist: { storage } })
    expect(cart.total.peek()).toBe(9)

    resetAll()
    expect(cart.total.peek()).toBe(0)
    expect(JSON.parse(storage.data.get('cart')!).data).toEqual({ total: 0 })
  })

  it('custom key overrides the atom name', () => {
    const storage = memoryStorage({ 'v2:cart': envelope({ total: 3 }) })
    const cart = atom('cart', { total: 0 }, { persist: { storage, key: 'v2:cart' } })
    expect(cart.total.peek()).toBe(3)
  })
})

describe('persistence: migrations', () => {
  it('replays stepwise migrations from the stored version', () => {
    const storage = memoryStorage({ cart: envelope({ total: 10 }, 1) })
    const cart = atom('cart', { total: 0, coupon: null as string | null, currency: 'USD' }, {
      persist: {
        storage,
        version: 3,
        migrations: {
          2: (v1: any) => ({ ...v1, coupon: null }),
          3: (v2: any) => ({ ...v2, currency: 'USD' }),
        },
      },
    })
    expect(cart.peek()).toEqual({ total: 10, coupon: null, currency: 'USD' })
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
    const cart = atom('cart', { total: 0 }, {
      persist: { storage, version: 2, migrations: { 2: (d: any) => d } },
    })
    const bump = update('cart/bump', { cart: cart }, d => { d.cart.total += 1 })
    bump()
    expect(JSON.parse(storage.data.get('cart')!).v).toBe(2)
  })
})

describe('persistence: throttled write-through', () => {
  it('first change after a quiet period writes immediately (leading edge)', () => {
    vi.useFakeTimers()
    const storage = memoryStorage()
    const cart = atom('cart', { total: 0 }, { persist: { storage, throttleMs: 500 } })
    const bump = update('cart/bump', { cart: cart }, d => { d.cart.total += 1 })

    bump()
    expect(JSON.parse(storage.data.get('cart')!).data).toEqual({ total: 1 })
    vi.useRealTimers()
  })

  it('a burst coalesces into one trailing write of the latest value', () => {
    vi.useFakeTimers()
    const storage = memoryStorage()
    const setString = vi.spyOn(storage, 'setString')
    const cart = atom('cart', { total: 0 }, { persist: { storage, throttleMs: 500 } })
    const bump = update('cart/bump', { cart: cart }, d => { d.cart.total += 1 })
    setString.mockClear()               // ignore the initial materialization write

    bump()                              // leading
    bump()                              // window opens — held
    bump()                              // still held; latest value advances
    expect(setString).toHaveBeenCalledTimes(1)
    expect(JSON.parse(storage.data.get('cart')!).data).toEqual({ total: 1 })

    vi.advanceTimersByTime(500)         // trailing write fires with the latest
    expect(setString).toHaveBeenCalledTimes(2)
    expect(JSON.parse(storage.data.get('cart')!).data).toEqual({ total: 3 })
    vi.useRealTimers()
  })

  it('after the window passes quietly, the next change is leading again', () => {
    vi.useFakeTimers()
    const storage = memoryStorage()
    const cart = atom('cart', { total: 0 }, { persist: { storage, throttleMs: 500 } })
    const bump = update('cart/bump', { cart: cart }, d => { d.cart.total += 1 })

    bump()
    vi.advanceTimersByTime(600)
    bump()
    expect(JSON.parse(storage.data.get('cart')!).data).toEqual({ total: 2 })
    vi.useRealTimers()
  })

  it('hydration never counts as a change to throttle or write back', () => {
    vi.useFakeTimers()
    const storage = memoryStorage({ cart: envelope({ total: 9 }) })
    const setString = vi.spyOn(storage, 'setString')
    atom('cart', { total: 0 }, { persist: { storage, throttleMs: 500 } })
    vi.advanceTimersByTime(1000)
    expect(setString).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})

describe('persistence: async storage', () => {
  it('starts at initial, flips hydration when the read resolves', async () => {
    const storage = asyncStorage(memoryStorage({ cart: envelope({ total: 42 }) }))
    const cart = atom('cart', { total: 0 }, { persist: { storage } })

    expect(cart.total.peek()).toBe(0)                 // not yet hydrated
    expect(hydrationOf(cart).peek()).toBe(false)

    await hydrated()                                   // the PersistGate replacement
    expect(cart.total.peek()).toBe(42)
    expect(hydrationOf(cart).peek()).toBe(true)
  })

  it('hydrated() aggregates multiple persisted atoms', async () => {
    const s = memoryStorage({ a: envelope({ v: 1 }), b: envelope({ v: 2 }) })
    const a = atom('a', { v: 0 }, { persist: { storage: asyncStorage(s) } })
    const b = atom('b', { v: 0 }, { persist: { storage: asyncStorage(s) } })
    await hydrated()
    expect(a.v.peek()).toBe(1)
    expect(b.v.peek()).toBe(2)
  })
})

describe('persistence: failure modes', () => {
  it('corrupted JSON: keeps initial state, still reports hydrated', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const storage = memoryStorage({ cart: '{not json' })
    const cart = atom('cart', { total: 0 }, { persist: { storage } })

    expect(cart.total.peek()).toBe(0)
    expect(hydrationOf(cart).peek()).toBe(true)       // app is not blocked
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
    const cart = atom('cart', { total: 0 }, { persist: { storage } })
    await hydrated()
    expect(cart.total.peek()).toBe(0)
    expect(hydrationOf(cart).peek()).toBe(true)
    spy.mockRestore()
  })
})

describe('persistence: hydration records + onHydrate', () => {
  it('sync storage: onHydrate fires during atom(), record readable after', () => {
    const records: HydrationRecord[] = []
    const dispose = addInterceptor({ onHydrate: r => records.push(r) })
    const storage = memoryStorage({ cart: envelope({ total: 5 }) })
    atom('cart', { total: 0 }, { persist: { storage } })
    dispose()

    expect(records).toEqual([{ atomName: 'cart', source: 'storage', fromVersion: 1, toVersion: 1 }])
    expect(hydrationRecords()).toEqual(records)
  })

  it('migration replay records the version span', () => {
    const records: HydrationRecord[] = []
    const dispose = addInterceptor({ onHydrate: r => records.push(r) })
    const storage = memoryStorage({ cart: envelope({ total: 10 }, 1) })
    atom('cart', { total: 0, coupon: null as string | null }, {
      persist: { storage, version: 3, migrations: { 2: (d: any) => ({ ...d, coupon: null }), 3: (d: any) => d } },
    })
    dispose()
    expect(records).toEqual([{ atomName: 'cart', source: 'storage', fromVersion: 1, toVersion: 3 }])
  })

  it('virgin key records source initial', () => {
    const records: HydrationRecord[] = []
    const dispose = addInterceptor({ onHydrate: r => records.push(r) })
    atom('cart', { total: 0 }, { persist: { storage: memoryStorage() } })
    dispose()
    expect(records).toEqual([{ atomName: 'cart', source: 'initial' }])
  })

  it('corrupted JSON records the error; the atom kept its initial', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const records: HydrationRecord[] = []
    const dispose = addInterceptor({ onHydrate: r => records.push(r) })
    atom('cart', { total: 0 }, { persist: { storage: memoryStorage({ cart: '{not json' }) } })
    dispose()
    spy.mockRestore()
    expect(records[0]).toMatchObject({ atomName: 'cart', source: 'initial' })
    expect(records[0]!.error).toBeInstanceOf(SyntaxError)
  })

  it('async storage: no record until the read settles, then the hook fires', async () => {
    const records: HydrationRecord[] = []
    const dispose = addInterceptor({ onHydrate: r => records.push(r) })
    const storage = asyncStorage(memoryStorage({ cart: envelope({ total: 42 }) }))
    atom('cart', { total: 0 }, { persist: { storage } })

    expect(records).toEqual([])
    expect(hydrationRecords()).toEqual([])            // read still in flight

    await hydrated()
    dispose()
    expect(records).toEqual([{ atomName: 'cart', source: 'storage', fromVersion: 1, toVersion: 1 }])
    expect(hydrationRecords()).toEqual(records)
  })

  it('async read rejection records the error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const records: HydrationRecord[] = []
    const dispose = addInterceptor({ onHydrate: r => records.push(r) })
    const storage = {
      getString: () => Promise.reject(new Error('disk gone')),
      setString: () => {},
      remove: () => {},
    }
    atom('cart', { total: 0 }, { persist: { storage } })
    await hydrated()
    dispose()
    spy.mockRestore()
    expect(records[0]).toMatchObject({ atomName: 'cart', source: 'initial' })
    expect((records[0]!.error as Error).message).toBe('disk gone')
  })

  it('a throwing onHydrate interceptor is contained — hydration completes', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const dispose = addInterceptor({ onHydrate: () => { throw new Error('boom') } })
    const storage = memoryStorage({ cart: envelope({ total: 5 }) })
    const cart = atom('cart', { total: 0 }, { persist: { storage } })
    dispose()
    expect(cart.total.peek()).toBe(5)
    expect(hydrationOf(cart).peek()).toBe(true)
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('onHydrate'), expect.anything())
    spy.mockRestore()
  })

  it('unpersisted atoms produce no records', () => {
    atom('session', { active: false })
    expect(hydrationRecords()).toEqual([])
  })
})
