import { produceWithPatches, type Patch } from 'immer'
import { batch } from '@legendapp/state'
import { applyPatches } from './applyPatches'

type AtomScope = Record<string, any>

export interface UpdateRecord {
  name: string
  args: unknown[]
  scope: string[]
  patches: Patch[]
  inverse: Patch[]
}

type AfterInterceptor = (record: UpdateRecord) => void
const afterInterceptors: AfterInterceptor[] = []

export function addAfterInterceptor(fn: AfterInterceptor): () => void {
  afterInterceptors.push(fn)
  return () => {
    const i = afterInterceptors.indexOf(fn)
    if (i >= 0) afterInterceptors.splice(i, 1)
  }
}

/**
 * Declare a named, multi-atom transition.
 *   const addItem = update('cart/addItem', { cart: cart$ }, (d, item: Item) => { ... })
 * The recipe drafts a composite snapshot of the scope; patches are routed back to
 * each atom by their first path segment and applied in one batch (atomic to
 * subscribers). A recipe that throws is a clean no-op — patches are computed
 * before anything is applied.
 */
export function update<S extends AtomScope, A extends unknown[]>(
  name: string,
  scope: S,
  recipe: (draft: { [K in keyof S]: any }, ...args: A) => void,
): (...args: A) => void {
  const keys = Object.keys(scope)
  return (...args: A) => {
    const base: Record<string, unknown> = {}
    for (const k of keys) base[k] = scope[k].peek()

    const [, patches, inverse] = produceWithPatches(base, (draft: any) => {
      recipe(draft, ...args)
    })

    batch(() => {
      for (const patch of patches) {
        const atomKey = patch.path[0] as string
        const atom$ = scope[atomKey]
        applyPatches(atom$, [{ ...patch, path: patch.path.slice(1) }])
      }
    })

    for (const fn of afterInterceptors) fn({ name, args, scope: keys, patches, inverse })
  }
}
