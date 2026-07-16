/**
 * Compile-time tests for the mutation DX — validated by `tsc --noEmit`,
 * never executed. This is the full call-site surface a consumer sees:
 * the three invalidation forms, carried status, and the typed args tuple
 * flowing into the `invalidates` callback (with @ts-expect-error proving
 * the types reject mismatches).
 *
 * Why the callback takes the args TUPLE (destructure it) instead of spread
 * parameters: a spread callback using only a prefix of the args — the
 * common case — trips TS's rest-tuple variance check, and a union of
 * prefix signatures breaks contextual typing of unannotated params. The
 * tuple form keeps every spelling below inferring cleanly.
 */
import { invalidate, mutation, query, statusOf, TimeoutError } from '../src'

interface Todo { id: string; title: string; done: boolean }

declare const api: {
  fetchTodos(): Promise<Todo[]>
  fetchTodo(id: string): Promise<Todo>
  clearCompleted(): Promise<void>
  renameTodo(id: string, title: string): Promise<void>
  createTodo(title: string): Promise<Todo>
  saveTodo(id: string, signal: AbortSignal): Promise<void>
}

// ---- queries: a list and a keyed detail --------------------------------
const todoList = query('tc/todos', () => api.fetchTodos(), { default: [] as Todo[] })
const todoDetail = query('tc/todoDetail', (id: string) => api.fetchTodo(id))

// ---- form 1: family-wide — a write that touches every cached key -------
export const clearCompleted = mutation('tc/clearCompleted',
  async () => { await api.clearCompleted() },
  { invalidates: [todoList] })

// ---- form 2: keyed by the call's args — destructure what you need ------
// (id inferred as string; `title` simply not destructured)
export const renameTodo = mutation('tc/rename',
  async (id: string, title: string) => { await api.renameTodo(id, title) },
  { invalidates: ([id]) => [todoList, todoDetail(id)] })

// ---- form 3: result-dependent — the handler has the result -------------
export const createTodo = mutation('tc/create', async (title: string) => {
  const created = await api.createTodo(title)
  invalidate(todoDetail(created.id)) // key only known from the response
  return created
})

// ---- switch: handler sees the AbortSignal, the callback does NOT -------
export const saveTodo = mutation('tc/save',
  async (id: string, signal: AbortSignal) => { await api.saveTodo(id, signal) },
  { concurrency: 'switch', invalidates: ([id]) => [todoDetail(id)] })

// ---- whole tuple and arg-independent forms also infer ------------------
export const bumpAll = mutation('tc/bumpAll',
  async (_id: string, _n: number) => {},
  { invalidates: args => [todoDetail(args[0])] })
export const bumpStatic = mutation('tc/bumpStatic',
  async (_id: string) => {},
  { invalidates: () => [todoList] })

// ---- retry/timeout are event options — mutations inherit them ----------
// (zero-retry default; predicate form is fully typed; TimeoutError is public)
export const flakySave = mutation('tc/flaky',
  async (id: string) => { await api.renameTodo(id, 'x') },
  {
    retry: (failureCount, error) => failureCount < 3 && !(error instanceof TimeoutError),
    retryDelay: 250,
    timeout: 10_000,
    invalidates: ([id]) => [todoDetail(id)],
  })

// ---- carried metadata: on the function, same node as statusOf ----------
const success: boolean = renameTodo.status.get().success
const same: typeof renameTodo.status = statusOf(renameTodo)
void success; void same

// ---- calls are plain typed async functions -----------------------------
async function demo(): Promise<Todo> {
  await renameTodo('t1', 'buy milk') // (id: string, title: string)
  return createTodo('bread')         // Promise<Todo> flows back to the caller
}
void demo

// @ts-expect-error — tuple elements are typed from the handler: id is a string
mutation('tc/bad-type', async (id: string) => id, { invalidates: ([id]: [number]) => [] })

// @ts-expect-error — can't destructure more args than the mutation takes
mutation('tc/bad-arity', async (id: string) => id, { invalidates: ([_a, _b]) => [] })

// @ts-expect-error — call args are checked: title must be a string
void renameTodo('t1', 42)
