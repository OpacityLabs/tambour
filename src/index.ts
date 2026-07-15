// concordia — public API

export {
  atom,
  atomNames,
  clearRegistry,
  hydrated,
  hydrationOf,
  resetAll,
  restore,
  snapshot,
  type AtomOptions,
} from './atom'
export type { PersistConfig } from './persist'
export { asyncStorage, memoryStorage, mmkvStorage, type ConcordiaStorage } from './storage'
export { selector, type SelectorOptions } from './selector'
export { selectorFamily, type FamilyOptions } from './selectorFamily'
export { streamSelector, type StreamSelectorOptions } from './streamSelector'
// EXPERIMENTAL — keyed remote-read primitive (spike; API not frozen).
// The query node's value IS the result envelope: { data, pending, stale,
// error, fetchedAt }. statusOf exists for command events only.
export { query, invalidate, type QueryOptions, type QueryResult } from './query'
export { statusOf } from './status'
export { type EventStatus } from './events'
export { update, type UpdateScope } from './update'
export {
  event,
  eventToStream,
  streamEvent,
  type CommandEvent,
  type EventOptions,
  type StreamEvent,
} from './events'
export { reaction, type ReactionOptions } from './reaction'
export { atomToStream } from './bridges'
export { addInterceptor, type Interceptor, type UpdateRecord } from './interceptors'
export { connectDevtools, type DevtoolsConnector, type DevtoolsOptions } from './devtools'
export { recordHistory, type History } from './history'
export type { Atom, ReadonlyNode, ReadonlyNodeBase } from './types'
