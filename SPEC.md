# Concordia — Design Spec

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
structured effect layer. Concordia adds the other two axes as thin roles on top of
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
tick later. Each persisted atom exposes `cart$.hydrated$` (an observable — `use$` it
or gate the app on `await store.hydrated()`). On RN, prefer MMKV: hydration is
synchronous and this concern disappears.

### Test reset

The registry makes this free: `resetAll()` restores every atom to its captured
initial value and clears the update log. `snapshot()` / `restore()` for
fixture-based tests.

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
- **All-or-nothing for free**: patches are computed before anything applies, so a
  recipe that throws is a clean no-op. Updates are more transactional than they look.
- **Hot-path escape hatch**: Immer proxying is a per-frame tax at 60fps.
  Scoped updates (`update(name, { node: cart$.items[3] }, recipe)`) proxy only the
  subtree; `updateDirect` (raw batched sets, still named and logged) exists for
  drag/scroll/animation paths. Benchmark decides how loudly docs push this.

### Undo: time travel is core, product undo is userland

- **Time travel (debugging)**: the runtime auto-records every update's inverse
  patches into a dev-mode ring buffer. Zero API, feeds devtools, off in prod.
- **Product undo (Ctrl+Z) ships no API.** The `after` interceptor already
  delivers inverse patches on every update, so an app that needs undo hand-rolls
  it in ~10 lines — push `{name, inverse}` in `after`, apply popped inverses to
  undo — and owns the UX decisions (grouping, scoping, depth) that no runtime can
  guess. A documented recipe, not a primitive.

### Interceptors (middleware, minus the ceremony)

Every write flows through a named update, so a flat interceptor list with two sync
phases replaces Redux's middleware composition:

```ts
addInterceptor({
  before: (name, args, scope) => { /* validate, gate; throw to veto (clean no-op) */ },
  after:  (name, args, patches, inverse) => { /* log, analytics, persist triggers */ },
})
```

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
Concordia's mandatory door is `update`, and `event` is a service wrapper, not a
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
- **Loop protection is machinery, not advice.** Dev mode tags update invocations
  originating from reactions and counts re-entries within a cascade; past a small
  depth it throws with the actual chain
  (`reaction 'shipping' → update 'cart/setShipping' → reaction 'shipping' → …`).
  Production gets a circuit-breaker that logs and bails.

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

Monorepo: `@concordia/state` (core), `@concordia/state-react` (thin: re-exports
Legend's `use$`/`observer`, hydration gate, MMKV adapter), `@concordia/state-devtools`.

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
- **Hot-path update cost** — Phase 0 data (see SPIKE-FINDINGS.md): Immer overhead
  on leaf writes is 1.1–1.4x (a non-issue; scoped updates reach parity). The real
  cost is Legend's keyed object arrays: O(n) read-after-structural-write (~277 µs
  @ 1k items), which `update()` pays via its base `peek()`. Mitigations: scoped
  updates for per-frame paths; a Phase 1 base-cache (reuse Immer's `next` as the
  next base) if RN-device numbers justify it.
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
