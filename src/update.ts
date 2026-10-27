import { applyPatches as immerApplyPatches, produceWithPatches, type Patch } from 'immer'
import { batch } from '@legendapp/state'
import { applyPatches, clonePatchValue, sameParent } from './applyPatches'
import { fastAppendsFor } from './atom'
import { currentOrigin } from './context'
import { runAfter, runBefore } from './interceptors'

/** Rolls back one update invocation by applying its inverse patches against
 *  current state — a named write (`<name>.undo`) through the normal
 *  interceptor pipeline. Arrays the update restructured are rebased by item
 *  identity (`id`, else value/position), so later edits to other items
 *  survive. One-shot: an insert's inverse is a remove, and removing twice
 *  eats a neighbor — a spent thunk no-ops. */
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
// by a version counter that ANY change to the atom bumps, synchronously (an
// immediate listener: a foreign write earlier in an enclosing batch must not
// hide until its flush). Our own writes re-validate the cache after their
// batch, but only if nothing wrote the atom after our last patch landed — the
// flush runs listeners and reactions, which may write it again. Everything
// else (streams, hydration, resetAll, direct sets) leaves it stale and the
// next update falls back to peek(). Correct by construction regardless of who
// else writes, or when.

interface BaseCache {
  version: number
  cachedVersion: number
  value: unknown
}

const baseCaches = new WeakMap<object, BaseCache>()

function cacheFor(node: any): BaseCache {
  let cache = baseCaches.get(node)
  if (!cache) {
    cache = { version: 0, cachedVersion: -1, value: undefined }
    baseCaches.set(node, cache)
    const c = cache
    node.onChange(() => { c.version++ }, { immediate: true })
  }
  return cache
}

function currentValue(node: any): unknown {
  const cache = cacheFor(node)
  return cache.cachedVersion === cache.version ? cache.value : node.peek()
}

/** Apply a patch set to its atoms in one batch, maintaining a plain-data
 *  shadow so patch application never reads Legend (whose keyed-array reads
 *  are O(n) after writes). The final shadow is the exact post-write plain
 *  state, so it re-validates each written atom's base cache. */
function applyPatchSet(
  writes: AtomMap,
  writeKeys: readonly string[],
  base: Record<string, unknown>,
  patches: readonly Patch[],
): void {
  let shadow: any = base
  const settled: number[] = []
  batch(() => {
    for (let i = 0; i < patches.length;) {
      const { path } = patches[i]!
      const atomKey = path[0] as string
      const atom = writes[atomKey]
      // a run of ops on one parent (a splice's index replaces + trailing
      // remove) reaches Legend as one unit, so the array is rebuilt once
      let end = i + 1
      while (end < patches.length && patches[end]!.path[0] === atomKey && sameParent(patches[end]!.path, path)) end++
      const run = patches.slice(i, end)
      i = end
      // advance the shadow BEFORE Legend applies the run: a peek()ed base
      // aliases Legend's raw objects, which its sets mutate in place — read
      // afterwards, a non-idempotent op (array insert/remove) would land twice
      const prev = shadow
      shadow = immerApplyPatches(prev, run)
      applyPatches(
        atom,
        run.map(p => ({ ...p, path: p.path.slice(1) })),
        parentPath => parentPath.reduce((n: any, k) => n?.[k], prev[atomKey]),
        fastAppendsFor(atom) ? { fastAppends: true } : undefined,
      )
    }
    // the shadow accounts for every bump so far (earlier ones are in `base`);
    // any later bump is someone else writing during this batch's flush
    for (const k of writeKeys) settled.push(cacheFor(writes[k]).version)
  })
  writeKeys.forEach((k, i) => {
    const cache = cacheFor(writes[k])
    if (cache.version !== settled[i]) return // rewritten during the flush: stays stale
    cache.value = shadow[k]
    cache.cachedVersion = cache.version
  })
}

// ---- undo by item identity ---------------------------------------------------
// Immer's array patches are positional (a splice is index replaces plus a
// trailing add/remove). Applied as-is against CURRENT state, an inverse would
// overwrite whatever item now sits at each index, reverting later edits to
// other items. So undo rebases each array the update restructured onto its
// current value by item identity, and re-targets leaf paths through arrays.
// Identity is an item's `id` (the value, for primitives); without usable ids,
// position — sound only while the array's length is unchanged since.

type PathKey = string | number
type Path = readonly PathKey[]
type Tree = Record<PathKey, unknown>

const valueAt = (root: unknown, path: Path): unknown =>
  path.reduce<unknown>((n, k) => (n as Tree | undefined)?.[k], root)

const startsWith = (path: Path, prefix: Path): boolean =>
  prefix.length <= path.length && prefix.every((k, i) => path[i] === k)

const idOf = (item: unknown): unknown => {
  const id = item !== null && typeof item === 'object' ? (item as Tree).id : undefined
  return typeof id === 'string' || typeof id === 'number' ? id : undefined
}

/** Unique per-item keys (`id`, or the value for primitives), or undefined. */
function idKeys(items: readonly unknown[]): unknown[] | undefined {
  const seen = new Set<unknown>()
  for (const item of items) {
    const key = item !== null && typeof item === 'object' ? idOf(item) : item
    if (key === undefined || seen.has(key)) return undefined
    seen.add(key)
  }
  return [...seen]
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  const proto = Object.getPrototypeOf(a)
  if (proto !== Object.getPrototypeOf(b) || (proto !== Object.prototype && proto !== Array.prototype)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length &&
    keys.every(k => k in b && deepEqual((a as Tree)[k], (b as Tree)[k]))
}

/** An array one update restructured: its value before (a snapshot) and after. */
interface ArrayChange { path: Path; before: unknown[]; after: unknown[] }

/** The arrays an update restructured — parents of index ops, and arrays
 *  replaced wholesale — outermost only. `after` is Immer's `next`, which
 *  Legend never holds (it gets clones), so it stays intact. `before` may
 *  alias Legend's raw state, whose leaf sets mutate the items this update
 *  edits in place: those (all not carried into `after` by reference) are
 *  deep-copied; carried items keep their reference, the positional match. */
function arrayChanges(patches: readonly Patch[], base: unknown, next: unknown): ArrayChange[] {
  const out: ArrayChange[] = []
  for (const { path } of patches) {
    if (out.some(c => startsWith(path, c.path))) continue
    const parentPath = path.slice(0, -1)
    const parent = valueAt(next, parentPath)
    const at = parentPath.length > 0 && Array.isArray(parent) ? parentPath
      : Array.isArray((parent as Tree | undefined)?.[path[path.length - 1]!]) ? path
      : undefined
    if (!at) continue
    const before = valueAt(base, at)
    const after = valueAt(next, at)
    if (!Array.isArray(before) || !Array.isArray(after)) continue
    for (let n = out.length - 1; n >= 0; n--) if (startsWith(out[n]!.path, at)) out.splice(n, 1)
    const snapshot = before.slice()
    let carried: Set<unknown> | undefined
    let misses = 0
    for (let i = 0; i < snapshot.length; i++) {
      const item = snapshot[i]
      if (item === after[i] || item === null || typeof item !== 'object') continue
      // a lone item replace misses once: scan; a splice or sort misses a lot: index
      if (!carried && ++misses > 8) carried = new Set(after)
      if (!(carried ? carried.has(item) : after.includes(item))) snapshot[i] = clonePatchValue(item)
    }
    out.push({ path: at, before: snapshot, after })
  }
  return out
}

/** Replay an array change's undo onto the array's CURRENT value: items the
 *  update inserted leave, items it removed return after their nearest
 *  surviving predecessor, its reorder reverts, items it replaced revert
 *  unless rewritten since. Everything else keeps its current value.
 *  Undefined when items can't be matched (no ids, length changed). */
function rebaseArray({ before, after }: ArrayChange, current: readonly unknown[]): unknown[] | undefined {
  let kb = idKeys(before)
  let ka = idKeys(after)
  let kc = idKeys(current)
  if (!kb || !ka || !kc) {
    if (current.length !== after.length) return undefined
    ka = after.map((_, j) => j)
    kc = current.map((_, j) => j)
    // an item carried over untouched is the SAME reference in `after`
    // (Immer's structural sharing); anything else was removed or replaced
    const slots = new Map<unknown, number[]>()
    after.forEach((item, j) => {
      const s = slots.get(item)
      if (s) s.push(j)
      else slots.set(item, [j])
    })
    kb = before.map((item, i) => slots.get(item)?.shift() ?? `removed:${i}`)
  }
  const inBefore = new Map(kb.map((k, i) => [k, i]))
  const inAfter = new Map(ka.map((k, j) => [k, j]))

  const out: { key: unknown; item: unknown }[] = []
  current.forEach((item, n) => {
    const key = kc![n]
    const i = inBefore.get(key)
    const j = inAfter.get(key)
    if (j !== undefined && i === undefined) return // inserted by the update
    if (i !== undefined && j !== undefined && before[i] !== after[j] && deepEqual(item, after[j])) {
      item = before[i] // replaced by the update, untouched since
    }
    out.push({ key, item })
  })

  // the update reordered what it kept: restore that order within those slots
  const keptBefore = kb.filter(k => inAfter.has(k))
  const keptAfter = ka.filter(k => inBefore.has(k))
  if (keptBefore.some((k, n) => k !== keptAfter[n])) {
    const rank = new Map(keptBefore.map((k, n) => [k, n]))
    const slots = out.flatMap((e, n) => (rank.has(e.key) ? [n] : []))
    const sorted = slots.map(n => out[n]!).sort((x, y) => rank.get(x.key)! - rank.get(y.key)!)
    slots.forEach((n, m) => { out[n] = sorted[m]! })
  }

  const present = new Set(out.map(e => e.key))
  before.forEach((item, i) => {
    const key = kb![i]
    if (inAfter.has(key) || present.has(key)) return
    let at = 0
    for (let p = i - 1; p >= 0; p--) {
      const n = out.findIndex(e => e.key === kb![p])
      if (n !== -1) { at = n + 1; break }
    }
    out.splice(at, 0, { key, item })
    present.add(key)
  })
  return out.map(e => e.item)
}

/** Re-find each id-keyed item on a leaf path (recorded against `next`) in
 *  the current state. Undefined when an item on the path is gone. */
function retarget(path: Path, next: unknown, current: unknown): Path | undefined {
  let out: PathKey[] | undefined
  for (let d = 1; d < path.length - 1; d++) {
    const index = path[d]
    if (typeof index !== 'number') continue
    const after = valueAt(next, path.slice(0, d))
    const id = Array.isArray(after) ? idOf(after[index]) : undefined
    if (id === undefined) continue
    const now = valueAt(current, (out ?? path).slice(0, d))
    const n = Array.isArray(now) ? now.findIndex(item => idOf(item) === id) : -1
    if (n === -1) return undefined
    if (n !== index) (out ??= path.slice())[d] = n
  }
  return out ?? path
}

/** An invocation's undo patches against the current state, and their redo. */
function rebaseUndo(
  name: string,
  inverse: readonly Patch[],
  forward: readonly Patch[],
  changes: readonly ArrayChange[],
  next: unknown,
  current: unknown,
): { undo: Patch[]; redo: Patch[] } {
  const rebased: { path: Path; undo: unknown[]; redo: unknown }[] = []
  for (const change of changes) {
    const now = valueAt(current, change.path)
    const undo = Array.isArray(now) ? rebaseArray(change, now) : undefined
    if (undo) rebased.push({ path: change.path, undo, redo: now })
    else {
      console.warn(
        `[tambour] undo for update '${name}': ${change.path.join('.')} changed length since and its ` +
        `items have no unique \`id\` — restored by position, which may overwrite later edits`,
      )
    }
  }
  const rewrite = (patches: readonly Patch[], side: 'undo' | 'redo'): Patch[] => {
    const out: Patch[] = []
    const placed = new Set<object>()
    for (const patch of patches) {
      const whole = rebased.find(r => startsWith(patch.path, r.path))
      if (whole) {
        if (!placed.has(whole)) out.push({ op: 'replace', path: [...whole.path], value: whole[side] })
        placed.add(whole)
      } else if (changes.some(c => startsWith(patch.path, c.path))) {
        out.push(patch) // positional fallback
      } else {
        const path = retarget(patch.path, next, current)
        if (path) out.push(path === patch.path ? patch : { ...patch, path: [...path] })
      }
    }
    return out
  }
  return { undo: rewrite(inverse, 'undo'), redo: rewrite(forward, 'redo') }
}

/**
 * Declare a named, multi-atom transition.
 *   const addItem = update('cart/addItem', { cart }, (d, item: Item) => { ... })
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
          `[tambour] update '${name}' wrote to '${atomKey}', which is not in its ` +
          `write scope (${writeKeys.join(', ')}). Declare it under writes to allow this.`,
        )
      }
    }

    // snapshot BEFORE applying: a peek()ed base aliases Legend's raw arrays,
    // which an in-place index set would rewrite under us
    const changes = inverse.length ? arrayChanges(inverse, base, next) : []
    applyPatchSet(writes, writeKeys, base, patches)

    runAfter({ name, args, scope: writeKeys, patches, inverse, origin: currentOrigin() })

    // the invocation's rollback: apply the inverse against CURRENT state, so
    // later writes to OTHER leaves and items survive (last-writer-wins per
    // leaf — the property snapshot-restore rollback can't offer)
    let spent = false
    return () => {
      if (spent) {
        console.warn(`[tambour] undo for update '${name}' already applied — ignored`)
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
      const { undo, redo } = rebaseUndo(name, inverse, patches, changes, next, undoBase)
      applyPatchSet(writes, writeKeys, undoBase, undo)

      // patches/inverse swap roles: the undo's own inverse is the redo
      runAfter({ name: undoName, args, scope: writeKeys, patches: undo, inverse: redo, origin: currentOrigin() })
    }
  }
}
