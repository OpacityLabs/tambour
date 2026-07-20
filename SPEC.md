# Tambour — Design Spec

A state management system for React and React Native, built on **Legend State**
primitives, with **Redux** supplying write discipline, **RxJS** supplying temporal
composition, and **Immer** supplying write ergonomics. None of them owns the state —
Legend does.

Successor to the original "Next-Gen Redux on Legend State" doc; this version reflects
the full design discussion (2026-07).

## Thesis

Legend State and RxJS are both "targeted rerender" technologies, but they target
different axes. Redux adds a third:

| Axis | Technology | What it controls |
|---|---|---|
| **Where** | Legend State | Spatial granularity — per-node subscriptions; only the component reading `cart$.total` re-renders |
| **When** | RxJS | Temporal granularity — which *moments* propagate (gating, debouncing, joining, distinctness) |
| **What** | Redux (as discipline) | Which transitions are legal, named, and auditable |

Legend alone gives you the first axis. It lacks the sophistication bigger projects
need — no audit trail, no write discipline, no temporal operators, no middleware, no
structured effect layer. Tambour adds the other two axes as thin roles on top of
Legend's observable tree, without giving up its performance.

## The seven primitives

| Primitive | Role | Sync/Async |
|---|---|---|
| `atom` | State registration: naming, devtools identity, persistence boundary | — |
| `selector` | Synchronous derivation: n deps → pure combiner | sync |
| `streamSelector` | Temporal derivation — an Rx pipeline landing in a Legend node | async |
| `update` | Named, declared, multi-atom write transition (Immer recipe → patches) | sync |
| `event` | Named, awaitable async command (always has a handler) | async |
| `streamEvent` | Typed payload source for pipelines (never has a handler) | fire → stream |
| `reaction` | State-triggered: deps → synchronous react (updates, event fires, or noop) | reactive |

Plus two symmetric bridges — one idea ("anything can become a stream"), two functions:

```ts
atomToStream(cart$.total)      // state node          → Observable<number>
eventToStream(searchInput)     // event / streamEvent → Observable<string> (payloads)
```

---

## Atoms

```ts
export const cart$ = atom('cart', { items: [] as Item[], total: 0, coupon: null })
```

The name is a real registration, not a comment: it is the devtools identity, the
persistence key, and the entry in a global registry (which powers reset and the log).
Every node underneath is independently observable — the atom is the unit of
*registration*, not of *reactivity*.

### Persistence: the atom IS the boundary

```ts
export const cart$ = atom('cart', initial, {
  persist: {
    storage: mmkvStorage,        // MMKV on RN (sync!), IndexedDB/localStorage on web
    version: 3,
    migrations: {
      2: v1 => ({ ...v1, coupon: null }),
      3: v2 => ({ ...v2, items: v2.items.map(withSku) }),
    },
  },
})
```

- Wraps Legend's persist plugins — we do not rebuild sync/persist.
- **Rule: if half an atom's state shouldn't persist, that's two atoms.** No
  include/exclude path configs, no sub-atom persistence customization — ever.
  Splitting is free because no other primitive cares about atom boundaries:
  updates span atoms atomically, selectors join across them invisibly.
- Migrations are a stepwise map (redux-persist style): each migration is written
  once against a shape you knew at the time, never edited again.

### Hydration

Async storage means an atom starts at its initial value and may be overwritten a
tick later. Hydration status is exposed via `hydrationOf(cart$)` (an observable —
`use$` it) and `await hydrated()` gates the app (the PersistGate replacement).
(Originally spec'd as `cart$.hydrated$`; changed to an accessor because
attaching properties to a Legend proxy would create a state child.) On RN,
prefer MMKV: hydration is synchronous and this concern disappears — verified:
with sync storage the atom is hydrated before `atom()` returns.

### Test reset

The registry makes this free: `resetAll()` restores every atom to its captured
initial value and clears the update log. `snapshot()` / `restore()` for
fixture-based tests.

`resetAll()` does NOT touch queries — their cache is module-level,
gc-governed state, so entries (data, staleness clocks) survive across tests.
Call `resetQueries()` beside it (added 2026-07-17 after the opacity-app
migration suite tripped this): every key starts virgin, no
ordering-of-tests constraints. `resetQueries(family)` scopes to one family.
Test helper only — a live subscriber's node detaches from the cache.

### Scoping

- **Code-splitting: zero API.** There is no central store shape to assemble (unlike
  Redux's `combineReducers`) — an atom in a lazy module registers when the module is
  first imported.
- **Multi-instance state** (three chat windows): `atomFamily(key => initial)` with
  the same keyed-cache + refCount-eviction lifecycle as selector families.
- No mount/unmount scope system. Explicit `dispose()` exists for rare manual cases.

---

## Selectors (sync)

`createSelector`-style: n dependencies (atoms, node paths, other selectors, even
stream selectors), then a combiner that receives **plain values**:

```ts
export const visibleTodos$ = selector(
  todos$.items, todoUi$.filter,
  (items, filter) =>
    filter === 'all' ? items : items.filter(t => (filter === 'done') === t.done)
)

// composes: selectors as deps of selectors
export const overdueCount$ = selector(
  visibleTodos$, clock$.today,
  (todos, today) => todos.filter(t => t.due && t.due < today).length
)
```

Backed by Legend computeds: lazy, glitch-free within a batch.

- **The combiner is a pure function of its inputs** — unit-testable with plain
  values, no store, no mocks. Dependencies are static and greppable, and there's
  no auto-tracking footgun where a conditional `.get()` silently changes the
  subscription set.
- **The thunk form is the escape hatch, not the default.** `selector(() => ...)`
  with Legend auto-tracking remains for genuinely dynamic dependencies (reading
  different atoms per branch). One-arg call = thunk; multiple = deps + combiner.
- **Types flow honestly through deps**: a `default`-less stream selector dep is
  `T | undefined` in the combiner's parameter — "not loaded yet" stays visible in
  the types.
- **Most reads need no selector at all.** `use$(cart$.items[3].name)` is already
  maximally targeted — Legend's granularity does the work. Selectors exist for
  *derivations* (computed values, joins), not access paths. Expect a handful per
  domain, not Redux's wall of them.
- **React Compiler apps MUST use `useNode`, the compiler-safe alias of
  `use$`** (found on-device 2026-07-17: the compiler and
  eslint-plugin-react-hooks detect hooks by /^use[A-Z0-9]/ — `$` fails, so
  components calling `use$` get memoized AROUND the call, hooks get skipped
  on re-render, and every screen crashes with hook-order errors at runtime.
  Headless bundles and non-React tests cannot catch it; the opacity gate
  pass did). Same function, exported from `tambour/react`; any
  /^use[A-Z0-9]/ import alias also works.
- **Families** are a factory (reselect-factory / Recoil style), with a keyed cache:

  ```ts
  export const todoById = selectorFamily((id: string) =>
    selector(todos$.items, items => items.find(t => t.id === id))
  )
  const todo = use$(todoById(id))   // same args → same cached node
  ```

  Entries evict by refCount when the last observer unsubscribes (with a short
  keep-alive grace so list re-renders don't thrash).
- **Output equality**: default is reference equality; opt-in comparator as a
  trailing option `selector(...deps, combiner, { equals: shallowEqual })` so
  structurally-equal recomputes don't notify.
- Known cost, accepted: listing deps is mild ceremony, and a listed-but-unread
  dep still triggers recompute — the same trade reselect users make knowingly.

## Stream selectors (async)

The "async selector" — the thing developers otherwise shove into sync selector
systems that require values to be present. A stream selector is a node that simply
*hasn't emitted yet*; emissions suppressed by the pipeline never touch React at all.

```ts
export const searchResults$ = streamSelector(
  eventToStream(searchInput).pipe(
    debounceTime(200),
    distinctUntilChanged(),
    switchMap(q => from(api.search(q))),
  ),
  { default: [] as Result[] },
)
```

Contract:

- **Lazy activation**: subscribes to its pipeline on first observer, refCounts,
  tears down after the last unsubscribes. Replays the latest value to new observers.
- **`default` is optional and changes the type.** Without it the node is
  `T | undefined` — the honest choice when "not loaded yet" is a state the UI must
  distinguish (e.g. combineLatest gating). With it, `undefined` is unrepresentable.
- **Errors don't kill the node**: the pipeline error goes to interceptors/log; the
  node holds its last value.
- **Emissions replace the node value wholesale.** Legend's default synced-update
  path *merges* keyed arrays — a shrinking emission (`[a,b,c,d] → [d]`) would
  corrupt the node to `[d,b,c,d]`. streamSelector pins `mode: 'set'`
  (found via the showcase app; regression in test/streamSelector.test.ts).
- Components consume it with the same `use$` as everything else — call sites never
  know whether a value is sync or temporal.

### The glitch rule

RxJS is not glitch-free: one `update()` writing `a$` and `b$` in a single batch
fires *separate* `onChange` events, so `combineLatest([atomToStream(a$),
atomToStream(b$)])` emits a torn intermediate.

**Combine in space with Legend, combine in time with Rx.** Join multiple atoms in a
synchronous `selector` (glitch-free via batching), then wrap that one node in a
stream for the temporal operators.

### The discipline rule

Default to `selector`; reach for `streamSelector` only when the derivation has a
temporal dimension (gating, debouncing, external sources, event streams, ordering).
Rx maximalism — routing trivially-sync derivations through pipelines — is the
failure mode of this architecture. This rule is lintable and teachable.

## Queries — EXPERIMENTAL (Phase 5 spike, API not frozen)

The third read primitive: `selector` (sync), `streamSelector` (temporal),
`query` (keyed remote). Decided in the async design dialog (2026-07); shipped
as a spike in `src/query.ts` gated on dogfooding before freeze.

```ts
export const libraryBooks = query('library/books',
  (q: string) => api.fetchBooks(q),
  { staleTime: 15_000, gcTime: 60_000, default: [] as Book[] })

// the node's value IS the result envelope — data and metadata travel together
const { data, pending } = use$(libraryBooks('austen'))  // observe = fetch if stale
const books = use$(libraryBooks('austen').data)         // data-only subscription
invalidate(libraryBooks)                                // or invalidate(libraryBooks(args))
```

- **Server data lives inside the tree; there is no second cache.** TanStack's
  *semantics* (dedupe, staleness, gc, invalidation) on tambour's *substrate*:
  one devtools timeline, atom-style persistence, selectors compose over query
  nodes for free. A TanStack-shaped app can still use TanStack beside us; we
  don't ship an adapter.
- **Pull-based.** Observing a key is what fetches it (missing or stale →
  fetch; fresh → serve cache). Nothing is "kicked off": dedupe falls out of
  node identity (same args → same node → one request), gc out of refCount
  eviction, stale-while-revalidate out of activation. Dynamic keys use the
  thunk selector (the sanctioned escape hatch).
- **The bright line** (what earns machinery vs. stays a recipe): identity,
  lifecycle, staleness, dedupe, invalidation, structural sharing are core.
  `enabled`, keep-previous (six-line temporal-gating recipe gating on
  `!pending && !stale` — see `test/query.test.ts`), pagination, suspense are
  recipes until dogfooding bleeds. Retry/timeout will share option vocabulary
  with `event`. Note: activation flips `pending` one microtask after
  observation; `stale` is the synchronous "not yet trustworthy" signal.
- **The envelope is the API**: a query node's value is `{ data, pending,
  stale, error, fetchedAt }`. Legend's granularity makes it free —
  `use$(node.data)` never re-renders on a `fetchedAt` bump — and because data
  and status are ONE node written in ONE batch, a torn frame (fresh data +
  `pending: true`) is structurally impossible. Refetches apply structural
  sharing (deep-equal payloads keep old references → zero data notifications).
  (Decided 2026-07-15, replacing an earlier `statusOf(queryNode)` accessor:
  the metadata should come back with the query, and consumers pick fields.)
  **Stale-while-error**: a failed REFETCH keeps the last good `data`
  alongside `error` (with `stale: true`, so the next activation retries);
  only a VIRGIN key holds the `default`. The TanStack-trained instinct
  expects data to reset on error — it doesn't, deliberately: the user keeps
  reading the last good list while the banner shows the failure.
  (Dogfood-tripped: the opacity migration's own suite asserted the reset.)
- **`statusOf` exists for command events only** — `statusOf(commandEvent)` →
  `{ pending, inFlight, error }` (exhaust-coalesced re-fires stay truthful;
  switch supersessions are not errors). Events need an accessor because a
  command has no node to carry metadata; queries do not.
- **Design-rule-1 amendment**: *user* writes go through `update`; *runtime*
  writes (hydration, stream emissions, query fulfillment) are system-named.
  Query fulfillment is the same write class streamSelector emissions already
  were — every state change still has a name on the timeline.
- **Keys are stable hashes of plain-data args** (decided 2026-07-16): the
  fetcher's signature IS the cache key — no separate queryKey artifact to
  drift out of sync with the fetch. Plain objects hash with sorted keys
  (property order can never split the cache); arrays keep their order;
  anything ambiguous (Date, Map/Set, functions, class instances, NaN) throws
  at the call site naming the query and the exact path. Accepted JSON
  equivalences: `{ a: undefined }` ≡ `{}`, array `undefined` ≡ `null`.
  Re-calling `family(args)` per render is the intended pattern (~µs hash →
  same node → stable use$ subscription); hot paths hoist the call into a
  selector.
- **Open items before freeze**: query-side fetch retry (the event
  retry/timeout vocabulary exists — see Events — and would wire into the
  fetch path if dogfooding demands), `refetchOn: ['focus','reconnect']` via
  an RN adapter (AppState/NetInfo → streamEvents), devtools entries for
  query lifecycle, and the streamSelector re-activation gap (mitigated for
  atomToStream-fed pipelines, which re-prime on subscribe — verified in
  `test/chain.test.ts`).

## Mutations — EXPERIMENTAL (API not frozen)

Decided in the mutation design dialog (2026-07-16). **No parallel command
layer**: a mutation IS an `event` — same timeline entry, `statusOf`,
`eventToStream` tap, concurrency policies, and every event option including
retry/timeout for free. `mutation()` is the batteries-included sugar so
status/completion/error are just there, and so mutation-specific behavior
has a non-breaking home if it ever earns more:

```ts
export const renameTodo = mutation('todos/rename',
  async (id: string, title: string) => { await api.renameTodo(id, title) },
  { invalidates: ([id]) => [todoList, todoDetail(id)] })

const { pending, success, error } = use$(renameTodo.status)  // carried metadata
await renameTodo('t1', 'buy milk')                           // plain typed async
```

- **Status is the event's status node, carried on the function.**
  `m.status` ≡ `statusOf(m)` (same node, asserted by identity in tests).
  `EventStatus` gained `success` for mutation-grade DX: false until the
  first fire (idle ≠ succeeded), cleared on each fire (a re-submit shows a
  spinner, not a stale checkmark), set only by a *winning* clean settle. A
  switch-superseded run touches neither `error` nor `success`, even if its
  handler completes anyway. Fire and settle each write all fields in one
  batch — a torn frame (`success && pending`) is structurally impossible
  (render-proof in `test/status-granularity.test.tsx`).
- **No `data` field on status.** TanStack puts the result on the mutation
  because it has no state layer to put it in; tambour does — results land
  in atoms via updates, or belong to the awaiting caller's promise. A
  per-declaration `data` slot would also be wrong under overlapping calls.
- **No concurrency default.** `'exhaust'` would coalesce a re-fire with
  DIFFERENT args into the first run's promise — silent arg loss for
  per-entity mutations (`deleteTodo(b)` swallowed by in-flight
  `deleteTodo(a)`). Plain by default; opt into `'exhaust'` per
  submit-shaped mutation.
- **`invalidates` wires settle → staleness**, three forms:
  `[family]` (every cached key), `[family(key)]` (one static key), and
  `([id]) => [todoList, todoDetail(id)]` — the callback receives the call's
  argument tuple (never the switch AbortSignal); destructure what you need.
  A tuple parameter, not spread: a spread callback using only a prefix of
  the args trips TS's rest-tuple variance check, and a prefix-signature
  union breaks contextual typing (probed; see `test/mutation.typecheck.ts`).
  Runs on success AND error settles (a failed request may have landed
  server-side; TanStack's onSettled guidance) — never for superseded runs,
  and under `retry`, exactly once on the FINAL settle, never per attempt
  (invalidation rides the event's internal settle seam, not the handler).
  Result-dependent targets stay in the handler, which holds the result.
  The function form answers *which keys*, never *whether* — conditional
  invalidation is control flow and lives in the handler.
- **No debounce/throttle options — the boundary is semantic.** An event
  call returns a promise; exhaust and switch have truthful answers for the
  caller (the shared in-flight promise; an abort). Debounce means "maybe
  later, maybe never" — no honest promise exists. Temporal shaping is
  stream semantics: fire a `streamEvent` per keystroke, `debounceTime` in
  the pipeline, call the mutation from the subscription (rule 5's division
  of labor). Exhaust already covers the common throttle want.
- **Optimistic updates are a recipe, not an API.** TanStack needs
  onMutate/context/onError because the wrapper owns the control flow;
  here the handler owns it, so the lifecycle is try/catch/finally:

  ```ts
  export const toggleTodo = mutation('todos/toggle', async (id: string) => {
    const undo = applyToggle(id)          // update() — optimistic, instant
    try { await api.toggleTodo(id) }
    catch (e) { undo(); throw e }         // rollback = apply the inverse
  }, { invalidates: ([id]) => [todoDetail(id)] })
  ```

  Powered by `update()` invocations returning a one-shot `Undo` thunk (see
  Updates). End-to-end test (instant flip → server 500 → exact rollback →
  truthful status) in `test/mutation.test.ts`.
- **The horizon that would earn more machinery**: offline mutation queues
  (TanStack's paused mutations) require *reified*, serializable mutations —
  a queue built on event + persisted atoms, behind this same `mutation()`
  name, if a real app ever needs it. Not before.

---

## Updates

### Declared, named, multi-atom

Updates are declared once and invoked as plain typed functions — never executed
in-place. The name is explicit; it is a **behavioral namespace, not a storage
address** (`checkout/complete` may exist with no checkout atom).

```ts
// checkout.updates.ts
export const completeCheckout = update(
  'checkout/complete',
  { cart: cart$, orders: orders$, user: user$ },      // declared write scope
  (d, payment: Payment) => {
    d.orders.list.push(makeOrder(d.cart.items, payment))
    d.cart.items = []
    d.cart.total = 0
    d.user.lastOrderAt = payment.at
  },
)

completeCheckout(payment)   // one call, atomic across all three atoms
```

- **Composability over silos.** This is the direct fix for Redux's architectural
  sin: one conceptual transition touching three slices forced scattered reducers,
  mega-slices, or non-atomic thunk sequences. Here, cohesion follows the
  *transition*, not the storage layout. Single-atom updates are the same signature
  with one key — no special case.
- **Payloads are recipe arguments** (multiple args allowed, tuple-inferred by TS —
  better than RTK's single `action.payload`).
- **Read-only participants**: `update(name, { writes: {...}, reads: { settings:
  settings$ } }, recipe)` — reads arrive as plain snapshots; no accidental writes,
  no needless proxying, truthful log.
- **Declared scope is tooling**: the log records `completeCheckout → wrote cart,
  orders, user`; "what can write to `orders$`?" is a grep across `*.updates.ts`.

### Mechanics: Immer patches → targeted sets

Build a composite snapshot `{ cart: cart$.peek(), ... }`, run `produceWithPatches`,
route each patch by `path[0]` to its atom, apply everything in one `batch()`. Legend
never sees the discarded `next` — updates stay surgical per-leaf; inverse patches
come free.

Known implementation requirements (validated in Phase 0):

- **`setAutoFreeze(false)` is mandatory.** Immer's structural sharing means freezing
  the result freezes shared subtrees of the base — i.e., Legend's internal raw data —
  silently breaking future `.set()` calls.
- **Array patches need dedicated handling.** Immer's `add` on an array index means
  *insert* (splice), not overwrite; truncation arrives as a `replace` on the `length`
  path; `remove` must splice. Verify Legend's `.delete()` semantics on array elements.
- **Structural array ops must replace the array (the identity promise,
  2026-07-20).** Identity-keyed React consumers (`useMemo` deps, `React.memo`
  props) assume Immer semantics: a changed array is a NEW array. The original
  append fast-path (Legend in-place `push`) broke that for additions only —
  removes replaced — so a `useMemo` over a raw array node went stale in one
  direction and healed in the other (the shine favorites bug: re-render fired,
  memo served stale output). Appends now build a fresh array like every other
  structural op; `atom(..., { fastAppends: true })` restores the in-place push
  per atom for measured hot paths (~100x on large keyed arrays), with the
  documented contract that fast atoms are consumed via selectors or inline,
  never identity-keyed memos. Boundary that stays: LEAF edits inside an item
  keep the containing array's identity — propagating identity upward would
  replace every ancestor and destroy targeted re-renders. Identity tracks
  structure, not content: memo on identity for add/remove, derive through a
  selector to react to item edits.
- **All-or-nothing for free**: patches are computed before anything applies, so a
  recipe that throws is a clean no-op. Updates are more transactional than they look.
- **Every invocation returns a one-shot `Undo` thunk** (added in the mutation
  dialog, 2026-07-16) — a closure over the invocation's inverse patches,
  ignorable in statement position. Calling it applies the inverse against
  *current* state as a named write (`<name>.undo`) through the normal
  batch + interceptor pipeline (patches/inverse swap roles — the undo's
  inverse is the redo), so rollbacks are on the timeline and causally
  attributed when called inside an event handler. Surgical by construction:
  later writes to *other* leaves survive a rollback (leaf-level
  last-writer-wins — the property snapshot-restore can't offer). One-shot
  because an insert's inverse is a remove, and removing twice eats a
  neighbor; a spent thunk warns and no-ops. This is the optimistic-update
  primitive (see Mutations).
- **Hot-path escape hatch**: Immer proxying is a per-frame tax at 60fps.
  Scoped updates (`update(name, { node: cart$.items[3] }, recipe)`) proxy only the
  subtree; `updateDirect` (raw batched sets, still named and logged) exists for
  drag/scroll/animation paths. Benchmark decides how loudly docs push this.
- **Drafts are proxies — deep-equality helpers throw on them.** lodash
  `isEqual` on a draft dies with a proxy-invariant TypeError (its
  `isPrototype` probe reads `constructor.prototype` through the proxy).
  Recipes that compare draft state against a payload must unwrap with
  immer's `current(draft)` first. (Dogfood-caught in the opacity
  migration's equality-guard recipe, Phase 2.)

### Undo: time travel is core, product undo is userland

- **Time travel (debugging)**: the runtime auto-records every update's inverse
  patches into a dev-mode ring buffer. Zero API, feeds devtools, off in prod.
- **Product undo (Ctrl+Z) ships no API.** The `after` interceptor already
  delivers inverse patches on every update, so an app that needs undo hand-rolls
  it in ~10 lines — push `{name, inverse}` in `after`, apply popped inverses to
  undo — and owns the UX decisions (grouping, scoping, depth) that no runtime can
  guess. A documented recipe, not a primitive. (Invocation-scoped rollback is
  different: that's the returned `Undo` thunk above — the caller undoing its
  own write, not an app-wide stack.)

### Interceptors (middleware, minus the ceremony)

Every write flows through a named update, so a flat interceptor list with two sync
phases replaces Redux's middleware composition:

```ts
addInterceptor({
  before: (name, args, scope) => { /* validate, gate; throw to veto (clean no-op) */ },
  after:  (name, args, patches, inverse) => { /* log, analytics, persist triggers */ },
})
```

Events surface their lifecycle on the same list: `onEventFire` (once per
LOGICAL run — exhaust-coalesced calls don't re-fire), `onEventError`, and
`onEventSettle` (added 2026-07-17: once per run on the FINAL outcome after
retries, with the superseded flag and the run's own args array —
reference-equal to onEventFire's, so fire/settle pair by identity across
overlapping runs). Settle is what makes an auto-span interceptor possible:
fire+error alone can't close a span on success. The opacity migration's
`telemetry-interceptor.ts` is the worked recipe — spans created AT settle
with a retroactive fire-time `startTime`, so streamEvents (which never
settle) can never leak an open span.

Devtools, audit logging, and undo machinery are all just interceptors.

---

## Events

Two primitives, mirroring the selector split: `event` for commands,
`streamEvent` for signals. Most effects are "a named async function that might
dispatch an update"; `event` is exactly that.

### `event` — a named, awaitable async command (always has a handler)

```ts
// checkout.events.ts
import { api } from '../api'
import { completeCheckout } from './checkout.updates'

export const submitCheckout = event('checkout/submit', async (payment: PaymentIntent) => {
  const order = await api.checkout(payment)
  completeCheckout(order)          // or noop
})

await submitCheckout(payment)      // just async/await
```

Calling an event **executes exactly the function you wrote** and returns its
promise — no dispatch table, no registration lookup, nothing deferred. Handlers
import their dependencies like any module; no injected context in the core (DI is
an opt-in pattern on top, if a team wants it). Options trail the handler, matching
the rest of the API: `event(name, handler, { concurrency: 'exhaust' })`.

#### What ties an event to the library (honestly: nothing forces it)

A vanilla async function that imports and calls updates is completely legal — its
writes are still named, logged, batched, atomic, and undoable. The system's
guarantees live at the **update** layer; Redux had one mandatory door (`dispatch`),
Tambour's mandatory door is `update`, and `event` is a service wrapper, not a
gate. Wrapping buys four things:

1. **Causal attribution** — the runtime tracks invocation context, so the log
   reads `event sync/now → update todos/mergeServer`. The same update called from
   a vanilla function is recorded but *parentless* in the timeline.
2. **The tap** — `eventToStream` for pipelines and analytics.
3. **Concurrency services** — `exhaust`/`switch` are annoying to hand-roll well.
4. **Error routing** — unawaited fires land in the interceptor log instead of
   unhandled-rejection limbo.

Rule of thumb: if an async flow writes state or deserves a place on the timeline,
make it an event; a one-line UI handler calling a single update needs no wrapper.

### `streamEvent` — a typed payload source for streams (never has a handler)

```ts
export const searchInput = streamEvent<string>('search/input')
searchInput('groc')      // fires the payload; returns void — nothing to await

export const searchResults$ = streamSelector(
  eventToStream(searchInput).pipe(debounceTime(200), switchMap(q => from(api.search(q)))),
)
```

Advanced pipelines mostly compose existing primitives: `eventToStream(event)` →
operators → `streamSelector`. A separate `epic()` registration is needed only for
pipelines ending in pure side effects (analytics batching, socket writes) rather
than state. Command `event`s also work with `eventToStream`, so a command can be
awaited by its caller *and* observed by a pipeline, neither knowing about the other.

### Options kept minimal

- **Concurrency is an optional flag on `event` only** (it's meaningless without a
  handler), not a required concept. Default: plain async — call twice, runs twice,
  nothing tracked. Opt-in: `'exhaust'` (double-submit protection; a re-fire returns
  the in-flight promise) and `'switch'` (supersede-and-abort, `switchMap`-style).
  With `'switch'`, the handler receives an `AbortSignal` as its **trailing
  parameter** — `async (id: string, signal: AbortSignal) => api.get(id, { signal })` —
  and the types only surface that parameter when a policy is set. No policy, no
  extra concepts.
- **Retry/timeout are event options** (built 2026-07-16): `retry` — a number
  (max retries; `retry: 3` → at most 4 attempts) or `(failureCount, error) =>
  boolean`; **default 0** — the runtime can't know a handler is idempotent, so
  repeating a server write is opt-in per event. `retryDelay` — ms or
  `(failureCount, error) => ms`; default exponential 1s, 2s, 4s… capped 30s.
  The exponential default suits REQUEST-shaped events; it is wrong for
  tight polls — on a 1s cadence it stretches a transient blip into ~7s of
  silence before the run fails. Poll-tick events set `retryDelay: 0` (or a
  small constant) per call site — opacity's submission poll is the worked
  example.
  `timeout` — per-ATTEMPT budget; a late attempt fails with `TimeoutError`
  (exported) and retries if allowed; the underlying work is not cancelled and
  is deliberately NOT wired to the switch AbortSignal, whose abort means
  supersession (silent), never failure. Retries are ONE logical run:
  `pending` spans attempts, `error`/`success` settle only on the final
  outcome, superseded runs never retry (not even out of backoff), and
  interceptors see only the final error. Query's fetch path may adopt the
  same vocabulary later if dogfooding demands.
- **Errors are runtime-handled too**: awaited calls reject normally; unawaited fires
  additionally route through interceptors/log so nothing vanishes into
  unhandled-rejection land.
- **`eventToStream` accepts both kinds.** `streamEvent` is its primary customer,
  but tapping a command `event` (analytics observing checkout fires) is legal too.
  A `streamEvent` also serves as a semantic trigger fired by reactions.

---

## Reactions

Same shape as selectors — n deps, then a react function receiving plain values:

```ts
const overLimit$ = selector(cart$.total, t => t > 100)

reaction('cart/freeShipping', overLimit$, over => {
  if (over) applyFreeShipping()          // an update, an event fire, or a noop
}, { immediate: true })
```

- **Deps-then-react, like `selector`.** Deps are atoms, node paths, or (most
  usefully) selectors. The react function fires when dep values change.
- **Edge-triggering is composition, not a feature.** A boolean selector only
  notifies when its output flips (output equality), so a reaction watching it
  fires exactly on transitions. No special condition form exists.
- **Reactions are synchronous.** The react function may call updates directly,
  fire events, or do nothing — but no `await` in its body. Async work belongs in
  an event handler, where naming, error routing, and concurrency live. (Updates
  are named and interceptor-logged, so `reaction → update` is fully traceable
  without a ceremonial event in between.)
- **Initial run is opt-in.** Default fires on change only; `{ immediate: true }`
  evaluates against current state at registration — the hydration case (state
  already satisfies the condition at startup), made explicit.
- **Loop protection is machinery, not advice — and it circuit-breaks, never
  throws.** A reaction→update→reaction loop is synchronous (it can't yield to
  the microtask queue), so the runtime counts reaction runs per synchronous
  task; past a threshold it *skips* further runs so the cascade dies out, and
  reports once per burst via console.error + the `onReactionLoop` interceptor
  with the recent chain (`r/chaseA → r/chaseB → …`). It deliberately does not
  throw: Phase 1 verified empirically that an exception thrown through
  Legend's notification dispatch corrupts its internal state (observers
  registered afterwards go dead).

---

## Design rules (non-negotiable)

1. **Writes happen only through declared, named updates.** Enforced at the type
   level: modules export updates/selectors/events; atoms leave modules typed as
   `ReadonlyObservable<T>` (no `set`/`delete`/`assign`). Lint rule as backstop.
2. **Updates are synchronous and all-or-nothing.** Recipes that throw are no-ops.
3. **One `batch()` per update invocation** — multi-atom transitions are atomic to
   subscribers; dependent selectors recompute once.
4. **Reactions are synchronous** — they may call updates or fire events, never
   `await`; async work lives in event handlers.
5. **Combine in space with Legend, in time with Rx** (the glitch rule).
6. **Default to `selector`; `streamSelector` only for temporal derivations.**
7. **The atom is the persistence boundary.** Session-only state lives in its own
   atom; no sub-atom persistence config exists.

## File conventions

Behavioral namespaces, decoupled from storage layout:

```
cart.atom.ts          // atom('cart', ...)
cart.selectors.ts     // derivations
cart.updates.ts       // update('cart/...') — write scopes may span other atoms
checkout.events.ts    // event('checkout/...') — may exist with no checkout atom
checkout.updates.ts
```

Lintable conventions: name prefix matches filename; "what writes to `orders$`?" is a
grep across `*.updates.ts` write scopes.

## Devtools

Accumulated by construction — every write is a named update with patches, every
async effect a named event, every reaction named and traceable to what it invoked —
so devtools is *an interceptor that forwards to a UI*:

1. **First step (days, not weeks): Redux DevTools Extension adapter.** Patches
   serialize cleanly into its action log; time travel works via inverse patches.
   (This speaks the browser extension's message protocol — no `redux` package
   involved. Redux is inspiration throughout this spec, never a dependency.)
2. **Later: custom three-panel view** — atom tree (state), update log (patches,
   write scopes), event/stream timeline — shaped by dogfooding feedback.

## Packaging

Monorepo: `@tambour/state` (core), `@tambour/state-react` (thin: re-exports
Legend's `use$`/`observer`, hydration gate, MMKV adapter), `@tambour/state-devtools`.

- `@legendapp/state` and `rxjs` are **peer dependencies** of core.
- `streamSelector` accepts anything Observable-shaped (`Symbol.observable` interop) —
  teams that never write a temporal pipeline never ship Rx.
- Pin the exact Legend version; wrap every Legend API we touch (containment against
  the single-maintainer / v3-beta churn risk).

## Build plan

**Phase 0 — spike (1–2 weeks, throwaway).** Prove the two invented pieces before
building on them:

1. Patch applier: `setAutoFreeze(false)`, full array-op handling, then
   property-tested — thousands of random recipes/shapes, asserting patch application
   deep-equals Immer's discarded `next`.
2. `streamSelector` on Legend v3: lazy activation via `linked`/`synced`, refCount
   teardown, `default` typing, confirm batch/glitch behavior.
3. Benchmark `update()` vs raw batched `.set()` on a real RN device — sizes the
   hot-path escape hatch story.
4. Pin Legend version; inventory the wrapped API surface.

**Phase 1 — core package, no React.** All seven primitives, registry, interceptors,
bridges, `resetAll`/`snapshot`. Fully typed (readonly public types, tuple-inferred
payloads). Testable in plain Node.

**Phase 2 — React/RN bindings.** Deliberately thin; Legend already did the hard
React work (fine-grained `useSyncExternalStore` integration).

**Phase 3 — devtools.** Redux DevTools adapter first; custom panels after dogfooding.

**Phase 4 — long tail, gated on porting one real feature.** Persistence/migrations
wrapper, event concurrency policies, lint rules, the undo recipe in docs. A real
slice with persistence + async pressure-tests the APIs before they freeze.

## Known risks

- **Legend State bus factor / v3 beta churn** — mitigated by pinning, wrapping, and
  keeping the touched surface small; a fork or swap stays contained.
- **Hot-path update cost** — largely retired in Phase 4. Phase 0/smoke-test data
  (see SPIKE-FINDINGS.md) showed Legend's keyed-array O(n) read-after-structural-
  write (3.4 ms/push @ 1k items on Hermes) dominating `update()`. Two shipped
  fixes: the **base cache** (reuse Immer's `next` as the next base, invalidated
  by a version counter any foreign write bumps) and the **shadow resolver**
  (patch application reads a plain-data shadow, never Legend). Node result:
  1k-item push went 510 µs → 30 µs. Scoped updates remain the belt-and-braces
  for per-frame paths. Appends default to identity-fresh `set` since 2026-07-20
  (the identity promise, see Mechanics) — the in-place push survives as the
  per-atom `fastAppends` opt-in for the large-keyed-array case.
- **Rx maximalism** — mitigated by rule 6, the lint rule, and `streamSelector` being
  the only sanctioned Rx→React path.
- **Convention decay** — the write-discipline and naming rules hold only if the type
  level enforces them from Phase 1; retrofitting `ReadonlyObservable` later is a
  breaking change.

## Naming note (from the original doc, still true)

Events are really *commands* (requests to do work). The patches updates emit are the
closest thing to event-sourcing "facts." This only matters if the system ever goes
event-sourced — at which point the vocabulary inverts, and the patch log is already
the foundation.
