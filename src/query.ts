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
 *   - handles are inert: family(args) and its child paths (.data, .pending)
 *     are lazy references that never touch the entry — a module-level
 *     selector(q(args).data, ...) declaration cannot fetch; only
 *     get/peek/onChange resolve (and, when observed, activate) the entry
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
  node$: any // synced wrapper providing the activation lifecycle; public access goes through a lazyNode handle
  active: boolean
  inFlight: boolean
  invalidated: boolean // invalidated mid-flight → refetch on settle
  evictTimer: ReturnType<typeof setTimeout> | null
  fetch: () => void
}

interface FamilyRegistry {
  cache: Map<string, Entry>
  nodes: Map<string, object> // one lazy handle per key, evicted with its entry
}

const NODE_REF = new WeakMap<object, { cache: Map<string, Entry>; key: string }>()
const FAMILY_ENTRIES = new WeakMap<object, FamilyRegistry>()
// Iterable registry for resetQueries(). Strong references are fine: query
// families are module-level singletons — they never GC in real programs, and
// the test processes this exists for are short-lived anyway.
const ALL_FAMILIES = new Set<FamilyRegistry>()

/**
 * The public node is a lazy handle, not the synced observable itself. Legend
 * materializes a lazy synced parent on ANY property access (creating a child
 * node peeks the parent, and peeking activates: subscribe, fetch, the works),
 * so handing out the raw node meant `selector(q(args).data, ...)` at module
 * scope fetched at import time — and the momentary activation's unsubscribe
 * started the gc clock on a never-observed entry.
 *
 * The handle defers everything: property access builds more handles (identity-
 * stable via the children map), and only get/peek/onChange walk to the real
 * node. The walk re-resolves the entry through the family cache every time, so
 * a handle captured at module scope survives eviction — the next observation
 * rebuilds a virgin entry IN the cache, where invalidate(family) can see it,
 * instead of stranding an orphan that invalidation silently misses.
 *
 * Trade-offs (deliberate): a query node is a tambour node surface, not a raw
 * Legend observable — selector deps, use$/useValue, and onChange all route
 * through get()/onChange() and work unchanged, but passing one DIRECTLY to a
 * Legend API that wants an observable (Memo, raw Legend use$) is unsupported.
 * Envelope fields shadowed by Object.prototype names ('toString', 'valueOf')
 * are unreachable as child handles.
 */
function lazyNode(resolveRoot: () => any, path: string[] = []): any {
  const children = new Map<string, any>()
  const walk = () => path.reduce((node, key) => node[key], resolveRoot())
  const surface = {
    get: () => walk().get(),
    peek: () => walk().peek(),
    onChange: (cb: (e: { value: unknown }) => void) => walk().onChange(cb),
  }
  return new Proxy(surface, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop in target) return (target as any)[prop]
      let child = children.get(prop)
      if (!child) {
        child = lazyNode(resolveRoot, [...path, prop])
        children.set(prop, child)
      }
      return child
    },
  })
}

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
  const nodes = new Map<string, object>()

  const entryFor = (key: string, args: Args): Entry => {
    const hit = cache.get(key)
    if (hit) return hit

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
            entry.evictTimer = setTimeout(() => {
              cache.delete(key)
              nodes.delete(key)
            }, gcTime)
          }
        },
      }) as any,
    )

    cache.set(key, entry)
    return entry
  }

  const family = (...args: Args): ReadonlyNode<QueryResult<T | undefined>> => {
    const key = stableArgsKey(name, args)
    const hit = nodes.get(key)
    if (hit) return hit as ReadonlyNode<QueryResult<T | undefined>>
    const node: object = lazyNode(() => entryFor(key, args).node$)
    nodes.set(key, node)
    NODE_REF.set(node, { cache, key })
    return node as ReadonlyNode<QueryResult<T | undefined>>
  }

  Object.defineProperty(family, 'name', { value: name })
  const registry: FamilyRegistry = { cache, nodes }
  FAMILY_ENTRIES.set(family, registry)
  ALL_FAMILIES.add(registry)
  return family
}

/**
 * TEST HELPER — drop every cached query entry (all families, or one).
 *
 * `resetAll()` restores atoms but cannot touch queries: their cache is
 * module-level, gc-governed state, so entries (data, staleness clocks,
 * in-flight dedupe) leak across tests — the opacity-app migration suite
 * tripped exactly this, working around it with `invalidate(family)` in
 * beforeEach plus careful test ordering (invalidation keeps old data;
 * only a VIRGIN key holds the default). Call this next to `resetAll()`
 * instead: every key starts virgin, no ordering constraints.
 *
 * Not for app code: a handle held across the reset re-resolves — its next
 * get/peek/onChange builds a fresh (virgin) entry through the family cache —
 * but onChange subscriptions attached BEFORE the reset stay bound to the old
 * entry and never see the new one's writes. Between tests nothing is
 * subscribed, which is the point.
 */
export function resetQueries(family?: object): void {
  let families: Iterable<FamilyRegistry>
  if (family === undefined) {
    families = ALL_FAMILIES
  } else {
    const registry = FAMILY_ENTRIES.get(family)
    if (!registry) {
      throw new Error('[tambour] resetQueries: not a query family')
    }
    families = [registry]
  }
  for (const { cache, nodes } of families) {
    for (const entry of cache.values()) {
      if (entry.evictTimer) clearTimeout(entry.evictTimer)
    }
    cache.clear()
    nodes.clear()
  }
}

/**
 * Mark a query stale: `invalidate(family)` for every cached key, or
 * `invalidate(family(args))` for one. Active keys refetch immediately
 * (in-flight ones refetch again on settle); inactive keys keep their cached
 * value and refetch on next observation.
 */
export function invalidate(target: object): void {
  const registry = FAMILY_ENTRIES.get(target)
  const ref = registry ? undefined : NODE_REF.get(target)
  if (!registry && !ref) {
    throw new Error('[tambour] invalidate: not a query family or query node')
  }
  // A handle whose entry evicted (or was never built) has nothing to mark:
  // its next observation builds a virgin entry, which is stale by construction.
  const entries = registry
    ? [...registry.cache.values()]
    : ref!.cache.has(ref!.key)
      ? [ref!.cache.get(ref!.key)!]
      : []
  for (const entry of entries) {
    entry.invalidated = true
    entry.store$.stale.set(true)
    if (entry.active && !entry.inFlight) entry.fetch()
  }
}

// ---- key hashing ------------------------------------------------------------

/**
 * Stable, order-insensitive cache key for query args. Two rules:
 *
 * 1. Plain objects hash with SORTED keys, so `{ page: 1, filter: 'a' }` and
 *    `{ filter: 'a', page: 1 }` are the same entry — property order can never
 *    silently split the cache (arrays keep their order; order means something
 *    there).
 * 2. Anything that would hash ambiguously THROWS, naming the query and the
 *    path. Every Map/Set used to stringify to '{}' — all of them colliding on
 *    one cache entry, invisibly. The contract is: query args are plain data.
 *
 * Accepted JSON equivalences (deliberate, TanStack-compatible):
 * `{ a: undefined }` hashes like `{}`, and `undefined` in an array position
 * hashes like `null` — both mean "no value" at a call site.
 */
export function stableArgsKey(name: string, args: unknown[]): string {
  for (let i = 0; i < args.length; i++) assertPlainData(args[i], `args[${i}]`, name)
  return JSON.stringify(args, (_key, value) =>
    isPlainObject(value)
      ? Object.keys(value)
          .sort()
          .reduce<Record<string, unknown>>((sorted, k) => {
            sorted[k] = value[k]
            return sorted
          }, {})
      : value,
  )
}

function assertPlainData(value: unknown, path: string, name: string): void {
  if (value === null || value === undefined) return
  const t = typeof value
  if (t === 'string' || t === 'boolean') return
  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(
        `[tambour] query '${name}': argument at ${path} is ${String(value)}, which hashes ` +
          `ambiguously (JSON turns it into null). Use a finite number.`,
      )
    }
    return
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertPlainData(value[i], `${path}[${i}]`, name)
    return
  }
  if (isPlainObject(value)) {
    for (const k of Object.keys(value)) assertPlainData(value[k], `${path}.${k}`, name)
    return
  }
  const kind =
    t === 'object' ? ((value as object).constructor?.name ?? 'object') : t
  throw new Error(
    `[tambour] query '${name}': argument at ${path} is not plain data (got ${kind}). ` +
      `Query args must be strings, finite numbers, booleans, null, plain objects, or ` +
      `arrays — convert at the call site (e.g. a Date becomes date.toISOString()).`,
  )
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
