// Persisted atom + named updates + selectors + an edge-triggered reaction.

import { atom, event, reaction, selector, update, type TambourStorage } from 'tambour'
import type { ServerTodo } from '../api'

export interface Todo {
  id: string
  title: string
  done: boolean
}

// localStorage is synchronous → atoms hydrate during registration, no gate
// needed (the web analog of MMKV on RN).
const webStorage: TambourStorage = {
  getString: key => localStorage.getItem(key),
  setString: (key, value) => localStorage.setItem(key, value),
  remove: key => localStorage.removeItem(key),
}

export const todos$ = atom(
  'todos',
  { items: [] as Todo[] },
  { persist: { storage: webStorage, version: 1 } },
)

export const addTodo = update('todos/add', { todos: todos$ }, (d, title: string) => {
  d.todos.items.push({ id: crypto.randomUUID(), title, done: false })
})

export const toggleTodo = update('todos/toggle', { todos: todos$ }, (d, id: string) => {
  const t = d.todos.items.find((t: Todo) => t.id === id)
  if (t) t.done = !t.done
})

export const removeTodo = update('todos/remove', { todos: todos$ }, (d, id: string) => {
  d.todos.items = d.todos.items.filter((t: Todo) => t.id !== id)
})

export const clearCompleted = update('todos/clearCompleted', { todos: todos$ }, d => {
  d.todos.items = d.todos.items.filter((t: Todo) => !t.done)
})

/** Server merge — the write half of sync/now. Dedupes by id. */
export const mergeServerTodos = update('todos/mergeServer', { todos: todos$ }, (d, incoming: ServerTodo[]) => {
  for (const t of incoming) {
    if (!d.todos.items.some((x: Todo) => x.id === t.id)) d.todos.items.push({ ...t })
  }
})

export const stats$ = selector(
  todos$.items,
  items => ({ total: items.length, done: items.filter(t => t.done).length }),
  { equals: (a, b) => a.total === b.total && a.done === b.done },
)

// A boolean selector only notifies when its output FLIPS, so the reaction
// below fires exactly on the nothing-left-to-do transition. Edge-triggering
// by composition, not by feature.
const allDone$ = selector(stats$, s => s.total > 0 && s.done === s.total)

export const celebrate = event('todos/celebrate', async () => {
  // the side effect lives in the UI (it subscribes via eventToStream);
  // the event exists so the fire is NAMED on the timeline
})

reaction(
  'todos/allDone',
  allDone$,
  done => {
    if (done) celebrate()
  },
  { immediate: true }, // a hydrated all-done list still celebrates on load
)
