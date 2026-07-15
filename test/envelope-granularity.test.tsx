// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { observable } from '@legendapp/state'
import { filter, map } from 'rxjs/operators'
import { query } from '../src/query'
import { selector } from '../src/selector'
import { streamSelector } from '../src/streamSelector'
import { atomToStream } from '../src/bridges'
import { use$ } from '../src/react'

afterEach(() => cleanup())

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

interface Row { id: number; name: string }
const rows = (key: string, n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: i, name: `${key}-${i}` }))

/**
 * The showcase's exact shape: a thunk selector exposing the CURRENT key's
 * result envelope, with components subscribing to individual envelope fields
 * via path nodes: use$(state$.pending), use$(state$.data).
 *
 * The claim under test: even though the envelope ROOT is replaced on every
 * change (new object reference each time), Legend diffs per child path — so a
 * `.pending` subscriber re-renders ONLY when pending's VALUE flips, staying
 * silent while data (1,000 rows here), fetchedAt, and the root reference all
 * churn underneath it.
 */
describe('envelope granularity through use$', () => {
  it('use$(state$.pending) re-renders only on pending flips; data churn is invisible to it', async () => {
    const resolvers = new Map<string, (v: Row[]) => void>()
    const fetcher = (key: string) =>
      new Promise<Row[]>(res => {
        resolvers.set(key, res)
      })
    const books = query('gran/books', fetcher, { staleTime: 60_000, default: [] as Row[] })

    const key$ = observable('a') as any
    const state$ = selector(() => (books(key$.get()) as any).get()) as any

    const renders = { pending: 0, data: 0 }
    const pendingSeen: boolean[] = []

    function PendingProbe() {
      renders.pending++
      const pending = use$(state$.pending) as boolean
      pendingSeen.push(pending)
      return <span data-testid="pending">{String(pending)}</span>
    }
    function DataProbe() {
      renders.data++
      const data = use$(state$.data) as Row[]
      return <span data-testid="data">{data.length}</span>
    }

    render(<><PendingProbe /><DataProbe /></>)
    expect(renders).toEqual({ pending: 1, data: 1 }) // initial: false / 0 rows

    // activation kicks the 'a' fetch off one microtask later: pending flips true
    await waitFor(() => expect(screen.getByTestId('pending').textContent).toBe('true'))
    expect(renders.data).toBe(1) // data untouched by the pending flip

    // fulfill 'a' with 1,000 rows: pending flips false, data changes
    await act(async () => {
      resolvers.get('a')!(rows('a', 1000))
      await sleep(10)
    })
    expect(screen.getByTestId('pending').textContent).toBe('false')
    expect(screen.getByTestId('data').textContent).toBe('1000')
    const afterFulfill = { ...renders }

    // warm key 'b' out of band so it is cached, fresh, and active
    const nodeB = books('b') as any
    const holdB = nodeB.onChange(() => {})
    nodeB.get()
    await act(async () => {
      await sleep(10) // let b's activation fetch start
      resolvers.get('b')!(rows('b', 500))
      await sleep(10)
    })
    expect(renders).toEqual(afterFulfill) // warming b never touched these components

    // THE question: switch keys between two cached-fresh envelopes.
    // data changes (1000 → 500 rows), fetchedAt changes, the envelope root is
    // a brand-new object — but pending is false before AND after.
    await act(async () => {
      key$.set('b')
      await sleep(10)
    })
    expect(screen.getByTestId('data').textContent).toBe('500') // data subscriber saw it
    expect(renders.data).toBe(afterFulfill.data + 1)
    expect(renders.pending).toBe(afterFulfill.pending) // pending subscriber: SILENT

    // and back again — same story
    await act(async () => {
      key$.set('a')
      await sleep(10)
    })
    expect(screen.getByTestId('data').textContent).toBe('1000')
    expect(renders.pending).toBe(afterFulfill.pending) // still silent

    // every render of PendingProbe corresponded to a real value flip
    expect(pendingSeen).toEqual([false, true, false])

    holdB()
  })

  it('one component holding use$(state$.pending) AND use$(visible$) renders ONCE per change moment', async () => {
    const resolvers = new Map<string, (v: Row[]) => void>()
    const fetcher = (key: string) =>
      new Promise<Row[]>(res => {
        resolvers.set(key, res)
      })
    const books = query('gran/combined', fetcher, { staleTime: 60_000, default: [] as Row[] })

    // the full showcase wiring, including the Rx hop (settled$ / keepPrevious)
    const key$ = observable('a') as any
    const state$ = selector(() => (books(key$.get()) as any).get()) as any
    const settled$ = streamSelector(
      atomToStream(state$).pipe(
        filter((s: any) => !s.pending && !s.stale),
        map((s: any) => s.data as Row[]),
      ),
      { default: [] as Row[] },
    )
    const visible$ = selector(() =>
      [...(settled$ as any).get()].sort((a: Row, b: Row) => a.id - b.id),
    ) as any

    const frames: { pending: boolean; count: number }[] = []
    function Combined() {
      const pending = use$(state$.pending) as boolean
      const list = use$(visible$) as Row[]
      frames.push({ pending, count: list.length })
      return <span data-testid="c">{String(pending)}:{list.length}</span>
    }

    render(<Combined />)
    expect(frames).toEqual([{ pending: false, count: 0 }]) // 1: mount

    // moment 2 — activation: only pending flips (settled$ gate holds books back)
    await waitFor(() => expect(screen.getByTestId('c').textContent).toBe('true:0'))
    expect(frames.length).toBe(2)

    // moment 3 — fulfillment: pending flips AND 1,000 books land, notified
    // through two different subscriptions (a child path node + a selector fed
    // via an Rx pipeline). Same Legend batch → same flush → ONE render.
    await act(async () => {
      resolvers.get('a')!(rows('a', 1000))
      await sleep(10)
    })
    expect(screen.getByTestId('c').textContent).toBe('false:1000')
    expect(frames.length).toBe(3) // exactly one render for the combined change

    // and the frame was consistent — never pending:false with the old empty
    // list, never pending:true with the new list
    expect(frames).toEqual([
      { pending: false, count: 0 },
      { pending: true, count: 0 },
      { pending: false, count: 1000 },
    ])
  })
})
