import { addInterceptor, type UpdateRecord } from './interceptors'

export interface History {
  entries(): readonly UpdateRecord[]
  clear(): void
  dispose(): void
}

/**
 * Dev-mode ring buffer of update records (patches + inverse patches included).
 * This is the raw material for time travel and for the userland undo recipe:
 * applying an entry's inverse patches reverts that transition. Just an
 * interceptor — costs nothing unless created.
 */
export function recordHistory(limit = 200): History {
  const buffer: UpdateRecord[] = []
  const dispose = addInterceptor({
    after: record => {
      buffer.push(record)
      if (buffer.length > limit) buffer.shift()
    },
  })
  return {
    entries: () => buffer.slice(),
    clear: () => { buffer.length = 0 },
    dispose,
  }
}
