import { setAutoFreeze, enablePatches, type Patch } from 'immer'

// Non-negotiable: Immer's auto-freeze would freeze structurally-shared subtrees
// of the result, which ARE Legend's internal raw objects — breaking future sets.
setAutoFreeze(false)
enablePatches()

type PathKey = string | number

/** Walk a Legend observable to the node at `path`. */
export function nodeAt(root: any, path: readonly PathKey[]): any {
  let node = root
  for (const key of path) node = node[key]
  return node
}

/** Resolves the CURRENT (pre-patch) plain value at a path — lets callers with
 *  a shadow state avoid Legend reads entirely (reading a keyed array after a
 *  structural write is O(n)). Must reflect all previously applied patches. */
export type PathResolver = (path: readonly PathKey[]) => unknown

export interface ApplyPatchesOptions {
  /** Growth and reorders (runs of index replaces plus appends) go through
   *  Legend's in-place `set`/`push` instead of replacing the array. Skips
   *  the O(n) keyed-array diff, but the array KEEPS ITS IDENTITY across them
   *  — identity-keyed consumers (useMemo deps, React.memo props) will not
   *  see them. See `AtomOptions.fastAppends`. */
  fastAppends?: boolean
}

/** Deep-copy plain data (arrays, plain objects, Map, Set), as Immer's own
 *  applyPatches does. Legend mutates its raw state in place, so nothing it
 *  holds may be shared with a patch (history, devtools, undo) or a caller's
 *  payload. Other values (primitives, Dates, class instances) pass through. */
export function clonePatchValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(v => clonePatchValue(v)) as T
  if (value instanceof Map) return new Map(Array.from(value, ([k, v]) => [k, clonePatchValue(v)])) as T
  if (value instanceof Set) return new Set(Array.from(value, v => clonePatchValue(v))) as T
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  const out: Record<string, unknown> = proto === null ? Object.create(null) : {}
  for (const k of Object.keys(value)) out[k] = clonePatchValue((value as Record<string, unknown>)[k])
  return out as T
}

/** Do two patch paths share a parent (same length, same all-but-last)? */
export function sameParent(a: readonly PathKey[], b: readonly PathKey[]): boolean {
  if (a.length !== b.length || a.length === 0) return false
  for (let i = 0; i < a.length - 1; i++) if (a[i] !== b[i]) return false
  return true
}

/** Apply one array op to a plain working copy. */
function applyArrayOp(arr: unknown[], { op, path, value }: Patch): void {
  const key = path[path.length - 1] as PathKey
  if (key === 'length') arr.length = value as number     // Immer's truncation
  else if (op === 'add') arr.splice(key as number, 0, clonePatchValue(value))  // JSON-patch add = insert
  else if (op === 'remove') arr.splice(key as number, 1)
  else arr[key as number] = clonePatchValue(value)
}

/**
 * Apply Immer patches to a Legend observable via targeted per-node operations.
 * Handles the array cases Immer emits (and canonical JSON-patch forms):
 *   - replace on an array index        -> set that index node
 *   - replace on an array's `length`   -> truncate
 *   - add on an array index            -> insert, append when i === len
 *   - remove on an array index         -> splice out
 *   - add/replace on an object key     -> set
 *   - remove on an object key          -> delete
 *   - empty path                       -> whole-node set
 * Consecutive ops on one array (Immer emits a splice, shift or sort as a run
 * of index replaces plus a trailing add/remove) are folded into ONE fresh
 * array: a structurally changed or reordered array always has a new identity
 * — the Immer promise identity-keyed React consumers rely on. Only a lone
 * index replace (an item swapped for another: content, not structure) sets
 * in place. `fastAppends` opts runs of index replaces and appends out of that
 * promise (in place: replaces set, appends push).
 * Values are cloned on the way in (see `clonePatchValue`).
 * Without `resolve`, current values are read via peek() (fine for one-off
 * callers; update() always passes a resolver).
 */
export function applyPatches(
  root: any,
  patches: readonly Patch[],
  resolve?: PathResolver,
  options?: ApplyPatchesOptions,
): void {
  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i]!
    const { op, path } = patch

    if (path.length === 0) {
      // whole-value replacement (recipe returned a new root or reassigned everything)
      if (op === 'remove') root.delete()
      else root.set(clonePatchValue(patch.value))
      continue
    }

    const parentPath = path.slice(0, -1)
    const parent = nodeAt(root, parentPath)
    const parentValue = resolve ? resolve(parentPath) : parent.peek()

    if (Array.isArray(parentValue)) {
      let end = i + 1
      while (end < patches.length && sameParent(patches[end]!.path, path)) end++
      const run = patches.slice(i, end)
      i = end - 1

      let length = parentValue.length
      const inPlace = options?.fastAppends
        ? run.every(p => {
            const k = p.path[p.path.length - 1]
            if (p.op === 'replace') return k !== 'length'
            return p.op === 'add' && k === length++
          })
        : run.length === 1 && op === 'replace' && path[path.length - 1] !== 'length'
      if (inPlace) {
        for (const p of run) {
          const value = clonePatchValue(p.value)
          if (p.op === 'add') parent.push(value)
          else parent[p.path[p.path.length - 1] as number].set(value)
        }
      } else {
        const next = parentValue.slice()
        for (const p of run) applyArrayOp(next, p)
        parent.set(next)
      }
      continue
    }

    // object parent
    const key = path[path.length - 1] as PathKey
    if (op === 'remove') parent[key].delete()
    else parent[key].set(clonePatchValue(patch.value))
  }
}
