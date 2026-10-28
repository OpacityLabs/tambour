import { afterEach, describe, expect, it, vi } from 'vitest'
import { observable } from '@legendapp/state'
import { Observable, Subject } from 'rxjs'
import { debounceTime, distinctUntilChanged, filter, map } from 'rxjs/operators'
import { atom, clearRegistry } from '../src/atom'
import { update } from '../src/update'
import { query } from '../src/query'
import { selector } from '../src/selector'
import { selectorFamily } from '../src/selectorFamily'
import { streamSelector } from '../src/streamSelector'
import { atomToStream } from '../src/bridges'

afterEach(() => clearRegistry())

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * The four integration seams under the query design (atom → debounced key →
 * keyed family node → derived selector), verified against EXISTING primitives
 * before src/query.ts builds on them.
 */

describe('seam 1: family node created inside a thunk evaluation is tracked', () => {
  it('propagates source changes through a node the thunk created on the fly', () => {
    const src = observable({ items: [1, 2, 3] }) as any
    const factoryCalls: number[] = []
    const scaled = selectorFamily((k: number) => {
      factoryCalls.push(k)
      return selector(src.items, (items: number[]) => items.map(i => i * k))
    })
    const key = observable(2) as any

    // dynamic dep: which family node we read depends on another node's value
    const out = selector(() => scaled(key.get()).get())

    const seen: number[][] = []
    out.onChange(({ value }: any) => seen.push(value))
    expect(out.get()).toEqual([2, 4, 6])
    expect(factoryCalls).toEqual([2])

    // change the SOURCE — the family node created mid-evaluation must be a
    // live dependency, not a one-shot read
    src.items.set([4, 5, 6])
    expect(out.get()).toEqual([8, 10, 12])
    expect(seen[seen.length - 1]).toEqual([8, 10, 12])

    // same key → same cached node; no duplicate factory run
    expect(factoryCalls).toEqual([2])
  })
})

describe('seam 2: observation propagates through derived selectors to the pipeline', () => {
  it('observing only the derived selector activates the streamSelector source', () => {
    const activated = vi.fn()
    const source = new Subject<string>()
    const wrapped = new Observable<string>(sub => {
      activated()
      const s = source.subscribe(sub)
      return () => s.unsubscribe()
    })
    const q = streamSelector(wrapped, { default: '' })
    const derived = selector(q, q => q.toUpperCase())

    expect(activated).not.toHaveBeenCalled()

    const seen: string[] = []
    derived.onChange(({ value }: any) => seen.push(value))
    derived.get()
    expect(activated).toHaveBeenCalledTimes(1) // activation reached the pipeline

    source.next('abc')
    expect(derived.get()).toBe('ABC')
    expect(seen[seen.length - 1]).toBe('ABC')
  })
})

describe('seam 3: refCount unwinds when a thunk switches family keys', () => {
  it('releases the old key node and evicts it after the grace period', async () => {
    const factoryCalls: number[] = []
    const fam = selectorFamily(
      (k: number) => {
        factoryCalls.push(k)
        return selector(() => k * 10)
      },
      { graceMs: 20 },
    )
    const key = observable(1) as any
    const out = selector(() => fam(key.get()).get())

    const dispose = out.onChange(() => {})
    expect(out.get()).toBe(10)
    expect(factoryCalls).toEqual([1])

    key.set(2) // the thunk re-tracks: fam(2) in, fam(1) out
    expect(out.get()).toBe(20)
    expect(factoryCalls).toEqual([1, 2])

    await sleep(60) // > graceMs, plus Legend's async deactivation

    // key 1 must be evicted: asking for it again re-runs the factory
    fam(1)
    expect(factoryCalls).toEqual([1, 2, 1])

    // key 2 is still observed: cached, no new factory run
    fam(2)
    expect(factoryCalls).toEqual([1, 2, 1])

    dispose()
  })
})

describe('seam 4: the re-activation gap, and atomToStream self-healing', () => {
  it('a pipeline fed by atomToStream re-primes itself with the current upstream value', async () => {
    const query = observable('a') as any
    const debounced = streamSelector(
      atomToStream<string>(query).pipe(debounceTime(10), distinctUntilChanged()),
      { default: '' },
    )

    let dispose = debounced.onChange(() => {})
    debounced.get()
    await sleep(30)
    expect(debounced.peek()).toBe('a')

    dispose() // "unmount": last observer leaves
    await sleep(20) // Legend deactivation is async

    query.set('b') // upstream changes during the gap — nothing is listening

    dispose = debounced.onChange(() => {}) // "remount"
    expect(debounced.get()).toBe('a') // stale immediately after re-observe

    // atomToStream emits peek() on subscribe, so re-activation re-primes the
    // pipeline from CURRENT upstream state — the gap self-heals after debounce
    await sleep(50)
    expect(debounced.peek()).toBe('b')
    dispose()
  })
})

describe('the assembled chain: keyed async family behind a switching thunk', () => {
  // The closest existing-primitives approximation of the query design:
  // selectorFamily wrapping a streamSelector whose source is a fake fetch.
  it('fetches per key, dedupes by node identity, and late responses land in their own key', async () => {
    const fetches: string[] = []
    const respond = new Map<string, (books: string[]) => void>()
    const fakeFetch = (q: string) =>
      new Observable<string[]>(sub => {
        fetches.push(q)
        respond.set(q, books => { sub.next(books) })
        return () => respond.delete(q)
      })

    const books = selectorFamily(
      (q: string) => streamSelector(fakeFetch(q), { default: [] as string[] }),
      { graceMs: 30 },
    )
    const key = observable('austen') as any
    const sorted = selector(() => [...books(key.get()).get()].sort())

    const dispose = sorted.onChange(() => {})
    expect(sorted.get()).toEqual([])
    await sleep(10)
    expect(fetches).toEqual(['austen']) // observation triggered exactly one fetch

    respond.get('austen')!(['Persuasion', 'Emma'])
    expect(sorted.get()).toEqual(['Emma', 'Persuasion'])

    key.set('tolstoy') // switch keys mid-flight of nothing; austen already settled
    expect(sorted.get()).toEqual([]) // new key: default until it resolves
    await sleep(10)
    expect(fetches).toEqual(['austen', 'tolstoy'])

    // late/slow response for the OLD key: its node may already be evicted, but
    // it must never clobber the current key's view
    respond.get('austen')?.(['Northanger Abbey'])
    respond.get('tolstoy')!(['War and Peace'])
    expect(sorted.get()).toEqual(['War and Peace'])

    dispose()
  })

  // The showcase app's exact wiring, end to end. This is the test that caught
  // the streamSelector keyed-array merge corruption — every layer passed in
  // isolation; only the assembled chain (settled re-landing a query node's
  // raw rows through a stream emission, then shrinking) exposed it.
  it('the full books flow: atom → debounce → keyed query → keepPrevious gate → sort', async () => {
    interface Book { id: string; title: string; written: number }
    const LIBRARY: Book[] = [
      { id: 'b01', title: 'P&P', written: 1813 },
      { id: 'b02', title: 'Emma', written: 1815 },
      { id: 'b07', title: 'Lighthouse', written: 1927 },
      { id: 'b08', title: 'Animal Farm', written: 1945 },
    ]
    // rows are SHARED references across keys' results, like a real fake-api
    const fetchBooks = async (q: string): Promise<Book[]> => {
      await sleep(30)
      const needle = q.trim().toLowerCase()
      return LIBRARY.filter(b => !needle || b.title.toLowerCase().includes(needle))
    }

    const searchUi = atom('chain/searchUi', { query: '', keepPrevious: true })
    const setQuery = update('chain/setQuery', { ui: searchUi }, (d, q: string) => {
      d.ui.query = q
    })
    const debounced = streamSelector(
      atomToStream(searchUi.query).pipe(debounceTime(15), distinctUntilChanged()),
      { default: '' },
    )
    const books = query('chain/books', fetchBooks, {
      staleTime: 15_000,
      default: [] as Book[],
    })
    // the envelope IS the join: data + status arrive as one node value
    const state = selector(() => (books(debounced.get()) as any).get())
    const settled = streamSelector(
      atomToStream(state as any).pipe(
        filter((s: any) => !s.pending && !s.stale), // stale covers the pre-pending microtask gap
        map((s: any) => s.data as Book[]),
      ),
      { default: [] as Book[] },
    )
    const visible = selector(() => {
      const source = (searchUi as any).keepPrevious.get()
        ? (settled as any).get()
        : (state as any).get().data
      return [...source].sort((a: Book, b: Book) => a.written - b.written)
    }) as any

    const dispose = visible.onChange(() => {})
    visible.get()
    await sleep(120) // '' key settles: the full shelf
    expect(visible.get().map((b: Book) => b.id)).toEqual(['b01', 'b02', 'b07', 'b08'])

    for (const q of ['a', 'an', 'ani', 'anim']) {
      setQuery(q)
      await sleep(5)
    }
    // mid-flight (debounce landed, fetch pending): keepPrevious holds the shelf
    await sleep(30)
    expect(visible.get().map((b: Book) => b.id)).toEqual(['b01', 'b02', 'b07', 'b08'])

    await sleep(120) // 'anim' settles
    expect(visible.get().map((b: Book) => b.id)).toEqual(['b08'])

    dispose()
  })
})
