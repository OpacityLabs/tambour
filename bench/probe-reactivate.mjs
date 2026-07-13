import { observable } from '@legendapp/state'
import { synced } from '@legendapp/state/sync'
import { Subject, Observable } from 'rxjs'

const source = new Subject()
let activations = 0
const wrapped = new Observable(sub => {
  activations++
  const s = source.subscribe(sub)
  return () => { s.unsubscribe() }
})
const node$ = observable(synced({
  initial: undefined,
  subscribe: ({ update }) => {
    const sub = wrapped.subscribe({ next: value => update({ value }) })
    return () => sub.unsubscribe()
  },
}))

const d1 = node$.onChange(() => {})
node$.get()
console.log('activations after first observe:', activations)
source.next(1)
console.log('value:', node$.peek())
d1()
await new Promise(r => setTimeout(r, 20))
console.log('activations after teardown:', activations)

const d2 = node$.onChange(() => {})
node$.get()
await new Promise(r => setTimeout(r, 20))
console.log('activations after re-observe:', activations)
source.next(2)
await new Promise(r => setTimeout(r, 20))
console.log('value after next(2):', node$.peek())
d2()
