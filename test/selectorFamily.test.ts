import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { atom, clearRegistry } from '../src/atom'
import { selector } from '../src/selector'
import { selectorFamily } from '../src/selectorFamily'
import { update } from '../src/update'

beforeEach(() => {
  clearRegistry()
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

function makeTodos() {
  const todos$ = atom('todos', {
    items: [{ id: 'a', qty: 1 }, { id: 'b', qty: 2 }],
  })
  const todoById = selectorFamily((id: string) =>
    selector(todos$.items, items => items.find(t => t.id === id)),
  )
  const setQty = update('todos/setQty', { t: todos$ }, (d, id: string, qty: number) => {
    const item = d.t.items.find((t: { id: string; qty: number }) => t.id === id)
    if (item) item.qty = qty
  })
  return { todos$, todoById, setQty }
}

describe('selectorFamily', () => {
  it('same args -> same cached node; different args -> different nodes', () => {
    const { todoById } = makeTodos()
    expect(todoById('a')).toBe(todoById('a'))
    expect(todoById('a')).not.toBe(todoById('b'))
  })

  it('computes per-arg and recomputes on source change', () => {
    const { todoById, setQty } = makeTodos()
    expect(todoById('a').get()?.qty).toBe(1)
    expect(todoById('b').get()?.qty).toBe(2)
    setQty('b', 99)
    expect(todoById('b').get()?.qty).toBe(99)
  })

  it('evicts after the last observer leaves and the grace period elapses', async () => {
    const { todoById } = makeTodos()
    const node = todoById('a')
    const dispose = node.onChange(() => {})
    node.get()   // activate

    dispose()                          // last observer leaves -> grace timer starts
    await vi.advanceTimersByTimeAsync(10)   // let Legend's async deactivation run
    expect(todoById('a')).toBe(node)   // still cached during grace

    await vi.advanceTimersByTimeAsync(150)  // grace (100ms) elapses
    expect(todoById('a')).not.toBe(node)    // evicted -> fresh node
  })

  it('re-observation within the grace window cancels eviction', async () => {
    const { todoById } = makeTodos()
    const node = todoById('a')
    const d1 = node.onChange(() => {})
    node.get()
    d1()                               // grace timer starts
    await vi.advanceTimersByTimeAsync(50)

    const d2 = node.onChange(() => {})   // re-observed before grace elapsed
    node.get()
    await vi.advanceTimersByTimeAsync(200)
    expect(todoById('a')).toBe(node)     // still cached
    d2()
  })

  it('multi-arg keys work', () => {
    const grid$ = atom('grid', { rows: [[1, 2], [3, 4]] })
    const cell = selectorFamily((r: number, c: number) =>
      selector(grid$.rows, rows => rows[r]?.[c]),
    )
    expect(cell(0, 1).get()).toBe(2)
    expect(cell(1, 0).get()).toBe(3)
    expect(cell(0, 1)).toBe(cell(0, 1))
  })
})
