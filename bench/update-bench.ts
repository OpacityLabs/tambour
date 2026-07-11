import { observable, batch } from '@legendapp/state'
import { update } from '../src/update'

function bench(label: string, iterations: number, fn: () => void): number {
  for (let i = 0; i < Math.min(1000, iterations / 10); i++) fn()   // warmup
  const start = performance.now()
  for (let i = 0; i < iterations; i++) fn()
  const ms = performance.now() - start
  const perOp = (ms / iterations) * 1000
  console.log(`  ${label.padEnd(42)} ${ms.toFixed(1).padStart(8)} ms total   ${perOp.toFixed(2).padStart(8)} µs/op`)
  return perOp
}

const ITER = 20_000

console.log('\n— small object (5 keys), touch one key —')
{
  const small$ = observable({ a: 0, b: 0, c: 0, d: 0, e: 0 }) as any
  const viaUpdate = update('bench/small', { s: small$ }, (d, v: number) => { d.s.a = v })
  const immer = bench('update() [immer patches]', ITER, () => viaUpdate(1))
  const direct = bench('batch(() => node.set())', ITER, () => batch(() => small$.a.set(1)))
  console.log(`  → immer overhead: ${(immer / direct).toFixed(1)}x`)
}

console.log('\n— wide object (200 keys), touch one key —')
{
  const wide: Record<string, number> = {}
  for (let i = 0; i < 200; i++) wide[`k${i}`] = i
  const wide$ = observable(wide) as any
  const viaUpdate = update('bench/wide', { w: wide$ }, (d, v: number) => { d.w.k0 = v })
  const immer = bench('update() [immer patches]', ITER, () => viaUpdate(1))
  const direct = bench('batch(() => node.set())', ITER, () => batch(() => wide$.k0.set(1)))
  console.log(`  → immer overhead: ${(immer / direct).toFixed(1)}x`)
}

console.log('\n— array of 1,000 items, touch one item.qty —')
{
  const items = Array.from({ length: 1000 }, (_, i) => ({ id: `t${i}`, qty: i, done: false }))
  const list$ = observable({ items }) as any
  const viaUpdate = update('bench/list', { l: list$ }, (d, v: number) => { d.l.items[500].qty = v })
  const immer = bench('update() [immer patches]', ITER, () => viaUpdate(1))
  const direct = bench('batch(() => node.set())', ITER, () => batch(() => list$.items[500].qty.set(1)))
  console.log(`  → immer overhead: ${(immer / direct).toFixed(1)}x`)
}

console.log('\n— array of 1,000 items, scoped update on the ITEM node (not the list) —')
{
  const items = Array.from({ length: 1000 }, (_, i) => ({ id: `t${i}`, qty: i, done: false }))
  const list$ = observable({ items }) as any
  const item$ = list$.items[500]
  const viaScopedUpdate = update('bench/item', { item: item$ }, (d, v: number) => { d.item.qty = v })
  const immer = bench('scoped update() [proxies 1 item]', ITER, () => viaScopedUpdate(1))
  const direct = bench('batch(() => node.set())', ITER, () => batch(() => item$.qty.set(1)))
  console.log(`  → immer overhead: ${(immer / direct).toFixed(1)}x`)
}

console.log('\n— array push (1,000-item list) —')
{
  const items = Array.from({ length: 1000 }, (_, i) => ({ id: `t${i}`, qty: i, done: false }))
  const list$ = observable({ items: items.slice() }) as any
  let n = 0
  const viaUpdate = update('bench/push', { l: list$ }, d => { d.l.items.push({ id: `n${n++}`, qty: 0, done: false }) })
  bench('update() push [immer patches]', 2000, () => viaUpdate())
  const list2$ = observable({ items: items.slice() }) as any
  bench('direct list$.items.push()', 2000, () => batch(() => list2$.items.push({ id: `m${n++}`, qty: 0, done: false })))
}

console.log('\n(Node on this machine; RN-device numbers will differ — treat ratios as the signal.)')
