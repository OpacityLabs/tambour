/**
 * Storage contract for persisted atoms. Sync return values mean synchronous
 * hydration (MMKV — no flash of initial state); promises mean async hydration
 * (IndexedDB/AsyncStorage) with per-atom hydration status to gate on.
 */
export interface TambourStorage {
  getString(key: string): string | null | undefined | Promise<string | null | undefined>
  setString(key: string, value: string): void | Promise<unknown>
  remove(key: string): void | Promise<unknown>
}

/** Shape of react-native-mmkv's instance (duck-typed — no dependency).
 *  Deletion is `delete()` in react-native-mmkv v2/v3 — an earlier version
 *  of this type expected `remove()`, which no real instance has; the
 *  adapter now accepts either, preferring the real API. */
interface MMKVLike {
  getString(key: string): string | undefined
  set(key: string, value: string): void
  delete?(key: string): void
  remove?(key: string): void
}

/** Wrap a react-native-mmkv instance: `mmkvStorage(createMMKV())`. Fully
 *  synchronous — atoms hydrate during registration, no gate needed. */
export function mmkvStorage(mmkv: MMKVLike): TambourStorage {
  const del = (mmkv.delete ?? mmkv.remove)?.bind(mmkv)
  if (!del) {
    throw new Error('[tambour] mmkvStorage: instance has neither delete() nor remove()')
  }
  return {
    getString: key => mmkv.getString(key),
    setString: (key, value) => mmkv.set(key, value),
    remove: key => del(key),
  }
}

/** In-memory storage — tests and Storybook. `seed` primes stored values;
 *  `data` exposes the live map for assertions. */
export function memoryStorage(seed?: Record<string, string>): TambourStorage & {
  data: Map<string, string>
} {
  const data = new Map<string, string>(Object.entries(seed ?? {}))
  return {
    data,
    getString: key => data.get(key) ?? null,
    setString: (key, value) => { data.set(key, value) },
    remove: key => { data.delete(key) },
  }
}

/** Async wrapper around any storage — simulates AsyncStorage-style latency in
 *  tests so async hydration paths get exercised. */
export function asyncStorage(inner: TambourStorage): TambourStorage {
  return {
    getString: async key => inner.getString(key),
    setString: async (key, value) => inner.setString(key, value),
    remove: async key => inner.remove(key),
  }
}
