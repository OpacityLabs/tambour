import { describe, expect, it } from 'vitest'
import { mmkvStorage } from '../src/storage'

/** Minimal stand-in for a react-native-mmkv instance (real API: delete()). */
function fakeMMKV() {
  const data = new Map<string, string>()
  return {
    data,
    getString: (key: string) => data.get(key),
    set: (key: string, value: string) => { data.set(key, value) },
    delete(key: string) {
      // real MMKV methods are prototype-bound; verify we don't lose `this`
      if (this.data !== data) throw new Error('unbound this')
      data.delete(key)
    },
  }
}

describe('mmkvStorage adapter', () => {
  it('wraps the real react-native-mmkv API: getString/set/delete', () => {
    const mmkv = fakeMMKV()
    const storage = mmkvStorage(mmkv)

    storage.setString('k', 'v')
    expect(storage.getString('k')).toBe('v')
    storage.remove('k') // regression: adapter used to call mmkv.remove(), which doesn't exist
    expect(storage.getString('k')).toBeUndefined()
    expect(mmkv.data.size).toBe(0)
  })

  it('still accepts a remove()-shaped instance', () => {
    const data = new Map<string, string>()
    const storage = mmkvStorage({
      getString: k => data.get(k),
      set: (k, v) => { data.set(k, v) },
      remove: k => { data.delete(k) },
    })
    storage.setString('k', 'v')
    storage.remove('k')
    expect(data.size).toBe(0)
  })

  it('rejects an instance with no deletion method at wrap time, not first use', () => {
    expect(() => mmkvStorage({ getString: () => undefined, set: () => {} } as any))
      .toThrow(/neither delete\(\) nor remove\(\)/)
  })
})
