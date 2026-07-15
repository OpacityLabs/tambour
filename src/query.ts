import { batch, observable } from '@legendapp/state'
import { synced } from '@legendapp/state/sync'
import type { ReadonlyNode } from './types'

/**
 * EXPERIMENTAL — the keyed remote-read primitive (spike; API not frozen).
 *
 * The third read primitive: `selector` (sync), `streamSelector` (temporal),
 * `query` (keyed remote). A query is a family of nodes, one per args-key, each
 * fed by a fetcher and governed by policy:
 *
 *   - pull-based: OBSERVING a key is what fetches it (if missing or stale);
 *     nothing is ever "kicked off" imperatively
 *   - dedupe by construction: same args → same node → one in-flight request
 *   - stale-while-revalidate: a cached value is served synchronously; a stale
 *     one additionally refetches in the background
 *   - gcTime: an entry (and its cached value) survives unobserved for gcTime,
 *     then evicts
 *   - structural sharing: a refetch that returns deep-equal data keeps the old
 *     references, so downstream selectors and components don't re-fire
 *
 * The node's value is the RESULT ENVELOPE — data and metadata travel together:
 *
 *   const result = use$(libraryBooks('austen'))   // { data, pending, stale, error, fetchedAt }
 *   const books  = use$(libraryBooks('austen').data)      // data-only subscription
 *   const busy   = use$(libraryBooks('austen').pending)   // pending-only subscription
 *
 * Legend's per-node granularity makes the envelope free: subscribing to
 * `.data` never re-renders on a `fetchedAt` bump. Because data and status live
 * in ONE node written in ONE batch, a torn frame (fresh data + pending:true)
 * is structurally impossible.
 *
 * Scope guardrail (the bright line): identity, lifecycle, staleness, dedupe,
 * invalidation, structural sharing. Deliberately NOT here: retry/timeout
 * (event-vocabulary options, later), refetch-on-focus/reconnect triggers
 * (RN adapter, later), `enabled`, keep-previous, pagination (recipes until
 * dogfooding proves otherwise).
 */

export interface QueryOptions<T> {
  /** How long a fulfilled value counts as fresh, in ms. While fresh, observing
   *  serves the cache and does NOT fetch. Default 0 — always stale, i.e.
   *  every activation revalidates in the background (TanStack's default). */
  staleTime?: number
  /** How long an unobserved entry (including its cached value) survives before
   *  eviction, in ms. Default 5 minutes. */
  gcTime?: number
  /** `data` before the first fulfillment; like streamSelector, it changes the
   *  TYPE: without it `data` is honestly `T | undefined`. */
  default?: T
}

export interface QueryResult<T> {
  /** The last fulfilled value (or the `default` before first fulfillment). */
  data: T
  /** A fetch for this key is in flight. NOTE: activation kicks the fetch off
   *  one microtask after observation (writing state mid-tracked-read is
   *  unsafe), so there is a sub-millisecond gap where a virgin key is neither
   *  pending nor fulfilled. `stale` is the SYNCHRONOUS signal — it is true
   *  from construction — so gates like keepPrevious filter on
   *  `!pending && !stale`, not `!pending` alone. */
  pending: boolean
  /** Explicitly invalidated, errored, or never fetched. (Age-based staleness
   *  is evaluated at activation time, not ticked reactively.) */
  stale: boolean
  /** The last fetch's rejection, cleared by the next fulfillment. */
  error: unknown
  /** Epoch ms of the last fulfillment, undefined before the first. */
  fetchedAt: number | undefined
}

interface Entry {
  store$: any // observable<QueryResult> — one tree, so data+status can't tear
  node$: any // public node: synced wrapper providing the activation lifecycle
  active: boolean
  inFlight: boolean
  invalidated: boolean // invalidated mid-flight → refetch on settle
  evictTimer: ReturnType<typeof setTimeout> | null
  fetch: () => void
}

const NODE_ENTRY = new WeakMap<object, Entry>()
const FAMILY_ENTRIES = new WeakMap<object, Map<string, Entry>>()

export function query<Args extends unknown[], T>(
  name: string,
  fetcher: (...args: Args) => Promise<T>,
  options: QueryOptions<T> & { default: T },
): (...args: Args) => ReadonlyNode<QueryResult<T>>
export function query<Args extends unknown[], T>(
  name: string,
  fetcher: (...args: Args) => Promise<T>,
  options?: QueryOptions<T>,
): (...args: Args) => ReadonlyNode<QueryResult<T | undefined>>
export function query<Args extends unknown[], T>(
  name: string,
  fetcher: (...args: Args) => Promise<T>,
  options?: QueryOptions<T>,
): (...args: Args) => ReadonlyNode<QueryResult<T | undefined>> {
  const staleTime = options?.staleTime ?? 0
  const gcTime = options?.gcTime ?? 5 * 60_000
  const cache = new Map<string, Entry>()

  const family = (...args: Args): ReadonlyNode<QueryResult<T | undefined>> => {
    const key = JSON.stringify(args) // spike keying; structural-key design is a tracked open item
    const hit = cache.get(key)
    if (hit) return hit.node$

    const store$ = observable({
      data: options?.default as T | undefined,
      pending: false,
      stale: true,
      error: undefined as unknown,
      fetchedAt: undefined as number | undefined,
    }) as any

    const entry: Entry = {
      store$,
      node$: undefined,
      active: false,
      inFlight: false,
      invalidated: false,
      evictTimer: null,
      fetch: () => doFetch(),
    }

    const doFetch = (): void => {
      if (entry.inFlight) return // dedupe: one request per key at a time
      entry.inFlight = true
      entry.invalidated = false
      store$.pending.set(true)
      fetcher(...args).then(
        result => {
          entry.inFlight = false
          // structural sharing: deep-equal subtrees keep their old references,
          // so an unchanged payload produces zero data notifications
          const shared = replaceEqualDeep(store$.data.peek(), result)
          batch(() => {
            store$.data.set(shared)
            store$.assign({
              pending: false,
              stale: false,
              error: undefined,
              fetchedAt: Date.now(),
            })
          })
          settle()
        },
        error => {
          entry.inFlight = false
          // hold the last data; stale stays true so the next activation retries
          batch(() => {
            store$.assign({ pending: false, stale: true, error })
          })
          settle()
        },
      )
    }

    const settle = (): void => {
      if (entry.invalidated && entry.active) doFetch()
    }

    const revalidateIfStale = (): void => {
      if (!entry.active || entry.inFlight) return
      const fetchedAt = store$.fetchedAt.peek()
      const fresh =
        !entry.invalidated &&
        fetchedAt !== undefined &&
        Date.now() - fetchedAt <= staleTime &&
        store$.error.peek() === undefined
      if (!fresh) doFetch()
    }

    entry.node$ = observable(
      synced({
        // Shallow-copy is load-bearing: store$.get() returns Legend's raw
        // root, which Legend MUTATES IN PLACE on field writes — returning it
        // directly makes every recompute reference-equal to the last, so
        // change detection sees nothing and subscribers go permanently dark
        // (polling .get() would still work, hiding the bug). A fresh envelope
        // per recompute notifies correctly; `data` keeps its shared reference,
        // so data-only subscribers still skip no-op refetches.
        get: () => ({ ...store$.get() }),
        subscribe: () => {
          entry.active = true
          if (entry.evictTimer) {
            clearTimeout(entry.evictTimer)
            entry.evictTimer = null
          }
          // Activation happens during a tracked read (a component render or a
          // computed evaluation) — writing state there would be a write mid-
          // evaluation. Defer the staleness check one microtask.
          queueMicrotask(revalidateIfStale)
          return () => {
            entry.active = false
            entry.evictTimer = setTimeout(() => cache.delete(key), gcTime)
          }
        },
      }) as any,
    )

    cache.set(key, entry)
    NODE_ENTRY.set(entry.node$, entry)
    return entry.node$ as ReadonlyNode<QueryResult<T | undefined>>
  }

  Object.defineProperty(family, 'name', { value: name })
  FAMILY_ENTRIES.set(family, cache)
  return family
}

/**
 * Mark a query stale: `invalidate(family)` for every cached key, or
 * `invalidate(family(args))` for one. Active keys refetch immediately
 * (in-flight ones refetch again on settle); inactive keys keep their cached
 * value and refetch on next observation.
 */
export function invalidate(target: object): void {
  const familyCache = FAMILY_ENTRIES.get(target)
  const entries = familyCache
    ? [...familyCache.values()]
    : NODE_ENTRY.has(target)
      ? [NODE_ENTRY.get(target)!]
      : null
  if (!entries) {
    throw new Error('[concordia] invalidate: not a query family or query node')
  }
  for (const entry of entries) {
    entry.invalidated = true
    entry.store$.stale.set(true)
    if (entry.active && !entry.inFlight) entry.fetch()
  }
}

// ---- structural sharing ----------------------------------------------------

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)

/** TanStack-style replaceEqualDeep: return `a` wherever `b` is deep-equal to
 *  it, otherwise a copy of `b` that reuses every deep-equal child of `a`. */
export function replaceEqualDeep<T>(a: unknown, b: T): T {
  if (Object.is(a, b)) return a as T
  if (Array.isArray(a) && Array.isArray(b)) {
    let allEqual = a.length === b.length
    const out = b.map((item, i) => {
      const shared = replaceEqualDeep(a[i], item)
      if (shared !== a[i]) allEqual = false
      return shared
    })
    return (allEqual ? a : out) as T
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    let allEqual = aKeys.length === bKeys.length
    const out: Record<string, unknown> = {}
    for (const k of bKeys) {
      out[k] = replaceEqualDeep(a[k], (b as Record<string, unknown>)[k])
      if (out[k] !== a[k]) allEqual = false
    }
    return (allEqual ? a : out) as T
  }
  return b
}
