# Migrating from Redux

Distilled from two real migrations: breath (small, landed) and opacity-app
(13 store keys, RTK + redux-observable + redux-persist + RTK Query + an
xstate bridge — 9 phases, fully annotated in that repo's
TAMBOUR-MIGRATION.md). Read SPEC.md first; this is process and pitfalls,
not API.

## The mapping

| Redux | Tambour |
|---|---|
| Slice | `atom` (persisted: `{ persist: { storage } }`) |
| Reducer action | named `update` (multi-atom where a flow spans slices) |
| Epic, request/response | `event` handler — straight-line async; `switchMap` → `'switch'`, init/submit guards → `'exhaust'` |
| Epic, server write consumed by a screen | `mutation` — carried `.status` replaces the slice's status fields; `invalidates` where a query depends on the write |
| Epic, polling loop | streamEvents + `interval` pipeline (recipe below) |
| Epic chain (A-success → B) | sequential code in ONE handler |
| Selector (field read) | direct node read: `useValue(profile.profile)` |
| `createSelector` | `selector()` |
| RTK Query endpoint | `query()` family — keyed envelope, `invalidate()` |
| redux-persist | per-atom persist + the legacy-import recipe below |
| xstate bridge | atom + guarded named updates (opacity's `makeAccountFlows`: ~35 lines replaced ~500 of bridge machinery) |
| Debug hydrate actions | `<domain>/load` updates, or registry `snapshot()`/`restore()` |

Coexistence needs no adapter layer: tambour primitives are plain importable
functions, so an epic can call an update and a screen can read both stores
mid-migration. Migrate slice by slice; a slice leaves the root reducer the
moment its last consumer moves.

## Reorganize — do NOT port 1:1

The audit principles that shaped every opacity phase, in force order:

1. **Status bookkeeping doesn't migrate.** `isLoading`/`error`/`isFetching`
   fields exist because Redux has no command layer. They become
   the event's carried `.status` node, or the query
   envelope — never atom fields. (One legitimate exception found in nine
   phases: a lifecycle that spans TWO commands — opacity's submission
   status covers submit + poll — keeps a domain status field.)
2. **The atom is the persistence boundary.** Split slices that mix
   persisted and session state; don't persist what has a runtime source of
   truth.
3. **Dead fields die at the border.** Audit reads AND writes before
   porting: opacity found reset actions with zero call sites, fields
   written but never read, whole slices that were pure storage, event
   ARGUMENTS stored as state (nothing read them back), and
   machine `state` values derivable from other fields. Roughly a third of
   the redux surface never made the trip.
4. **Secrets stay out of the tree.** Tokens are time-of-use capabilities:
   fetch them per request inside handlers (an `authorizedFetch` helper),
   never snapshot them into nodes where they age silently and leak into
   devtools/debug exports.

## Persistence continuity

redux-persist stores everything under ONE key (`persist:root`); tambour
persists per-atom keys. The recipe, proven on encrypted MMKV:

1. The atom registers with the SAME storage instance.
2. A one-time legacy import runs at module init, BEFORE atom registration:
   if tambour's key is absent and `persist:root` exists, parse the slice
   field, reshape it (`map` drops dead fields), seed tambour's envelope.
   Never delete `persist:root` — it is the rollback path; keep it one
   release past teardown.
3. Module order is load-bearing: the state barrel must be imported before
   anything that triggers redux-persist's first flush, which rewrites the
   envelope WITHOUT de-whitelisted slices.

Rollback caveat to accept knowingly: once a slice leaves the whitelist,
one migrated boot makes the tambour copy authoritative — rolling back to a
pre-migration build loses that slice's redux copy.

Verify on a device UPGRADED over an existing install. This class of bug
does not reproduce in tests.

## Semantics that will surprise a Redux/TanStack instinct

Every one of these bit the opacity migration or its test suite:

- **RTK Query `isLoading` vs envelope `pending`.** `isLoading` is
  first-load-only; `pending` covers background refetches too. Gate
  spinners on EMPTY DATA, not on `pending`, or every invalidation flashes
  a spinner over a populated list.
- **Stale-while-error.** A failed REFETCH keeps the last good `data`
  alongside `error`; only a virgin key holds the `default`. Data does not
  reset on error.
- **`retryDelay`'s exponential default is for request-shaped events.** On
  a tight poll it stretches a transient blip into seconds of silence —
  poll-tick events set `retryDelay: 0` per call site.
- **lodash `isEqual` throws on Immer drafts** (proxy invariant). Unwrap
  with `current(draft)` before comparing inside recipes.
- **Array identity tracks structure, not content.** Add/remove on an array
  gives it a new identity (Immer instinct holds — `useMemo` keyed on the
  array recomputes), but a leaf edit INSIDE an item does not: Legend
  mutates in place and notifies subscribers instead of propagating fresh
  references upward. A `useMemo`/`React.memo` keyed on a raw array node
  will re-render past an item edit without recomputing. Derivations that
  must react to item edits go in a `selector` (recomputes on any tracked
  change, returns fresh output; add `equals` if memoized children consume
  it). And if an atom opts into `fastAppends`, additions stop changing
  identity too — fast atoms are selector-or-inline only.
- **`'switch'`/`'exhaust'` are BETTER-defined than what they replace —
  expect behavior deltas and write them down.** Redux concurrency was
  often accidental: opacity found a switchMap cancelling native work while
  its state machine ignored the restart (desync), and a debounce racing a
  same-tick reset so a cancel request never fired in production. Porting
  to honest semantics FIXES such bugs — which is a behavior change to
  flag, not silently ship.

## What a migration actually is

An audit with a deliverable. Opacity's found four production bugs
(lost-cancel race, a forever-ticking poll timer whose stop action nothing
dispatched, a stale-closure payload builder, the switchMap/machine
desync) and deleted the accidental complexity around them. Process that
made that stick:

- **Phase per slice**, smallest persisted slice first (proves the
  continuity recipe at lowest stakes), hottest screen last (everything it
  reads is an atom by then), teardown as its own phase.
- **Gates per phase**: unit tests green, typecheck clean, headless bundle
  builds, on-device smoke of the migrated screens. Code-complete is not
  done.
- **Annotate the plan file per phase** — what landed, what died at the
  border, what DEVIATED from the plan and why. The annotations are the
  audit trail and the next migration's evidence.
- **Keep a feedback file for tambour itself** — every confusion, gap, and
  verdict, ordered by cost. This guide is largely that file, promoted.
