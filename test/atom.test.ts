import { beforeEach, describe, expect, it } from 'vitest'
import { atom, atomNames, clearRegistry, resetAll, restore, snapshot } from '../src/atom'
import { update } from '../src/update'

beforeEach(() => clearRegistry())

describe('atom registration', () => {
  it('registers and reads', () => {
    const cart$ = atom('cart', { items: ['x'], total: 10 })
    expect(cart$.get()).toEqual({ items: ['x'], total: 10 })
    expect(cart$.total.peek()).toBe(10)
    expect(atomNames()).toEqual(['cart'])
  })

  it('throws on duplicate names', () => {
    atom('cart', {})
    expect(() => atom('cart', {})).toThrow(/duplicate atom name 'cart'/)
  })

  it('is isolated from the initial-value object passed in', () => {
    const initial = { items: ['x'] }
    const a$ = atom('a', initial)
    initial.items.push('mutated-from-outside')
    expect(a$.items.peek()).toEqual(['x'])
  })
})

describe('resetAll', () => {
  it('restores every atom to its captured initial value', () => {
    const a$ = atom('a', { v: 1 })
    const b$ = atom('b', { list: [1, 2] })
    const bump = update('test/bump', { a: a$, b: b$ }, d => {
      d.a.v = 99
      d.b.list.push(3)
    })
    bump()
    expect(a$.peek()).toEqual({ v: 99 })

    resetAll()
    expect(a$.peek()).toEqual({ v: 1 })
    expect(b$.peek()).toEqual({ list: [1, 2] })
  })

  it('reset values are fresh clones (initial cannot be corrupted through resets)', () => {
    const a$ = atom('a', { list: [1] })
    const push = update('test/push', { a: a$ }, d => { d.a.list.push(2) })
    push()
    resetAll()
    push()
    resetAll()
    expect(a$.peek()).toEqual({ list: [1] })
  })
})

describe('snapshot / restore', () => {
  it('round-trips all atoms', () => {
    const a$ = atom('a', { v: 1 })
    const b$ = atom('b', { s: 'x' })
    const setV = update('test/setV', { a: a$ }, (d, v: number) => { d.a.v = v })

    setV(42)
    const snap = snapshot()
    setV(7)
    expect(a$.v.peek()).toBe(7)

    restore(snap)
    expect(a$.v.peek()).toBe(42)
    expect(b$.s.peek()).toBe('x')
  })

  it('snapshots are deep-cloned, not live references', () => {
    const a$ = atom('a', { list: [1] })
    const snap = snapshot()
    const push = update('test/push', { a: a$ }, d => { d.a.list.push(2) })
    push()
    expect((snap.a as any).list).toEqual([1])
  })

  it('restore ignores unknown atom names', () => {
    const a$ = atom('a', { v: 1 })
    restore({ ghost: { v: 999 }, a: { v: 5 } })
    expect(a$.v.peek()).toBe(5)
  })
})

describe('atoms + update interop', () => {
  it('updates write through the same node the readonly atom wraps', () => {
    const cart$ = atom('cart', { items: [] as string[], total: 0 })
    const addItem = update('cart/add', { cart: cart$ }, (d, item: string, price: number) => {
      d.cart.items.push(item)
      d.cart.total += price
    })
    addItem('apple', 3)
    expect(cart$.peek()).toEqual({ items: ['apple'], total: 3 })
  })
})
