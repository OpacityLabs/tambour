import { observable, batch } from '@legendapp/state'

const mk = () => Array.from({ length: 1000 }, (_, i) => ({ id: `t${i}`, qty: i, done: false }))
const N = 2000
let n = 0

// A: push only
{
  const l$ = observable({ items: mk() })
  const t = performance.now()
  for (let i = 0; i < N; i++) batch(() => l$.items.push({ id: `a${n++}`, qty: 0, done: false }))
  console.log('push only:            ', ((performance.now()-t)/N*1000).toFixed(1), 'µs/op')
}
// B: peek root each iteration, then push
{
  const l$ = observable({ items: mk() })
  const t = performance.now()
  for (let i = 0; i < N; i++) { l$.peek(); batch(() => l$.items.push({ id: `b${n++}`, qty: 0, done: false })) }
  console.log('peek(root) + push:    ', ((performance.now()-t)/N*1000).toFixed(1), 'µs/op')
}
// C: peek items only, then push
{
  const l$ = observable({ items: mk() })
  const t = performance.now()
  for (let i = 0; i < N; i++) { l$.items.peek(); batch(() => l$.items.push({ id: `c${n++}`, qty: 0, done: false })) }
  console.log('peek(items) + push:   ', ((performance.now()-t)/N*1000).toFixed(1), 'µs/op')
}
// D: peek AFTER push instead of before
{
  const l$ = observable({ items: mk() })
  const t = performance.now()
  for (let i = 0; i < N; i++) { batch(() => l$.items.push({ id: `d${n++}`, qty: 0, done: false })); l$.peek() }
  console.log('push + peek(root):    ', ((performance.now()-t)/N*1000).toFixed(1), 'µs/op')
}
