import { observable, batch } from '@legendapp/state'
import { produceWithPatches, setAutoFreeze, enablePatches } from 'immer'
setAutoFreeze(false); enablePatches()

const items = Array.from({ length: 1000 }, (_, i) => ({ id: `t${i}`, qty: i, done: false }))
const list$ = observable({ items: items.slice() })

const N = 2000
let n = 0

// 1: peek only
let t = performance.now()
for (let i = 0; i < N; i++) { const base = { l: list$.peek() } }
console.log('peek:', ((performance.now()-t)/N*1000).toFixed(1), 'µs/op')

// 2: peek + produce (no apply)
t = performance.now()
let lastPatches
for (let i = 0; i < N; i++) {
  const base = { l: list$.peek() }
  const [, patches] = produceWithPatches(base, d => { d.l.items.push({ id: `n${n++}`, qty: 0, done: false }) })
  lastPatches = patches
}
console.log('peek+produce:', ((performance.now()-t)/N*1000).toFixed(1), 'µs/op')
console.log('patches for push:', JSON.stringify(lastPatches.map(p => ({op: p.op, path: p.path}))))

// 3: full: produce + apply via legend push
const list2$ = observable({ items: items.slice() })
t = performance.now()
for (let i = 0; i < N; i++) {
  const base = { l: list2$.peek() }
  const [, patches] = produceWithPatches(base, d => { d.l.items.push({ id: `p${n++}`, qty: 0, done: false }) })
  batch(() => { for (const p of patches) list2$.items.push(p.value) })
}
console.log('produce+apply:', ((performance.now()-t)/N*1000).toFixed(1), 'µs/op')
