/**
 * The public read surface of any state node. Writable methods (set / assign /
 * delete / push / splice) are deliberately absent — writes happen only through
 * declared updates. This is the type-level enforcement of design rule #1.
 */
export interface ReadonlyNodeBase<T> {
  get(): T
  peek(): T
  onChange(cb: (params: { value: T }) => void): () => void
}

export type ReadonlyNode<T> = ReadonlyNodeBase<T> &
  (T extends readonly (infer U)[]
    ? { readonly [index: number]: ReadonlyNode<U> }
    : T extends object
      ? { readonly [K in keyof T]-?: ReadonlyNode<T[K]> }
      : {})

declare const AtomBrand: unique symbol

/** A registered root node. Structurally a ReadonlyNode; the brand lets APIs
 *  (update scopes, persistence) require "a real atom" rather than any node. */
export type Atom<T> = ReadonlyNode<T> & { readonly [AtomBrand]?: true }
