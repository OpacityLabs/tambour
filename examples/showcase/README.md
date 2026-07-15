# concordia showcase

A runnable tour of every primitive, including the **experimental `query` spike**
(keyed remote reads: dedupe, staleness, invalidation, structural sharing,
`statusOf`).

```sh
cd examples/showcase
npm install
npm run dev
```

`concordia` is aliased straight to `../../src` (see `vite.config.ts`) — edit
library source and the app hot-reloads. React / Legend / RxJS / Immer resolve
from the repo root so there is exactly one instance of each.

## What to try

- **Search “austen”, then “tolstoy”, then “austen” again** within 15s — the
  second “austen” renders instantly with zero requests (console logs every
  real fetch). After 15s it still renders instantly, then revalidates in the
  background: stale-while-revalidate.
- **Toggle “hold previous results”** — that checkbox switches between the raw
  view (default flashes while a new key loads) and the six-line keepPrevious
  recipe (temporal gating via `streamSelector`).
- **Mash “pull from server”** — the event is `exhaust`-protected; `statusOf`
  drives the spinner and stays truthful through coalesced re-fires.
- **Check off every todo** — a boolean selector + reaction fire exactly on the
  all-done transition.
- **Reload the page** — todos persist (localStorage; the web analog of MMKV).
- **Open the Redux DevTools extension** — every update, event fire, and merge
  is a named entry on one timeline.
