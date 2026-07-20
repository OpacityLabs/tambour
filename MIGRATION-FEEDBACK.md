# Tambour work items from the opacity-app migration

Final list (2026-07-17, ALL phases 0–9 code-complete — redux is out of
the app; on-device gates pending). Evidence lives in
`~/Programming/ddl/opacity-app/TAMBOUR-MIGRATION.md` phase annotations
and `src/__tests__/tambour/`. Ordered by cost of NOT doing it.

## Bugs / already fixed, needs commit

0. **`use$` is invisible to the React Compiler — THE gate-pass catch
   (2026-07-17).** Hook detection (compiler + eslint-plugin-react-hooks)
   requires /^use[A-Z0-9]/; `$` fails it, so under `reactCompiler: true`
   every component calling `use$` gets memoized AROUND the call, the hook
   is skipped on re-renders, and the screen crashes with "Should have a
   queue" hook-order errors. EVERY migrated opacity screen was broken
   on-device; nine phases of headless bundles and 96 bun tests could not
   see it — the first maestro run through VerificationHub did. Fix:
   `useNode` alias exported from tambour/react (same function,
   compiler-recognizable name; SPEC Selectors bullet documents the
   constraint); opacity's 16 React files renamed. Gate-pass evidence:
   passport + W9 paths crashed before, passed end-to-end after. FOLLOW-UP
   for docs/lint: consider deprecating `use$` in README examples for RN
   apps, since Expo enables the compiler by default going forward.

1. **`mmkvStorage` MMKVLike mismatch** — adapter expected `remove()`,
   react-native-mmkv v3's method is `delete()`. Fixed in `src/storage.ts` +
   `test/storage.test.ts` (Phase 0). Sitting UNCOMMITTED in this repo
   alongside the concordia→tambour rename — commit them.

## Docs (real confusion hit during the migration)

2. ~~**Stale-while-error envelope semantics.**~~ DONE 2026-07-17: SPEC
   Queries envelope bullet now names the semantic, the virgin-vs-refetch
   distinction, and the rationale; pinned app-side by an explicit
   stale-while-error test in `accounts-query.test.ts`.
3. ~~**Immer drafts vs deep-equality helpers.**~~ DONE 2026-07-17: SPEC
   Updates/Mechanics gained the constraint bullet (`current()` unwrap
   before comparing drafts).
4. ~~**RTK `isLoading` vs envelope `pending`.**~~ DONE 2026-07-17:
   MIGRATING.md written (repo root) — the full Redux→tambour guide
   distilled from opacity: mapping table, the four reorganization
   principles, the persistence-continuity recipe, and a "semantics that
   will surprise you" section carrying this delta plus stale-while-error,
   retryDelay-for-polls, isEqual-on-drafts, and the
   honest-concurrency-fixes-bugs-expect-deltas lesson.

## Test infrastructure

5. ~~**Query cache survives `resetAll()`.**~~ DONE 2026-07-17:
   `resetQueries(family?)` shipped (src/query.ts, exported; 3 tests in
   test/query.test.ts; SPEC Test-reset section updated). Dogfooded
   immediately: opacity's accounts-query suite dropped its
   invalidate-in-beforeEach workaround AND its virgin-key-first ordering
   constraint. Test helper only — live subscribers detach from the cache;
   documented.
6. ~~**Bun + RN consumer suites: `mock.module` patches AFTER hoisted
   imports.**~~ DONE 2026-07-17: TESTING.md written (repo root) — the
   consumer testing-recipes doc: reset discipline (resetAll +
   resetQueries), event patterns (status/exhaust-gate/switch/retry),
   subscription-layer notification counting, stream factories, query
   envelope activation, the bun preload-mock contract (this item), and
   the telemetry capture pattern.

## Features — evidence collected, decision pending

6. **`refetchOn: ['focus','reconnect']` RN adapter** (AppState/NetInfo →
   streamEvents). No regression in opacity (the RTK PoC never called
   `setupListeners`), so this never blocked — but any app that HAD focus
   refetch will notice. SPEC already lists it as an open item (Phase 6).
7. **`query` refetchInterval — VERDICT: recipe wins, close it.** Second
   data point in (Phase 8): the submission 1s poll ported as the same
   streamEvents + factory recipe as walletSession's, ~10 lines, testable
   at three layers (pollOnce, stream, terminal-stop). Decisive detail:
   NEITHER app poll was query-shaped — both are command loops with
   terminal outcomes (stop conditions, failure messages), which
   refetchInterval could not express. No option.
8. **`epic()` — teardown verdict: the interim IS the answer, for now.**
   Final count: three module-level `.subscribe` calls (walletSession poll,
   submission poll, the react-navigation linking subscriber) — every one a
   boot-time singleton that never unsubscribes and never needs teardown.
   `epic()` would add lifecycle machinery nothing here uses. Reopen only
   if a consumer needs subscriptions that START/STOP with app state.
8b. **Event retry/timeout — validated in production shape (Phase 8).**
   `pollSubmissionOnce` replaced fetchWithTimeout + AbortController +
   rxjs retry({count:3}) + exhaustMap with four option keys, 1:1.
   ~~Doc lesson~~ DONE 2026-07-17: SPEC's retry/timeout bullet now says
   the exponential default suits request-shaped events and tight polls
   set `retryDelay: 0` per call site, with opacity's submission poll as
   the worked example.
9. **`machined` atom recipe — VERDICT: defer.** Phase 5's hand-roll
   (`makeAccountFlows`) came to ~35 lines including both guard classes,
   needed zero library support, and every transition — legal or ignored —
   is a named update on the timeline for free. Two instances from one
   local factory is not demand; revisit only if a third domain wants the
   shape.
10. ~~**OTel-via-interceptor recipe.**~~ DONE 2026-07-17, with one API
    addition it forced: the interceptor list had `onEventFire`/`onEventError`
    but NO settle hook — fire+error cannot close a span on success. Added
    `onEventSettle(name, error, args, superseded)` (interceptors.ts +
    events.ts settle path, 6 tests): once per LOGICAL run on the final
    outcome, args reference-equal to onEventFire's (pairing key), contained
    dispatch. The recipe (opacity `services/telemetry-interceptor.ts`,
    6 tests) creates spans AT settle with retroactive fire-time startTime —
    streamEvents can't leak spans — with an EXPLICIT attr allowlist (args
    never auto-attach: MRZ/TINs travel through args) and a skip-list.
    Deleted 7 hand-rolled span blocks; KEPT 4 deliberately: three
    swallow-their-errors handlers (profile/sync, share/reportSuccess,
    share/cancel — a settle-driven span would mislabel failures as OK) and
    submission/pollOnce (1s cadence floods the exporter; terminal result
    span stays). Span names are now event names — dashboards keyed on the
    old dotted names need updating. FINDINGS for the recipe doc: auto-span
    covers wrap-shaped spans 1:1; swallowed-error and result-derived-attr
    spans are structurally outside the seam and should stay hand-rolled —
    the interceptor cannot and should not see inside a handler. Updates
    deliberately NOT spanned (sync, µs — devtools timeline already has
    them; OTel spans there are cost without insight).
11. **Query-side fetch retry — the ONE remaining watch item.** Event
    retry/timeout vocabulary exists and would wire into the fetch path.
    No demand through all nine phases — catalog fetches are cheap,
    stale-while-error holds last good data, and manual invalidate covers
    retry UX. Not doable work; reopen only when a consumer hits it.

## SPEC open items unchanged by the migration

- Devtools entries for query lifecycle.
- streamSelector re-activation gap (mitigated for atomToStream-fed
  pipelines, which re-prime on subscribe).
