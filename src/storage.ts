/**
 * Storage contract for persisted atoms. Sync return values mean synchronous
 * hydration (MMKV — no flash of initial state); promises mean async hydration
 * (IndexedDB/AsyncStorage) with per-atom hydration status to gate on.
 */
export interface ConcordiaStorage {
  getString(key: string): string | null | undefined | Promise<string | null | undefined>
  setString(key: string, value: string): void | Promise<unknown>
  remove(key: string): void | Promise<unknown>
}

/** Shape of react-native-mmkv's instance (duck-typed — no dependency). */
interface MMKVLike {
  getString(key: string): string | undefined
  set(key: string, value: string): void
  remove(key: string): void
}

/** Wrap a react-native-mmkv instance: `mmkvStorage(createMMKV())`. Fully
 *  synchronous — atoms hydrate during registration, no gate needed. */
export function mmkvStorage(mmkv: MMKVLike): ConcordiaStorage {
  return {
    getString: key => mmkv.getString(key),
    setString: (key, value) => mmkv.set(key, value),
    remove: key => mmkv.remove(key),
  }
}

/** In-memory storage — tests and Storybook. `seed` primes stored values;
 *  `data` exposes the live map for assertions. */
export function memoryStorage(seed?: Record<string, string>): ConcordiaStorage & {
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
export function asyncStorage(inner: ConcordiaStorage): ConcordiaStorage {
  return {
    getString: async key => inner.getString(key),
    setString: async (key, value) => inner.setString(key, value),
    remove: async key => inner.remove(key),
  }
}
