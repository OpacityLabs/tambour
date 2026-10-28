import { describe, expect, it, vi } from 'vitest'
import { batch, observable, type Observable } from '@legendapp/state'
import { addInterceptor, type UpdateRecord } from '../src/interceptors'
import { reaction } from '../src/reaction'
import { update } from '../src/update'

describe('update: multi-atom transitions', () => {
  it('routes patches to the right atoms, atomically', () => {
    const cart = observable({ items: ['x'], total: 10 }) as any
    const orders = observable({ list: [] as string[] }) as any

    const checkout = update('checkout/complete', { cart: cart, orders: orders },
      (d, orderId: string) => {
        d.orders.list.push(orderId)
        d.cart.items = []
        d.cart.total = 0
      })

    checkout('order-1')
    expect(cart.peek()).toEqual({ items: [], total: 0 })
    expect(orders.peek()).toEqual({ list: ['order-1'] })
  })

  it('subscribers see one notification per update, not one per set', () => {
    const a = observable({ x: 0, y: 0 }) as any
    const listener = vi.fn()
    a.onChange(listener)

    const setBoth = update('test/setBoth', { a: a }, d => { d.a.x = 1; d.a.y = 2 })
    setBoth()
    expect(a.peek()).toEqual({ x: 1, y: 2 })
    expect(listener).toHaveBeenCalledTimes(1)   // batched
  })

  it('a throwing recipe leaves all atoms untouched', () => {
    const a = observable({ v: 1 }) as any
    const b = observable({ v: 2 }) as any
    const bad = update('test/bad', { a: a, b: b }, d => {
      d.a.v = 99
      d.b.v = 99
      throw new Error('nope')
    })
    expect(() => bad()).toThrow('nope')
    expect(a.peek()).toEqual({ v: 1 })
    expect(b.peek()).toEqual({ v: 2 })
  })

  it('interceptors receive name, args, scope, patches, inverse', () => {
    const a = observable({ v: 1 }) as any
    const seen: any[] = []
    const off = addInterceptor({ after: r => seen.push(r) })
    const setV = update('test/setV', { a: a }, (d, v: number) => { d.a.v = v })
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
    const a = observable({ list: [1] }) as any
    const push = update('t/push', { a: a }, (d, v: number) => { d.a.list.push(v) })
    push(2)
    push(3)
    expect(a.peek()).toEqual({ list: [1, 2, 3] })
  })

  it('a foreign direct set between updates invalidates the cache', () => {
    const a = observable({ v: 1, other: 'x' }) as any
    const bump = update('t/bump', { a: a }, d => { d.a.v += 1 })
    bump()                       // cache now holds { v: 2, other: 'x' }
    a.v.set(100)                // foreign write — must not be masked by the cache
    bump()
    expect(a.v.peek()).toBe(101)
  })

  it('a foreign whole-atom set between updates invalidates the cache', () => {
    const a = observable({ v: 1 }) as any
    const bump = update('t/bump2', { a: a }, d => { d.a.v += 1 })
    bump()
    a.set({ v: 50 })
    bump()
    expect(a.v.peek()).toBe(51)
  })

  it('two different updates on the same atom share the cache correctly', () => {
    const a = observable({ v: 0, w: 0 }) as any
    const bumpV = update('t/bumpV', { a: a }, d => { d.a.v += 1 })
    const bumpW = update('t/bumpW', { a: a }, d => { d.a.w += 1 })
    bumpV(); bumpW(); bumpV(); bumpW()
    expect(a.peek()).toEqual({ v: 2, w: 2 })
  })

  it('read-scope atoms also read through the cache without corruption', () => {
    const cart = observable({ total: 10 }) as any
    const settings = observable({ rate: 0.5 }) as any
    const applyRate = update('t/rate', { writes: { cart: cart }, reads: { settings: settings } },
      d => { d.cart.total = d.cart.total * (1 + d.settings.rate) })
    applyRate()
    settings.rate.set(1.0)      // foreign write to a read atom
    applyRate()
    expect(cart.total.peek()).toBe(30)   // 10*1.5=15, then 15*2=30 — saw the new rate
  })

  // Re-entrant writes: the batch flush runs reactions that write the same atom
  // BEFORE the outer update re-validates — its own `next` lacks those writes.
  it('a reaction-driven update during the flush survives the outer update', () => {
    const s = observable({ items: [] as string[], log: [] as string[] })
    const add = update('t/add', { s: s }, (d, v: string) => { d.s.items.push(v) })
    const logIt = update('t/log', { s: s }, (d, msg: string) => { d.s.log.push(msg) })
    const off = reaction('t/logLen', s.items, items => logIt(`len=${items.length}`))
    add('a')
    add('b')
    off()
    expect(s.log.peek()).toEqual(['len=1', 'len=2'])
  })

  it('a direct set from a reaction during the flush composes with the next update', () => {
    const s = observable({ n: 0, derived: 0 })
    const bumpN = update('t/bumpN', { s: s }, d => { d.s.n += 1 })
    const incDerived = update('t/incDerived', { s: s }, d => { d.s.derived += 1 })
    const off = reaction('t/derive', s.n, () => { s.derived.set(s.derived.peek() + 10) })
    bumpN()                      // the reaction lands derived=10 inside bumpN's flush
    incDerived()
    off()
    expect(s.derived.peek()).toBe(11)
  })

  // Batched foreign writes: the invalidating bump must land with the write,
  // not at the enclosing batch's flush.
  it('a foreign write earlier in the same batch is not masked by the cache', () => {
    const s = observable({ items: ['x'] })
    const add = update('t/addBatched', { s: s }, (d, v: string) => { d.s.items.push(v) })
    add('warm')                  // cache now valid
    batch(() => {
      s.items.push('foreign')
      add('mine')
    })
    expect(s.items.peek()).toEqual(['x', 'warm', 'foreign', 'mine'])
  })

  it('undo after a foreign write in the same batch keeps the foreign write', () => {
    const s = observable({ items: ['a', 'b'] })
    const remove = update('t/remove', { s: s }, (d, v: string) => {
      d.s.items.splice(d.s.items.indexOf(v), 1)
    })
    const undo = remove('a')     // cache valid at ['b']; the inverse re-inserts 'a'
    batch(() => {
      s.items.push('foreign')
      undo()
    })
    expect(s.items.peek()).toEqual(['a', 'b', 'foreign'])
  })

  it('a multi-op array write on a cold (peeked) base applies each op once', () => {
    const a = observable({ list: [1] })
    const pushTwo = update('t/pushTwo', { a: a }, d => { d.a.list.push(2, 3) })
    pushTwo()                    // no cache yet: the base IS Legend's raw state
    expect(a.list.peek()).toEqual([1, 2, 3])
  })
})

describe('update: surgical notification (the fine-grained promise)', () => {
  it('an untouched leaf does NOT notify when a sibling changes', () => {
    const cart = observable({
      items: [{ id: 'a', qty: 1 }, { id: 'b', qty: 2 }],
      total: 10,
    }) as any

    const totalListener = vi.fn()
    const itemAListener = vi.fn()
    const itemBListener = vi.fn()
    cart.total.onChange(totalListener)
    cart.items[0].qty.onChange(itemAListener)
    cart.items[1].qty.onChange(itemBListener)

    const bumpB = update('cart/bumpB', { cart: cart }, d => { d.cart.items[1].qty += 1 })
    bumpB()

    expect(itemBListener).toHaveBeenCalledTimes(1)
    expect(itemAListener).not.toHaveBeenCalled()      // sibling leaf untouched
    expect(totalListener).not.toHaveBeenCalled()      // sibling key untouched
  })
})

describe('update: the returned Undo thunk', () => {
  it('restores exactly the touched leaves, across every atom in scope', () => {
    const cart = observable({ items: ['x'], total: 10 }) as any
    const orders = observable({ list: [] as string[] }) as any

    const checkout = update('undo/checkout', { cart: cart, orders: orders }, d => {
      d.orders.list.push('order-1')
      d.cart.items = []
      d.cart.total = 0
    })

    const undo = checkout()
    expect(cart.peek()).toEqual({ items: [], total: 0 })

    // the rollback is one batch across BOTH atoms, like the forward write
    const cartListener = vi.fn()
    const ordersListener = vi.fn()
    cart.onChange(cartListener)
    orders.onChange(ordersListener)

    undo()
    expect(cart.peek()).toEqual({ items: ['x'], total: 10 })
    expect(orders.peek()).toEqual({ list: [] })
    expect(cartListener).toHaveBeenCalledTimes(1)   // two leaves restored, one notification
    expect(ordersListener).toHaveBeenCalledTimes(1)
  })

  it('later writes to OTHER leaves survive the rollback (vs snapshot-restore)', () => {
    const a = observable({ x: 0, y: 0 }) as any
    const setX = update('undo/setX', { a: a }, (d, v: number) => { d.a.x = v })
    const setY = update('undo/setY', { a: a }, (d, v: number) => { d.a.y = v })

    const undo = setX(1)   // optimistic write
    setY(50)               // a DIFFERENT leaf changes during the request window

    undo()                 // rollback the optimistic write only
    expect(a.peek()).toEqual({ x: 0, y: 50 }) // x restored, y survives
  })

  it('is one-shot: the second call is a warning no-op, not a double-remove', () => {
    const list = observable({ items: ['a', 'b'] }) as any
    const push = update('undo/push', { l: list }, (d, v: string) => { d.l.items.push(v) })

    const undo = push('c')
    expect(list.items.peek()).toEqual(['a', 'b', 'c'])

    undo()
    expect(list.items.peek()).toEqual(['a', 'b']) // insert undone by remove

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    undo() // spent — must NOT remove 'b'
    expect(list.items.peek()).toEqual(['a', 'b'])
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('lands on the timeline as a named write: <name>.undo, patches/inverse swapped', () => {
    const a = observable({ v: 1 }) as any
    const seen: any[] = []
    const off = addInterceptor({ after: r => seen.push(r) })

    const setV = update('undo/setV', { a: a }, (d, v: number) => { d.a.v = v })
    const undo = setV(42)
    undo()
    off()

    expect(seen.map(r => r.name)).toEqual(['undo/setV', 'undo/setV.undo'])
    expect(seen[1].scope).toEqual(['a'])
    expect(seen[1].patches).toEqual(seen[0].inverse) // the rollback's forward ops
    expect(seen[1].inverse).toEqual(seen[0].patches) // …and its redo
  })

  it('a before-interceptor veto aborts the rollback cleanly and leaves the thunk live', () => {
    const a = observable({ v: 1 }) as any
    const setV = update('undo/veto', { a: a }, (d, v: number) => { d.a.v = v })
    const undo = setV(2)

    const off = addInterceptor({
      before: name => { if (name.endsWith('.undo')) throw new Error('vetoed') },
    })
    expect(() => undo()).toThrow('vetoed')
    expect(a.peek()).toEqual({ v: 2 }) // untouched
    off()

    undo() // veto never spent the thunk
    expect(a.peek()).toEqual({ v: 1 })
  })

  it('an update that changed nothing returns a silent no-op undo', () => {
    const a = observable({ v: 1 }) as any
    const seen: any[] = []
    const noop = update('undo/noop', { a: a }, () => {})

    const undo = noop()
    const off = addInterceptor({ after: r => seen.push(r) })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    undo()
    off()
    warn.mockRestore()

    expect(seen).toEqual([]) // no timeline noise
    expect(a.peek()).toEqual({ v: 1 })
  })

  // Immer emits array splices/reorders as POSITIONAL ops. Applied as-is
  // against current state they overwrite whatever item now sits at each
  // index — undo must work by item identity instead.
  describe('array undo by item identity', () => {
    type Todo = { id: string; done: boolean }
    type TodoState = { items: Todo[] }
    const todos = (): Observable<TodoState> => observable<TodoState>({ items: [
      { id: 'a', done: false }, { id: 'b', done: false }, { id: 'c', done: false },
    ] })
    const ops = (s: Observable<TodoState>) => ({
      removeAt: update('ids/removeAt', { s }, (d, i: number) => { d.s.items.splice(i, 1) }),
      removeId: update('ids/removeId', { s }, (d, id: string) => {
        d.s.items = d.s.items.filter((t: Todo) => t.id !== id)
      }),
      toggle: update('ids/toggle', { s }, (d, id: string) => {
        const t = d.s.items.find((t: Todo) => t.id === id)
        t.done = !t.done
      }),
      add: update('ids/add', { s }, (d, id: string) => { d.s.items.push({ id, done: false }) }),
      sortDesc: update('ids/sort', { s }, d => {
        d.s.items.sort((x: Todo, y: Todo) => y.id.localeCompare(x.id))
      }),
    })

    it('undoing a splice keeps a later edit to another item', () => {
      const s = todos()
      const { removeAt, toggle } = ops(s)
      const undo = removeAt(0)
      toggle('c')
      undo()
      expect(s.items.peek()).toEqual([
        { id: 'a', done: false }, { id: 'b', done: false }, { id: 'c', done: true },
      ])
    })

    it('overlapping removes: undoing the first keeps the second', () => {
      const s = todos()
      const { removeAt, removeId } = ops(s)
      const undo = removeAt(0)  // a
      removeId('b')             // a later optimistic remove that succeeds
      undo()
      expect(s.items.peek().map(t => t.id)).toEqual(['a', 'c'])
    })

    it('undoing a reorder keeps a later insert and edit', () => {
      const s = todos()
      const { sortDesc, add } = ops(s)
      const markDone = update('ids/markDone', { s }, (d, i: number) => {
        d.s.items[i] = { ...d.s.items[i], done: true }
      })
      const undo = sortDesc()   // c, b, a
      markDone(2)               // a — a slot the positional inverse rewrites
      add('d')
      undo()
      expect(s.items.peek()).toEqual([
        { id: 'a', done: true }, { id: 'b', done: false }, { id: 'c', done: false }, { id: 'd', done: false },
      ])
    })

    it('a leaf undo follows its item after a later splice', () => {
      const s = todos()
      const { removeAt, toggle } = ops(s)
      const undo = toggle('c')  // recorded at items[2]
      removeAt(0)               // c now sits at items[1]
      undo()
      expect(s.items.peek()).toEqual([{ id: 'b', done: false }, { id: 'c', done: false }])
    })

    it('without ids: a splice undo keeps later edits by position when the length is unchanged', () => {
      const s = observable({ items: [{ n: 1 }, { n: 2 }, { n: 3 }] })
      const removeAt = update('pos/removeAt', { s }, (d, i: number) => { d.s.items.splice(i, 1) })
      const bump = update('pos/bump', { s }, (d, i: number) => { d.s.items[i].n += 10 })
      const undo = removeAt(0)  // [2, 3]
      bump(1)                   // [2, 13]
      undo()
      expect(s.items.peek()).toEqual([{ n: 1 }, { n: 2 }, { n: 13 }])
    })
  })

  it('recorded patches and caller payloads are not mutated by later writes', () => {
    const s = observable({ cfg: { mode: 'z' } })
    const seen: UpdateRecord[] = []
    const off = addInterceptor({ after: r => seen.push(r) })
    const setCfg = update('alias/setCfg', { s }, (d, cfg: { mode: string }) => { d.s.cfg = cfg })
    const setMode = update('alias/setMode', { s }, (d, mode: string) => { d.s.cfg.mode = mode })
    const payload = { mode: 'a' }
    setCfg(payload)
    setMode('b')
    off()
    expect(s.cfg.mode.peek()).toBe('b')
    expect(payload).toEqual({ mode: 'a' })
    expect(seen[0]!.patches[0]!.value).toEqual({ mode: 'a' })
  })
})

describe('update: fastAppends atom option', () => {
  // Registered atoms opt into in-place appends per atom; everything else —
  // default atoms, raw observables, child-node (scoped) write scopes — gets
  // the safe path: structural changes always produce a new array identity.
  const freshAtom = async (options?: { fastAppends?: boolean }) => {
    const { atom, clearRegistry } = await import('../src/atom')
    clearRegistry()
    return atom('list', { items: [1, 2] as number[], meta: { touched: 0 } }, options) as any
  }
  const append = (list: any) =>
    update('list/append', { l: list }, (d, n: number) => { d.l.items.push(n) })

  it('default atom: append produces a new array identity', async () => {
    const list = await freshAtom()
    const before = list.items.peek()
    append(list)(3)
    expect(list.items.peek()).not.toBe(before)
    expect(list.items.peek()).toEqual([1, 2, 3])
  })

  it('fastAppends atom: append is in place, identity kept', async () => {
    const list = await freshAtom({ fastAppends: true })
    const before = list.items.peek()
    append(list)(3)
    expect(list.items.peek()).toBe(before)
    expect(list.items.peek()).toEqual([1, 2, 3])
  })

  it('fastAppends atom: removes still produce a new identity', async () => {
    const list = await freshAtom({ fastAppends: true })
    const remove = update('list/remove', { l: list }, (d, n: number) => {
      const i = d.l.items.indexOf(n)
      if (i !== -1) d.l.items.splice(i, 1)
    })
    const before = list.items.peek()
    remove(1)
    expect(list.items.peek()).not.toBe(before)
    expect(list.items.peek()).toEqual([2])
  })

  it('child-node (scoped) write scope on a fast atom takes the safe append', async () => {
    const list = await freshAtom({ fastAppends: true })
    const scopedAppend = update('list/scopedAppend', { items: list.items }, (d, n: number) => {
      d.items.push(n)
    })
    const before = list.items.peek()
    scopedAppend(3)
    expect(list.items.peek()).not.toBe(before)
    expect(list.items.peek()).toEqual([1, 2, 3])
  })

  it('default atom: a reorder (sort, reverse, swap) produces a new array identity', async () => {
    const list = await freshAtom()
    const reorders = [
      update('list/sort', { l: list }, d => { d.l.items.sort((x: number, y: number) => y - x) }),
      update('list/reverse', { l: list }, d => { d.l.items.reverse() }),
      update('list/swap', { l: list }, d => {
        const [x, y] = d.l.items
        d.l.items[0] = y
        d.l.items[1] = x
      }),
    ]
    for (const reorder of reorders) {
      const before = list.items.peek()
      reorder()
      expect(list.items.peek()).not.toBe(before)
    }
    expect(list.items.peek()).toEqual([2, 1])
  })

  it('unregistered raw observables take the safe append', () => {
    const raw = observable({ items: [1] as number[] }) as any
    const before = raw.items.peek()
    update('raw/append', { r: raw }, (d, n: number) => { d.r.items.push(n) })(2)
    expect(raw.items.peek()).not.toBe(before)
    expect(raw.items.peek()).toEqual([1, 2])
  })
})
