import { describe, expect, it } from 'vitest'
import { observable } from '@legendapp/state'
import { produceWithPatches } from 'immer'
import { applyPatches } from '../src/applyPatches'

/** Run a recipe through Immer, apply the patches to a Legend observable,
 *  and assert the observable ends up deep-equal to Immer's `next`. */
function check<T extends object>(base: T, recipe: (d: T) => void) {
  const obs$ = observable(structuredClone(base)) as any
  const [next, patches] = produceWithPatches(structuredClone(base), recipe as any)
  applyPatches(obs$, patches)
  expect(obs$.peek()).toEqual(next)
  return { next, patches }
}

describe('applyPatches: object ops', () => {
  it('sets a new key', () => check({ a: 1 } as any, d => { d.b = 2 }))
  it('replaces a key', () => check({ a: 1 }, d => { d.a = 9 }))
  it('deletes a key', () => check({ a: 1, b: 2 } as any, d => { delete d.b }))
  it('sets nested keys', () =>
    check({ user: { name: 'x', meta: { age: 1 } } }, d => { d.user.meta.age = 2 }))
  it('replaces a whole subtree', () =>
    check({ user: { name: 'x' } } as any, d => { d.user = { name: 'y', extra: true } }))
})

describe('applyPatches: array ops', () => {
  const base = () => ({ items: [1, 2, 3, 4, 5] })
  it('push', () => check(base(), d => { d.items.push(6) }))
  it('pop', () => check(base(), d => { d.items.pop() }))
  it('shift', () => check(base(), d => { d.items.shift() }))
  it('unshift', () => check(base(), d => { d.items.unshift(0) }))
  it('set by index', () => check(base(), d => { d.items[2] = 99 }))
  it('insert middle via splice', () => check(base(), d => { d.items.splice(2, 0, 99) }))
  it('remove middle via splice', () => check(base(), d => { d.items.splice(1, 2) }))
  it('truncate via length', () => check(base(), d => { d.items.length = 2 }))
  it('clear via length 0', () => check(base(), d => { d.items.length = 0 }))
  it('reverse', () => check(base(), d => { d.items.reverse() }))
  it('sort', () => check({ items: [3, 1, 2] }, d => { d.items.sort() }))
  it('filter reassignment', () =>
    check(base() as any, d => { d.items = d.items.filter((n: number) => n % 2 === 0) }))
  it('objects in arrays', () =>
    check({ todos: [{ id: 'a', done: false }, { id: 'b', done: false }] }, d => {
      d.todos[1]!.done = true
    }))
  it('splice objects into array of objects', () =>
    check({ todos: [{ id: 'a' }, { id: 'c' }] }, d => {
      d.todos.splice(1, 0, { id: 'b' })
    }))
})

describe('applyPatches: transactionality', () => {
  it('a throwing recipe is a clean no-op', () => {
    const obs$ = observable({ a: 1, b: 2 }) as any
    const recipe: (d: { a: number; b: number }) => void = d => {
      d.a = 99
      throw new Error('validation failed')
    }
    expect(() => {
      const [, patches] = produceWithPatches({ a: 1, b: 2 }, recipe as any)
      applyPatches(obs$, patches)
    }).toThrow('validation failed')
    expect(obs$.peek()).toEqual({ a: 1, b: 2 })
  })
})

describe('freeze safety', () => {
  it('does not freeze Legend internals via structural sharing', () => {
    const obs$ = observable({ kept: { deep: 1 }, changed: 0 }) as any
    const base: { kept: { deep: number }; changed: number } = obs$.peek()
    const [, patches] = produceWithPatches(base, d => { d.changed = 1 })
    applyPatches(obs$, patches)
    // if autoFreeze leaked, this second targeted set would throw or silently fail
    obs$.kept.deep.set(2)
    expect(obs$.kept.deep.peek()).toBe(2)
  })
})
