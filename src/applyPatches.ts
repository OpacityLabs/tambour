import { setAutoFreeze, enablePatches, type Patch } from 'immer'

// Non-negotiable: Immer's auto-freeze would freeze structurally-shared subtrees
// of the result, which ARE Legend's internal raw objects — breaking future sets.
setAutoFreeze(false)
enablePatches()

type PathKey = string | number

/** Walk a Legend observable to the node at `path`. */
export function nodeAt(root$: any, path: readonly PathKey[]): any {
  let node = root$
  for (const key of path) node = node[key]
  return node
}

/** Resolves the CURRENT (pre-patch) plain value at a path — lets callers with
 *  a shadow state avoid Legend reads entirely (reading a keyed array after a
 *  structural write is O(n)). Must reflect all previously applied patches. */
export type PathResolver = (path: readonly PathKey[]) => unknown

/**
 * Apply Immer patches to a Legend observable via targeted per-node operations.
 * Handles the array cases Immer emits (and canonical JSON-patch forms):
 *   - replace on an array index        -> set that index node
 *   - replace on an array's `length`   -> truncate (splice off the tail)
 *   - add on an array index            -> insert (splice), append when i === len
 *   - remove on an array index         -> splice out
 *   - add/replace on an object key     -> set
 *   - remove on an object key          -> delete
 *   - empty path                       -> whole-node set
 * Without `resolve`, current values are read via peek() (fine for one-off
 * callers like the undo recipe; update() always passes a resolver).
 */
export function applyPatches(root$: any, patches: readonly Patch[], resolve?: PathResolver): void {
  for (const patch of patches) {
    const { op, path } = patch

    if (path.length === 0) {
      // whole-value replacement (recipe returned a new root or reassigned everything)
      if (op === 'remove') root$.delete()
      else root$.set(patch.value)
      continue
    }

    const parentPath = path.slice(0, -1)
    const key = path[path.length - 1] as PathKey
    const parent$ = nodeAt(root$, parentPath)
    const parentValue = resolve ? resolve(parentPath) : parent$.peek()

    if (Array.isArray(parentValue)) {
      if (key === 'length') {
        // Immer emits `replace` on length for truncation
        parent$.set(parentValue.slice(0, patch.value as number))
        continue
      }
      const index = key as number
      if (op === 'add') {
        if (index >= parentValue.length) {
          // append — Legend's native push avoids re-diffing the whole array
          parent$.push(patch.value)
        } else {
          // JSON-patch add on an array index means INSERT, not overwrite
          const next = parentValue.slice()
          next.splice(index, 0, patch.value)
          parent$.set(next)
        }
      } else if (op === 'remove') {
        const next = parentValue.slice()
        next.splice(index, 1)
        parent$.set(next)
      } else {
        parent$[index].set(patch.value)
      }
      continue
    }

    // object parent
    if (op === 'remove') parent$[key].delete()
    else parent$[key].set(patch.value)
  }
}
