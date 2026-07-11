import { observable } from '@legendapp/state'
import { synced } from '@legendapp/state/sync'
import { Subject, Observable } from 'rxjs'

const source = new Subject()
let active = 0
const wrapped = new Observable(sub => {
  active++
  const s = source.subscribe(sub)
  return () => { active--; s.unsubscribe() }
})

const node$ = observable(synced({
  initial: undefined,
  subscribe: ({ update }) => {
    const sub = wrapped.subscribe({ next: value => update({ value }) })
    return () => sub.unsubscribe()
  },
}))

console.log('before observe, active:', active)
const dispose = node$.onChange(() => {})
node$.get()
console.log('after first get, active:', active)
dispose()
await new Promise(r => setTimeout(r, 50))
console.log('after last listener disposed, active:', active)
