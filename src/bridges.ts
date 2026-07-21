import { Observable } from 'rxjs'

/**
 * Any Legend node -> Rx stream. Emits the current value immediately
 * (BehaviorSubject-style), then every change.
 */
export function atomToStream<T>(node: {
  peek(): T
  onChange(cb: (e: { value: T }) => void): () => void
}): Observable<T> {
  return new Observable<T>(subscriber => {
    subscriber.next(node.peek())
    const dispose = node.onChange(({ value }) => subscriber.next(value))
    return () => dispose()
  })
}
