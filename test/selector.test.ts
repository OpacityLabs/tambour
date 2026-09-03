import { beforeEach, describe, expect, it, vi } from 'vitest'
import { atom, clearRegistry } from '../src/atom'
import { selector } from '../src/selector'
import { update } from '../src/update'

beforeEach(() => clearRegistry())

const shallowEqual = (a: any, b: any) => {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  const ka = Object.keys(a), kb = Object.keys(b)
  return ka.length === kb.length && ka.every(k => Object.is(a[k], b[k]))
}

describe('selector: deps-then-combiner', () => {
  it('computes from plain dep values and recomputes on change', () => {
    const todos = atom('todos', { items: [{ id: 'a', done: false }, { id: 'b', done: true }] })
    const ui = atom('ui', { filter: 'all' as 'all' | 'done' })

    const visible = selector(todos.items, ui.filter, (items, filter) =>
      filter === 'done' ? items.filter(t => t.done) : items,
    )
    expect(visible.get().length).toBe(2)

    const setFilter = update('ui/filter', { ui: ui }, (d, f: 'all' | 'done') => { d.ui.filter = f })
    setFilter('done')
    expect(visible.get().map(t => t.id)).toEqual(['b'])
  })

  it('is lazy: the combiner does not run until first read', () => {
    const a = atom('a', { v: 1 })
    const spy = vi.fn((v: { v: number }) => v.v * 2)
    const s = selector(a, spy)
    expect(spy).not.toHaveBeenCalled()
    expect(s.get()).toBe(2)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('a batched multi-atom update recomputes dependents once', () => {
    const a = atom('a', { v: 1 })
    const b = atom('b', { v: 10 })
    const sum = selector(a.v, b.v, (a, b) => a + b)

    const notifications: number[] = []
    sum.onChange(({ value }) => notifications.push(value))
    sum.get()

    const setBoth = update('test/setBoth', { a: a, b: b }, d => { d.a.v = 2; d.b.v = 20 })
    setBoth()
    expect(notifications).toEqual([22])   // no torn intermediate, single recompute
  })

  it('selectors compose as deps of selectors', () => {
    const todos = atom('todos', { items: [{ done: true }, { done: false }] })
    const done = selector(todos.items, items => items.filter(t => t.done))
    const count = selector(done, done => done.length)
    expect(count.get()).toBe(1)
  })
})

describe('selector: thunk escape hatch', () => {
  it('auto-tracks dynamic dependencies', () => {
    const mode = atom('mode', { use: 'a' as 'a' | 'b' })
    const a = atom('a', { v: 1 })
    const b = atom('b', { v: 100 })
    const dynamic = selector(() => (mode.use.get() === 'a' ? a.v.get() : b.v.get()))

    expect(dynamic.get()).toBe(1)
    const switchMode = update('mode/switch', { m: mode }, d => { d.m.use = 'b' })
    switchMode()
    expect(dynamic.get()).toBe(100)
  })
})

describe('selector: equals option', () => {
  it('suppresses notification when the recomputed value is structurally equal', () => {
    const todos = atom('todos', { items: [{ done: true }, { done: false }] })
    const stats = selector(
      todos.items,
      items => ({ total: items.length, done: items.filter(t => t.done).length }),
      { equals: shallowEqual },
    )

    const notifications: unknown[] = []
    stats.onChange(({ value }) => notifications.push(value))
    stats.get()

    // toggle one todo's done off and another on — counts unchanged
    const swap = update('todos/swap', { t: todos }, d => {
      d.t.items[0]!.done = false
      d.t.items[1]!.done = true
    })
    swap()
    expect(stats.get()).toEqual({ total: 2, done: 1 })
    expect(notifications).toEqual([])   // structurally equal — no notify

    const add = update('todos/add', { t: todos }, d => { d.t.items.push({ done: true }) })
    add()
    expect(notifications).toEqual([{ total: 3, done: 2 }])   // real change notifies
  })
})
