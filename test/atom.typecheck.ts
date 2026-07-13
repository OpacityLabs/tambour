/**
 * Compile-time tests for the ReadonlyNode surface — validated by `npm run
 * typecheck`, never executed. Each @ts-expect-error line FAILS the build if
 * the write method it exercises ever becomes visible on the public type.
 */
import { atom } from '../src/atom'

const demo$ = atom('typecheck/demo', {
  count: 0,
  user: { name: 'ada', tags: ['x'] },
  items: [{ id: 'a', qty: 1 }],
})

// reads are fully typed at every depth
const n: number = demo$.count.get()
const name: string = demo$.user.name.peek()
const qty: number | undefined = demo$.items[0]?.qty.get()
demo$.onChange(({ value }) => value.count)
void n; void name; void qty

// @ts-expect-error — set() is not on the public atom type
demo$.count.set(1)

// @ts-expect-error — set() is not available on nested nodes either
demo$.user.name.set('eve')

// @ts-expect-error — delete() is not on the public type
demo$.user.delete()

// @ts-expect-error — assign() is not on the public type
demo$.user.assign({ name: 'eve' })

// @ts-expect-error — push() is not on array nodes; arrays change via updates
demo$.items.push({ id: 'b', qty: 2 })
