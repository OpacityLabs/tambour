// tambour — public API

export {
  atom,
  atomNames,
  clearRegistry,
  hydrated,
  hydrationOf,
  hydrationRecords,
  resetAll,
  restore,
  snapshot,
  type AtomOptions,
} from './atom'
export type { PersistConfig } from './persist'
export { asyncStorage, memoryStorage, mmkvStorage, type TambourStorage } from './storage'
export { selector, type SelectorOptions } from './selector'
export { selectorFamily, type FamilyOptions } from './selectorFamily'
export { streamSelector, type StreamSelectorOptions } from './streamSelector'
// EXPERIMENTAL — keyed remote-read primitive (spike; API not frozen).
// The query node's value IS the result envelope: { data, pending, stale,
// error, fetchedAt }. statusOf exists for command events only.
export { query, invalidate, resetQueries, type QueryOptions, type QueryResult } from './query'
// EXPERIMENTAL — a server write: an event whose status node rides on the
// function (m.status ≡ statusOf(m)) and whose settle invalidates queries.
export { mutation, type Mutation, type MutationOptions } from './mutation'
export { statusOf } from './status'
export { type EventStatus } from './events'
export { update, type UpdateScope, type Undo } from './update'
export {
  event,
  eventToStream,
  streamEvent,
  TimeoutError,
  type CommandEvent,
  type EventOptions,
  type StreamEvent,
} from './events'
export { reaction, type ReactionOptions } from './reaction'
export { atomToStream } from './bridges'
export {
  addInterceptor,
  type EventKind,
  type HydrationRecord,
  type Interceptor,
  type QueryFetchReason,
  type UpdateRecord,
} from './interceptors'
export { connectDevtools, type DevtoolsConnector, type DevtoolsOptions } from './devtools'
export { recordHistory, type History } from './history'
export {
  logInterceptor,
  type LogInterceptorOptions,
  type LoggerSink,
  type LogKind,
  type NameFilter,
} from './logger'
export type { Atom, ReadonlyNode, ReadonlyNodeBase } from './types'
