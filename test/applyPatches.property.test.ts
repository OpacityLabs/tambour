import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { observable } from '@legendapp/state'
import { produceWithPatches } from 'immer'
import { applyPatches } from '../src/applyPatches'

/**
 * Property: for ANY sequence of draft mutations over a realistic state shape,
 * applying the emitted patches to a Legend observable yields a value deep-equal
 * to Immer's (discarded) `next` state.
 */

interface State {
  profile: { name: string; age: number; tags: string[] }
  todos: { id: string; qty: number; meta: { notes: string[] } }[]
  counts: Record<string, number>
}

const initialState = (): State => ({
  profile: { name: 'ada', age: 30, tags: ['x', 'y'] },
  todos: [
    { id: 'a', qty: 1, meta: { notes: ['n1'] } },
    { id: 'b', qty: 2, meta: { notes: [] } },
    { id: 'c', qty: 3, meta: { notes: ['n2', 'n3'] } },
  ],
  counts: { a: 1, b: 2 },
})

// Each command is a small deterministic mutation parameterized by generated ints/strings.
type Cmd = (d: State, i: number, s: string) => void

const commands: Cmd[] = [
  (d, i) => { d.profile.age = i },
  (d, _i, s) => { d.profile.name = s },
  (d, _i, s) => { d.profile.tags.push(s) },
  d => { d.profile.tags.pop() },
  (d, i, s) => { d.profile.tags.splice(Math.abs(i) % (d.profile.tags.length + 1), 0, s) },
  (d, i) => { if (d.profile.tags.length) d.profile.tags.splice(Math.abs(i) % d.profile.tags.length, 1) },
  (d, i) => { d.profile.tags.length = Math.abs(i) % (d.profile.tags.length + 1) },
  d => { d.profile.tags.reverse() },
  (d, i, s) => { d.todos.push({ id: s, qty: i, meta: { notes: [] } }) },
  d => { d.todos.shift() },
  (d, i) => { const t = d.todos[Math.abs(i) % (d.todos.length || 1)]; if (t) t.qty = i },
  (d, i, s) => { const t = d.todos[Math.abs(i) % (d.todos.length || 1)]; if (t) t.meta.notes.push(s) },
  (d, i) => { d.todos = d.todos.filter((_, idx) => idx !== Math.abs(i) % (d.todos.length || 1)) },
  (d, i, s) => { d.todos.splice(Math.abs(i) % (d.todos.length + 1), 0, { id: s, qty: i, meta: { notes: [s] } }) },
  d => { d.todos.sort((a, b) => a.qty - b.qty) },
  (d, i, s) => { d.counts[s] = i },
  (d, _i, s) => { delete d.counts[s] },
  (d, i) => { for (const k of Object.keys(d.counts)) d.counts[k] = i },
  (d, i, s) => { d.profile = { name: s, age: i, tags: [s] } },   // whole-subtree replace
]

const step = fc.record({
  cmd: fc.nat({ max: commands.length - 1 }),
  i: fc.integer({ min: -5, max: 50 }),
  s: fc.string({ minLength: 1, maxLength: 6 }),
})

describe('applyPatches property test', () => {
  it('patch application ≡ Immer next, for arbitrary mutation sequences', () => {
    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 25 }), steps => {
        const obs$ = observable(initialState()) as any
        const [next, patches] = produceWithPatches(initialState(), (d: State) => {
          for (const { cmd, i, s } of steps) commands[cmd]!(d, i, s)
        })
        applyPatches(obs$, patches)
        expect(obs$.peek()).toEqual(next)
      }),
      { numRuns: 500 },
    )
  })

  it('inverse patches restore the original state', () => {
    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 15 }), steps => {
        const obs$ = observable(initialState()) as any
        const [, patches, inverse] = produceWithPatches(initialState(), (d: State) => {
          for (const { cmd, i, s } of steps) commands[cmd]!(d, i, s)
        })
        applyPatches(obs$, patches)
        applyPatches(obs$, inverse)
        expect(obs$.peek()).toEqual(initialState())
      }),
      { numRuns: 300 },
    )
  })
})
