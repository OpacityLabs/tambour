import { beforeEach, describe, expect, it, vi } from 'vitest'
import { atom, clearRegistry } from '../src/atom'
import { addInterceptor } from '../src/interceptors'
import { reaction } from '../src/reaction'
import { selector } from '../src/selector'
import { update } from '../src/update'

beforeEach(() => clearRegistry())

function makeCart() {
  const cart$ = atom('cart', { total: 0 })
  const setTotal = update('cart/setTotal', { cart: cart$ }, (d, v: number) => { d.cart.total = v })
  return { cart$, setTotal }
}

describe('reaction', () => {
  it('fires on dep change with plain values; default skips registration', () => {
    const { cart$, setTotal } = makeCart()
    const seen: number[] = []
    const dispose = reaction('r/track', cart$.total, total => { seen.push(total) })

    expect(seen).toEqual([])          // no immediate by default
    setTotal(50)
    setTotal(120)
    expect(seen).toEqual([50, 120])
    dispose()
    setTotal(7)
    expect(seen).toEqual([50, 120])   // disposed
  })

  it('immediate: evaluates against current state at registration', () => {
    const { cart$, setTotal } = makeCart()
    setTotal(150)
    const seen: number[] = []
    reaction('r/imm', cart$.total, t => { seen.push(t) }, { immediate: true })
    expect(seen).toEqual([150])       // the hydration case
  })

  it('edge-triggering via a boolean selector: fires only on transitions', () => {
    const { cart$, setTotal } = makeCart()
    const over$ = selector(cart$.total, t => t > 100)
    const fired: boolean[] = []
    reaction('r/edge', over$, over => { fired.push(over) })

    setTotal(50)    // false -> false: no fire
    setTotal(120)   // false -> true: fire
    setTotal(130)   // true -> true: no fire (value 130 changed, boolean didn't)
    setTotal(20)    // true -> false: fire
    expect(fired).toEqual([true, false])
  })

  it('updates called from a reaction carry the reaction as origin', () => {
    const { cart$, setTotal } = makeCart()
    const log$ = atom('log', { entries: [] as number[] })
    const record = update('log/record', { log: log$ }, (d, v: number) => { d.log.entries.push(v) })
    const origins: (string | null)[] = []
    const off = addInterceptor({ after: r => { if (r.name === 'log/record') origins.push(r.origin) } })

    reaction('r/audit', cart$.total, t => record(t))
    setTotal(5)
    expect(origins).toEqual(['r/audit'])
    off()
  })

  it('multiple deps arrive as plain values', () => {
    const a$ = atom('a', { v: 1 })
    const b$ = atom('b', { v: 10 })
    const bump = update('a/bump', { a: a$ }, d => { d.a.v += 1 })
    const seen: Array<[number, number]> = []
    reaction('r/multi', a$.v, b$.v, (a, b) => { seen.push([a, b]) })
    bump()
    expect(seen).toEqual([[2, 10]])
  })
})

describe('reaction loop protection', () => {
  it('circuit-breaks a ping-pong loop, reports it, and the system survives', () => {
    const a$ = atom('a', { v: 0 })
    const b$ = atom('b', { v: 0 })
    const setA = update('a/set', { a: a$ }, (d, v: number) => { d.a.v = v })
    const setB = update('b/set', { b: b$ }, (d, v: number) => { d.b.v = v })

    const loops: string[][] = []
    const off = addInterceptor({ onReactionLoop: (_name, chain) => loops.push(chain) })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    reaction('r/chaseA', b$.v, b => setA(b + 1))
    reaction('r/chaseB', a$.v, a => setB(a + 1))

    setA(1)   // must return (cascade dies out), not hang and not throw

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('reaction loop detected'))
    expect(loops).toHaveLength(1)                       // reported once per burst
    expect(loops[0]!.join(' ')).toMatch(/r\/chase/)     // chain names participants
    errSpy.mockRestore()
    off()
  })

  it('a well-behaved converging reaction does not trip the guard', () => {
    const { cart$, setTotal } = makeCart()
    const clamped = vi.fn()
    // clamps once, then stabilizes: total > 100 -> set to exactly 100
    reaction('r/clamp', cart$.total, t => {
      if (t > 100) { setTotal(100); clamped() }
    })
    setTotal(250)
    expect(clamped).toHaveBeenCalledTimes(1)
    expect(cart$.total.peek()).toBe(100)
  })
})
