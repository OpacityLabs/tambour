// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Subject } from 'rxjs'
import { atom, clearRegistry } from '../src/atom'
import { selector } from '../src/selector'
import { selectorFamily } from '../src/selectorFamily'
import { streamSelector } from '../src/streamSelector'
import { update } from '../src/update'
import { use$ } from '../src/react'

beforeEach(() => clearRegistry())
afterEach(() => cleanup())

const shallowEqual = (a: any, b: any) => {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  const ka = Object.keys(a), kb = Object.keys(b)
  return ka.length === kb.length && ka.every(k => Object.is(a[k], b[k]))
}

function makeStore() {
  const cart$ = atom('cart', {
    items: [{ id: 'a', qty: 1 }, { id: 'b', qty: 2 }],
  })
  const setQty = update('cart/setQty', { cart: cart$ }, (d, index: number, qty: number) => {
    d.cart.items[index]!.qty = qty
  })
  return { cart$, setQty }
}

describe('use$: basic subscription', () => {
  it('renders the value and re-renders on update', () => {
    const { cart$, setQty } = makeStore()
    function Qty() {
      return <span data-testid="qty">{use$(cart$.items[0]!.qty)}</span>
    }
    render(<Qty />)
    expect(screen.getByTestId('qty').textContent).toBe('1')

    act(() => setQty(0, 5))
    expect(screen.getByTestId('qty').textContent).toBe('5')
  })
})

describe('use$: targeted re-renders (the Legend axis, through our API)', () => {
  it('a row re-renders only when ITS item changes', () => {
    const { cart$, setQty } = makeStore()
    const renders = { a: 0, b: 0 }

    function Row({ index, id }: { index: number; id: 'a' | 'b' }) {
      renders[id]++
      return <span data-testid={id}>{use$(cart$.items[index]!.qty)}</span>
    }
    render(<><Row index={0} id="a" /><Row index={1} id="b" /></>)
    expect(renders).toEqual({ a: 1, b: 1 })

    act(() => setQty(1, 99))                    // touch item b only
    expect(screen.getByTestId('b').textContent).toBe('99')
    expect(renders).toEqual({ a: 1, b: 2 })     // row a never re-rendered
  })

  it('an equals-selector suppresses re-renders for structurally equal recomputes', () => {
    const todos$ = atom('todos', { items: [{ done: true }, { done: false }] })
    const swap = update('todos/swap', { t: todos$ }, d => {
      d.t.items[0]!.done = !d.t.items[0]!.done
      d.t.items[1]!.done = !d.t.items[1]!.done
    })
    const stats$ = selector(
      todos$.items,
      items => ({ total: items.length, done: items.filter(t => t.done).length }),
      { equals: shallowEqual },
    )

    let renders = 0
    function Stats() {
      renders++
      const s = use$(stats$)
      return <span data-testid="stats">{s.done}/{s.total}</span>
    }
    render(<Stats />)
    expect(renders).toBe(1)

    act(() => swap())   // one done -> undone, other undone -> done: counts equal
    expect(screen.getByTestId('stats').textContent).toBe('1/2')
    expect(renders).toBe(1)                     // suppressed — no re-render
  })
})

describe('use$: streamSelector integration', () => {
  it('renders the default, then emissions as they arrive', async () => {
    const source = new Subject<string[]>()
    const results$ = streamSelector(source.asObservable(), { default: [] as string[] })

    function Results() {
      const results = use$(results$)
      return <span data-testid="r">{results.length === 0 ? 'empty' : results.join(',')}</span>
    }
    render(<Results />)
    expect(screen.getByTestId('r').textContent).toBe('empty')

    await waitFor(() => {})                     // let activation settle
    act(() => source.next(['x', 'y']))
    await waitFor(() => expect(screen.getByTestId('r').textContent).toBe('x,y'))
  })

  it('works under StrictMode double-mounting', async () => {
    const source = new Subject<number>()
    const value$ = streamSelector(source.asObservable(), { default: 0 })

    function Value() {
      return <span data-testid="v">{use$(value$)}</span>
    }
    render(<StrictMode><Value /></StrictMode>)
    expect(screen.getByTestId('v').textContent).toBe('0')

    // StrictMode mounts, unmounts, remounts; re-subscription is async — wait
    // for the pipeline to be live again before asserting flow
    await new Promise(r => setTimeout(r, 20))
    act(() => source.next(42))
    await waitFor(() => expect(screen.getByTestId('v').textContent).toBe('42'))
  })
})

describe('use$: selectorFamily lifecycle under React', () => {
  it('family entries survive StrictMode and unmount/remount within grace', async () => {
    const { cart$, setQty } = makeStore()
    const qtyById = selectorFamily((id: string) =>
      selector(cart$.items, items => items.find(t => t.id === id)?.qty),
    )

    function Qty({ id }: { id: string }) {
      return <span data-testid="fam">{use$(qtyById(id))}</span>
    }
    const first = render(<StrictMode><Qty id="a" /></StrictMode>)
    expect(screen.getByTestId('fam').textContent).toBe('1')
    const nodeBefore = qtyById('a')

    first.unmount()
    // remount within the 100ms grace window: same cached node
    render(<StrictMode><Qty id="a" /></StrictMode>)
    expect(qtyById('a')).toBe(nodeBefore)

    act(() => setQty(0, 7))
    await waitFor(() => expect(screen.getByTestId('fam').textContent).toBe('7'))
  })
})
