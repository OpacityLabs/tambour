import { produceWithPatches } from 'immer'
import { batch } from '@legendapp/state'
import { applyPatches } from './applyPatches'
import { currentOrigin } from './context'
import { runAfter, runBefore } from './interceptors'

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

/**
 * Declare a named, multi-atom transition.
 *   const addItem = update('cart/addItem', { cart: cart$ }, (d, item: Item) => { ... })
 * The recipe drafts a composite snapshot of the scope; patches are routed back
 * to each atom by their first path segment and applied in one batch (atomic to
 * subscribers). A recipe that throws — or a `before` interceptor veto, or a
 * write into the read scope — is a clean no-op.
 */
export function update<S extends UpdateScope, A extends unknown[]>(
  name: string,
  scope: S,
  recipe: (draft: any, ...args: A) => void,
): (...args: A) => void {
  const { writes, reads } = splitScope(scope)
  const writeKeys = Object.keys(writes)
  const readKeys = Object.keys(reads)

  return (...args: A) => {
    runBefore(name, args, writeKeys)   // interceptor veto: throw here aborts cleanly

    const base: Record<string, unknown> = {}
    for (const k of writeKeys) base[k] = writes[k].peek()
    for (const k of readKeys) base[k] = reads[k].peek()

    const [, patches, inverse] = produceWithPatches(base, (draft: any) => {
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

    batch(() => {
      for (const patch of patches) {
        const atom$ = writes[patch.path[0] as string]
        applyPatches(atom$, [{ ...patch, path: patch.path.slice(1) }])
      }
    })

    runAfter({ name, args, scope: writeKeys, patches, inverse, origin: currentOrigin() })
  }
}
