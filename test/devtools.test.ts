import { beforeEach, describe, expect, it } from 'vitest'
import { atom, clearRegistry } from '../src/atom'
import { connectDevtools, type DevtoolsConnector } from '../src/devtools'
import { recordHistory } from '../src/history'
import { applyPatches } from '../src/applyPatches'
import { event, streamEvent } from '../src/events'
import { update } from '../src/update'

beforeEach(() => clearRegistry())

function makeFakeConnector() {
  const sent: Array<{ action: any; state: any }> = []
  const inits: unknown[] = []
  let listener: ((message: any) => void) | null = null
  const connector: DevtoolsConnector = {
    init: state => inits.push(state),
    send: (action, state) => sent.push({ action, state }),
    subscribe: l => { listener = l; return () => { listener = null } },
  }
  return { connector, sent, inits, dispatch: (m: any) => listener?.(m) }
}

describe('redux devtools adapter', () => {
  it('inits with the full snapshot and sends named actions with state', async () => {
    const cart$ = atom('cart', { items: [] as string[], total: 0 })
    const { connector, sent, inits } = makeFakeConnector()
    const dispose = connectDevtools({ connector })

    expect(inits).toEqual([{ cart: { items: [], total: 0 } }])

    const addItem = update('cart/add', { cart: cart$ }, (d, item: string) => {
      d.cart.items.push(item)
      d.cart.total += 1
    })
    const submit = event('checkout/submit', async () => { addItem('from-event') })

    addItem('apple')
    await submit()
    dispose()

    const types = sent.map(s => s.action.type)
    expect(types).toEqual(['cart/add', 'event checkout/submit', 'cart/add'])

    // direct update: full state attached, no origin
    expect(sent[0]!.state).toEqual({ cart: { items: ['apple'], total: 1 } })
    expect(sent[0]!.action.origin).toBeUndefined()
    // update fired from inside the event carries attribution
    expect(sent[2]!.action.origin).toBe('checkout/submit')
    expect(sent[2]!.action.scope).toEqual(['cart'])
  })

  it('streamEvent fires and event errors appear on the timeline', async () => {
    const { connector, sent } = makeFakeConnector()
    const dispose = connectDevtools({ connector })

    const input = streamEvent<string>('search/input')
    input('gro')

    const boom = event('sync/now', async () => { throw new Error('offline') })
    await boom().catch(() => {})
    await new Promise(r => setTimeout(r, 0))
    dispose()

    const types = sent.map(s => s.action.type)
    expect(types).toContain('event search/input')
    expect(types).toContain('event sync/now')
    expect(types).toContain('event:error sync/now')
    const err = sent.find(s => s.action.type === 'event:error sync/now')!
    expect(err.action.error).toContain('offline')
  })

  it('time travel: JUMP restores the jumped-to state; RESET restores initials', () => {
    const cart$ = atom('cart', { total: 0 })
    const setTotal = update('cart/set', { cart: cart$ }, (d, v: number) => { d.cart.total = v })
    const { connector, sent, dispatch } = makeFakeConnector()
    const dispose = connectDevtools({ connector })

    setTotal(10)
    setTotal(20)
    expect(cart$.total.peek()).toBe(20)

    // the extension hands back the stored state for the jumped-to action
    dispatch({
      type: 'DISPATCH',
      payload: { type: 'JUMP_TO_ACTION' },
      state: JSON.stringify(sent[0]!.state),
    })
    expect(cart$.total.peek()).toBe(10)

    dispatch({ type: 'DISPATCH', payload: { type: 'RESET' } })
    expect(cart$.total.peek()).toBe(0)
    dispose()
  })

  it('no connector and no extension: connect is a silent no-op', () => {
    const dispose = connectDevtools()
    expect(dispose).toBeTypeOf('function')
    dispose()
  })
})

describe('history ring buffer', () => {
  it('records update records and honors the limit', () => {
    const a$ = atom('a', { v: 0 })
    const setV = update('a/set', { a: a$ }, (d, v: number) => { d.a.v = v })
    const history = recordHistory(3)

    for (let i = 1; i <= 5; i++) setV(i)
    const entries = history.entries()
    expect(entries).toHaveLength(3)
    expect(entries.map(e => e.args[0])).toEqual([3, 4, 5])
    history.dispose()
  })

  it('inverse patches from history revert a transition (the undo recipe)', () => {
    const a$ = atom('a', { list: [1, 2] })
    const push = update('a/push', { a: a$ }, (d, v: number) => { d.a.list.push(v) })
    const history = recordHistory()

    push(3)
    expect(a$.list.peek()).toEqual([1, 2, 3])

    const last = history.entries().at(-1)!
    for (const patch of last.inverse) {
      applyPatches(a$, [{ ...patch, path: patch.path.slice(1) }])
    }
    expect(a$.list.peek()).toEqual([1, 2])
    history.dispose()
  })
})
