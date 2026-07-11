import { observable, batch } from '@legendapp/state'
const N = 2000
let n = 0
function probe(label, makeItems) {
  for (const size of [100, 1000, 5000]) {
    const l$ = observable({ items: makeItems(size) })
    const t = performance.now()
    for (let i = 0; i < N; i++) { l$.peek(); batch(() => l$.items.push(makeItems(1)[0])) }
    console.log(`${label} size=${size}:`.padEnd(30), ((performance.now()-t)/N*1000).toFixed(1), 'µs/op')
  }
}
probe('objects with id', size => Array.from({ length: size }, () => ({ id: `x${n++}`, qty: 0 })))
probe('plain numbers  ', size => Array.from({ length: size }, () => n++))
