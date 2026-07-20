# Phase 0 Spike — Findings

**Verdict: green light for Phase 1.** Both invented pieces (Immer patch bridge,
`streamSelector`) validated against real dependencies. One meaningful performance
characteristic discovered and mitigated. Pinned: `@legendapp/state@3.0.0-beta.47`,
`immer@11.1.11`, `rxjs@7.8.2`, Node v23.

## 1. Patch applier — correct

33 tests green, including:

- **Property test**: 500 runs of arbitrary mutation sequences (1–25 steps over
  nested objects, keyed object arrays, records) — applying emitted patches to a
  Legend observable is deep-equal to Immer's discarded `next`, every time.
- **Inverse patches**: 300 runs — applying forward then inverse patches restores
  the exact initial state. Time travel / undo recipes are sound.
- **Transactionality**: a throwing recipe is a clean no-op (patches are computed
  before anything applies) — confirmed across multiple atoms.
- **Freeze safety**: `setAutoFreeze(false)` is load-bearing, as predicted.
  Verified that targeted sets on structurally-shared subtrees keep working after
  an update. (Without it, Immer 11 freezes shared subtrees = Legend internals.)
- **Array ops**: push/pop/shift/unshift/splice-insert/splice-remove/set-by-index/
  truncate-via-length/reverse/sort/filter-reassign all route correctly. Immer
  emits truncation as `replace` on the `length` path and appends as `add` at
  `index === length` — both special-cased.

## 2. The glitch rule — empirically confirmed

One `batch()` writing two atoms, observed two ways:

| Observation path | Emissions |
|---|---|
| `combineLatest([atomToStream(a$), atomToStream(b$)])` | `[11, **12**, 22]` — torn intermediate is real |
| sync Legend computed `() => a$.get() + b$.get()` | `[22]` — exactly one, glitch-free |

"Combine in space with Legend, combine in time with Rx" stays a design rule with
evidence attached.

## 3. streamSelector — Legend v3 `synced` does everything we need

- **Lazy activation**: the Rx pipeline is NOT subscribed until the node's first
  `get()`/`onChange` — verified with a subscription counter.
- **RefCount teardown**: disposing the last listener unsubscribes the pipeline —
  native `synced` behavior, no custom lifecycle machinery needed.
- **`default`**: present before first emission; type-narrows as spec'd.
- **Errors**: pipeline error logs and the node holds its last value; the node
  never dies.
- Follow-up for Phase 1: verify clean *re*-activation (observe → dispose →
  observe again) and behavior under React StrictMode double-mounting.

## 4. Benchmarks (Node, M-series; treat ratios as signal, re-run on RN device)

Leaf-touch updates — **Immer overhead is a non-issue**:

| Scenario | `update()` | direct `batch(set)` | overhead |
|---|---|---|---|
| small object (5 keys) | 0.88 µs | 0.63 µs | 1.4x |
| wide object (200 keys) | 0.87 µs | 0.71 µs | 1.2x |
| 1,000-item array, one item's field | 1.50 µs | 1.41 µs | 1.1x |
| same, update scoped to the item node | 0.88 µs | 0.93 µs | **parity** |

Structural array ops — the discovered cost, and it is **not Immer**:

- Naive whole-array `.set()` for appends was 285x slower than native push →
  fixed: `add` at `index === length` now uses Legend's `push`.
- Residual: **Legend's keyed object arrays cost O(n) to read after a structural
  write** (peek+push cycles: 159 µs @ 100 items, 277 µs @ 1k, 829 µs @ 5k).
  Plain-value arrays are flat O(1) (~2.6 µs at every size). This is the price of
  Legend's stable per-item observables (id-keyed diffing), and `update()` pays it
  because it peeks the atom to build the Immer base.
- Immer's own `produceWithPatches` on a 1k-item push: ~13 µs. Blameless.

**Mitigations**: (a) scoped updates (already at parity) for hot paths;
(b) Phase 1 candidate — a base cache in `update()`: reuse Immer's `next` as the
next base, invalidated by foreign writes via `onChange`, eliminating the
peek-after-write entirely. Decide after RN-device numbers.

Perspective: 277 µs per structural update on a 1k keyed list is irrelevant for
user-action frequency (~0.3 ms), and only matters in per-frame loops — which is
what scoped updates are for.

## 5. Legend API surface touched (the containment inventory)

`observable()`, `observable(fn)` (computed), `batch()`, node `.get()/.peek()/`
`.set()/.delete()/.push()`, `.onChange(cb)`, `synced({ initial, subscribe })`
from `@legendapp/state/sync`. Nothing else. Every use goes through `src/` wrappers.

Incidental: Legend warns on duplicate `id` fields in keyed arrays (surfaced by the
property test's generated data) — harmless here, but the docs should state that
object arrays want unique, stable `id`s to benefit from keyed optimization.

## Open for Phase 1

- ~~RN-device benchmark run~~ → done, see §6.
- ~~`streamSelector` re-activation + StrictMode probes~~ → done in Phases 1–2.
- Event causal-attribution strategy (context propagation without zones) →
  shipped sync-only in Phase 1.
- The base-cache optimization — **upgraded to "likely justified" by the
  Hermes numbers below** for apps doing structural writes on large keyed arrays.

## 6. React 19 + Hermes/RN 0.83 validation (2026-07-13)

**React 19.2.0 (jsdom):** full suite green, including a no-tearing probe of
store writes interleaved with `startTransition`. No peer or runtime warnings.

**On-device (shine `tambour-probe` branch, iPhone 17 Pro sim, Hermes, RN
0.83 New Arch, dev-mode JS):** vendored library ran alongside shine's live
Redux store. Verified interactively: targeted re-renders (6 updates to a
sibling row left the other at renders: 1), equals-selector, selectorFamily,
streamSelector interval pipeline, edge-triggered reaction firing an event
exactly once, resetAll.

| Scenario | Hermes | Node/V8 (Phase 0) |
|---|---|---|
| `update()` leaf write | 15.7 µs | 0.88 µs |
| direct `batch(set)` leaf write | 7.0 µs | 0.63 µs |
| `update()` on 1k-item atom | 36.9 µs | 1.5 µs |
| scoped `update()` (item node) | 15.3 µs | 0.88 µs |
| `update()` push on 1k keyed array | **3417 µs** | 487 µs |

Read: leaf-write overhead is ~2.3x direct (vs 1.4x on V8) and absolute costs
(~16 µs) are irrelevant for user-action frequency. The keyed-array
read-after-structural-write cost is ~7x worse on Hermes — **3.4 ms per push
on a 1k list** is dropped-frame territory if it ever happens during
animation. Scales roughly linearly (~0.34 ms at 100 items — fine). Guidance:
keep large keyed-array atoms out of per-frame paths, prefer scoped updates,
and prioritize the base-cache optimization in `update()` if a dogfooded app
(shine's history slice is the candidate) shows this in traces. Dev-mode JS —
release-mode numbers will be somewhat better.
