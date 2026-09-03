# Testing tambour apps

Consumer-side recipes, distilled from the opacity-app suite (96 tests
across 10 files, bun; see that repo's `src/__tests__/tambour/`). Tambour's
own suite (vitest) covers the primitives; these patterns are for APP code
built on them.

## Reset discipline

Two calls in `beforeEach`, because they cover different state:

```ts
beforeEach(() => {
  resetAll();     // atoms → captured initial values, update log cleared
  resetQueries(); // query caches → every key virgin
});
```

`resetAll()` cannot touch queries — their cache is module-level,
gc-governed state, not registry state. Without `resetQueries()`, entries
(data, staleness clocks, in-flight dedupe) leak across tests and only a
VIRGIN key holds the `default` — which forces test-ordering constraints
you don't want to maintain. `resetQueries(family)` scopes to one family.

Kill live intervals too: a test that starts a polling stream stops it in
`afterEach` (fire the stop streamEvent), or a background timer ticks into
later tests.

## Events

**Status assertions** — settle is async; give it a tick:

```ts
await createWalletSession();
await sleep(5);
const s = createWalletSession.status.get();
expect(s.success).toBe(true);
expect(s.error).toBeUndefined();
```

**Exhaust coalescing** — a gate (externally-resolved promise) holds the
first run open; assert ONE underlying call:

```ts
let release!: () => void;
const gate = new Promise<void>(r => (release = r));
mockFetch.mockImplementation(async () => { await gate; return ok(); });

const first = readPassport();
const second = readPassport(); // coalesced
release();
await Promise.all([first, second]);
expect(mockFetch.mock.calls.length).toBe(1);
```

**Switch supersession** — the superseded run touches neither `error` nor
`success`, even if its handler completed. Pin it when porting a switchMap.

**Retry** — set `retryDelay: 0` in the event under test (or accept real
delays); assert attempt counts via the mock's call count, and that status
settles ONCE with the final outcome.

## Subscription-layer assertions

`onChange` counters prove the two guarantees renders depend on — batching
(one notification per atom per update, however many fields moved) and
equality guards (zero notifications for unchanged payloads):

```ts
let notifications = 0;
passport.onChange(() => notifications++);
landPassportData(data, encrypted); // two fields, one update
expect(notifications).toBe(1);
```

## Streams

Export the pipeline as a factory taking the interval; the module-level
`.subscribe()` uses the production default, tests use ~10ms:

```ts
const sub = createSubmissionPollingStream(10).subscribe();
try {
  startSubmissionPolling();
  await sleep(120);
  expect(submission.status.peek()).toBe("completed");
} finally {
  sub.unsubscribe();
}
```

Extract the per-tick work (`pollOnce`) as its own event so the branch
logic tests without a timer at all.

## Query envelopes

Activate by observing — attach `onChange`, read, then wait TWO ticks
(`pending` flips a microtask after observation; `stale` is the
synchronous signal):

```ts
const node = accountsQuery("professional");
const dispose = node.onChange(() => {});
try {
  expect(node.get().stale).toBe(true); // virgin, synchronously
  await tick(); await tick();
  expect(node.get().data).toEqual([...]);
} finally {
  dispose(); // always — leaked observers keep entries active
}
```

Worth pinning per app: keyed-cache isolation (each key its own fetch),
fresh-key-serves-cache (zero requests inside staleTime), the invalidation
loop (mutation settle → refetch, OTHER keys untouched), and
stale-while-error (failed refetch keeps last good data — see MIGRATING.md).

## Bun + React Native: the preload mock contract

Bun HOISTS imports above `mock.module` calls; mocks patch modules AFTER
they load. Two consequences:

1. **Native-touching modules must be mocked in the global preload**
   (`bunfig` → setup.ts), not per test file — a state module that imports
   one at top level (e.g. `services/navigation` →
   `@react-navigation/native` → react-native's module-scope reads) crashes
   during load, before any file-level mock applies. The preload's
   react-native mock must carry whatever the import graph reads at module
   scope (Platform, I18nManager, StyleSheet, Dimensions, components…) —
   grow it when a new import path appears; the error names the missing
   export.
2. **File-level `mock.module` still works as an OVERRIDE** — registering
   again swaps the implementation via live bindings. The pattern: preload
   provides the inert default; a test file that needs control re-registers
   with a `mock()` it can steer per test:

```ts
const mockChipRead = mock(async () => chipData());
mock.module("services/passport/passport-reader", () => ({
  readPassport: (...a: unknown[]) => mockChipRead(...a),
}));
// per test: mockChipRead.mockImplementation(...)
```

Mind file execution order for process-global effects (bun runs test files
sequentially in one process): interceptors installed by one file affect
later files unless uninstalled (`afterAll(off)`), and a re-registered
module mock stays active for everything after it.

## Telemetry

Capture spans by mocking the telemetry module at file level (override
pattern above) — record `startSpan` args plus a fake span's
`setStatus`/`recordException`/`end` calls, and assert on the records. No
exporter machinery in tests.
