import { applyPatches as immerApplyPatches, produceWithPatches, type Patch } from 'immer'
import { batch } from '@legendapp/state'
import { applyPatches } from './applyPatches'
import { currentOrigin } from './context'
import { runAfter, runBefore } from './interceptors'

/** Rolls back one update invocation by applying its inverse patches — a
 *  named write (`<name>.undo`) through the normal interceptor pipeline.
 *  One-shot: replace-inverses would be idempotent, but an insert's inverse
 *  is a remove, and removing twice eats a neighbor — a spent thunk no-ops. */
export type Undo = () => void

type AtomMap = Record<string, any>

/** Scope: either a flat map of atoms (all writable) or `{ writes, reads }`.
 *  Read atoms appear on the draft for convenience, but any patch targeting one
 *  throws — an update's write scope is exactly what it declares. */
export type UpdateScope = AtomMap | { writes: AtomMap; reads?: AtomMap }

function splitScope(scope: UpdateScope): { writes: AtomMap; reads: AtomMap } {
  const maybe = scope as { writes?: AtomMap; reads?: AtomMap }
  if (maybe.writes && typeof (maybe.writes as any).peek !== 'function') {
    return { writes: maybe.writes, reads: maybe.reads ?? {} }
  }
  return { writes: scope as AtomMap, reads: {} }
}

// ---- base cache ------------------------------------------------------------
// Reading a Legend keyed array after a structural write is O(n) (3.4ms on a
// 1k list under Hermes), and update() pays it via peek() to build the Immer
// base. But Immer already computed the exact next state — so cache it, keyed
// by a version counter that ANY change to the atom bumps. Our own writes
// re-validate the cache after their batch (the onChange bump has already
// happened by then); foreign writes (streams, hydration, resetAll, direct
// sets) leave it stale and the next update falls back to peek(). Correct by
// construction regardless of who else writes.

interface BaseCache {
  version: number
  cachedVersion: number
  value: unknown
}

const baseCaches = new WeakMap<object, BaseCache>()

function cacheFor(node$: any): BaseCache {
  let cache = baseCaches.get(node$)
  if (!cache) {
    cache = { version: 0, cachedVersion: -1, value: undefined }
    baseCaches.set(node$, cache)
    const c = cache
    node$.onChange(() => { c.version++ })
  }
  return cache
}

function currentValue(node$: any): unknown {
  const cache = cacheFor(node$)
  return cache.cachedVersion === cache.version ? cache.value : node$.peek()
}

/** Apply a patch set to its atoms in one batch, maintaining a plain-data
 *  shadow so patch application never reads Legend (whose keyed-array reads
 *  are O(n) after writes). Returns the final shadow — the exact post-write
 *  plain state, used to re-validate the base cache. */
function applyPatchSet(
  writes: AtomMap,
  base: Record<string, unknown>,
  patches: readonly Patch[],
): any {
  let shadow: any = base
  batch(() => {
    for (const patch of patches) {
      const atomKey = patch.path[0] as string
      const atom$ = writes[atomKey]
      applyPatches(
        atom$,
        [{ ...patch, path: patch.path.slice(1) }],
        parentPath => parentPath.reduce((n: any, k) => n?.[k], shadow[atomKey]),
      )
      shadow = immerApplyPatches(shadow, [patch])
    }
  })
  return shadow
}

/**
 * Declare a named, multi-atom transition.
 *   const addItem = update('cart/addItem', { cart: cart$ }, (d, item: Item) => { ... })
 * The recipe drafts a composite snapshot of the scope; patches are routed back
 * to each atom by their first path segment and applied in one batch (atomic to
 * subscribers). A recipe that throws — or a `before` interceptor veto, or a
 * write into the read scope — is a clean no-op.
 *
 * Every invocation returns a one-shot `Undo` thunk over its inverse patches —
 * ignorable in statement position, and the optimistic-rollback primitive
 * inside mutation handlers: `const undo = applyToggle(id)` … `undo()`.
 */
export function update<S extends UpdateScope, A extends unknown[]>(
  name: string,
  scope: S,
  recipe: (draft: any, ...args: A) => void,
): (...args: A) => Undo {
  const { writes, reads } = splitScope(scope)
  const writeKeys = Object.keys(writes)
  const readKeys = Object.keys(reads)

  return (...args: A): Undo => {
    runBefore(name, args, writeKeys)   // interceptor veto: throw here aborts cleanly

    const base: Record<string, unknown> = {}
    for (const k of writeKeys) base[k] = currentValue(writes[k])
    for (const k of readKeys) base[k] = currentValue(reads[k])

    const [next, patches, inverse] = produceWithPatches(base, (draft: any) => {
      recipe(draft, ...args)
    })

    for (const patch of patches) {
      const atomKey = patch.path[0] as string
      if (!writes[atomKey]) {
        throw new Error(
          `[concordia] update '${name}' wrote to '${atomKey}', which is not in its ` +
          `write scope (${writeKeys.join(', ')}). Declare it under writes to allow this.`,
        )
      }
    }

    applyPatchSet(writes, base, patches)

    // after the batch: our own onChange bumps have landed, so storing the
    // Immer next slice with the current version marks the cache valid
    for (const k of writeKeys) {
      const cache = cacheFor(writes[k])
      cache.value = (next as any)[k]
      cache.cachedVersion = cache.version
    }

    runAfter({ name, args, scope: writeKeys, patches, inverse, origin: currentOrigin() })

    // the invocation's rollback: apply the inverse against CURRENT state, so
    // later writes to OTHER leaves survive (last-writer-wins per leaf — the
    // property snapshot-restore rollback can't offer)
    let spent = false
    return () => {
      if (spent) {
        console.warn(`[concordia] undo for update '${name}' already applied — ignored`)
        return
      }
      if (inverse.length === 0) {
        spent = true // recipe changed nothing; keep the timeline free of noise
        return
      }
      const undoName = `${name}.undo`
      runBefore(undoName, args, writeKeys) // a veto is a clean no-op; thunk stays live
      spent = true

      const undoBase: Record<string, unknown> = {}
      for (const k of writeKeys) undoBase[k] = currentValue(writes[k])
      const shadow = applyPatchSet(writes, undoBase, inverse)

      for (const k of writeKeys) {
        const cache = cacheFor(writes[k])
        cache.value = shadow[k]
        cache.cachedVersion = cache.version
      }

      // patches/inverse swap roles: the undo's own inverse is the redo
      runAfter({ name: undoName, args, scope: writeKeys, patches: inverse, inverse: patches, origin: currentOrigin() })
    }
  }
}
