// The search flow from the design dialog, end to end:
//
//   searchUi$.query  →  debouncedQuery$  →  libraryBooks(key)  →  visibleBooks$
//       (atom)         (temporal node)      (fetch if stale)       (sync sort)
//
// No reaction, no imperative fetch anywhere: queries are PULL-based —
// observing a key is what fetches it, and only if it's missing or stale.

import {
  atom,
  atomToStream,
  invalidate,
  query,
  selector,
  streamSelector,
  update,
} from 'concordia'
import { debounceTime, distinctUntilChanged, filter, map } from 'rxjs/operators'
import { fetchBooks, type Book } from '../api'

export const searchUi$ = atom('searchUi', {
  query: '',
  keepPrevious: true,
  sortBy: 'date' as 'date' | 'title',
})

export const setQuery = update('searchUi/setQuery', { ui: searchUi$ }, (d, q: string) => {
  d.ui.query = q
})
export const setSortBy = update('searchUi/setSortBy', { ui: searchUi$ }, (d, sortBy: 'date' | 'title') => {
  d.ui.sortBy = sortBy
})
export const toggleKeepPrevious = update('searchUi/toggleKeepPrevious', { ui: searchUi$ }, d => {
  d.ui.keepPrevious = !d.ui.keepPrevious
})

// Debouncing is temporal → streamSelector territory (never a reaction: rule 4).
// The debounced value is a real node — inspectable, observable by anything.
export const debouncedQuery$ = streamSelector(
  atomToStream(searchUi$.query).pipe(debounceTime(250), distinctUntilChanged()),
  { default: '' },
)

// The keyed remote read. Each distinct query string is its own cache entry:
// its own in-flight dedupe, its own staleness clock, its own gc lifecycle.
// Retype a recent search inside staleTime and NO request happens.
export const libraryBooks = query('library/books', fetchBooks, {
  staleTime: 15_000,
  gcTime: 60_000,
  default: [] as Book[],
})

// The query node's value IS the result envelope — data and metadata travel
// together: { data, pending, stale, error, fetchedAt }. This selector just
// picks the CURRENT key's envelope (dynamic keys need the thunk form — the
// spec's escape hatch). A component could equally use$(libraryBooks(q).data)
// for a data-only subscription.
export const searchState$ = selector(() => libraryBooks(debouncedQuery$.get()).get())

// Gate in time: the keepPrevious recipe. Unsettled frames are suppressed, so
// downstream holds the previous key's settled list while the next key is in
// flight. Gate on pending AND stale — `stale` is true synchronously on a
// virgin key, covering the microtask before `pending` flips.
const settledBooks$ = streamSelector(
  atomToStream(searchState$).pipe(
    filter(s => !s.pending && !s.stale),
    map(s => s.data),
  ),
  { default: [] as Book[] },
)

// The component reads ONE node: network call + client-side sort, composed.
export const visibleBooks$ = selector(() => {
  const source = searchUi$.keepPrevious.get() ? settledBooks$.get() : searchState$.get().data
  const sortBy = searchUi$.sortBy.get()
  return [...source].sort(
    sortBy === 'date' ? (a, b) => a.written - b.written : (a, b) => a.title.localeCompare(b.title),
  )
})

/** Mark every cached search stale; the active key refetches immediately. */
export const refetchBooks = () => invalidate(libraryBooks)
