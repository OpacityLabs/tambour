# Tambour DX walkthrough — a todo app with bells and whistles

Not a full implementation — snippets showcasing the day-to-day feel of each
primitive, laid out per the spec's file conventions. The "bells and whistles":
persistence with a session/persisted split, debounced search suggestions,
a sync command with double-fire protection, and a celebration reaction.

## The atoms — persistence by composition

```ts
// todos.atom.ts — survives restarts, migrates across versions
export const todos = atom('todos', { items: [] as Todo[] }, {
  persist: { storage: mmkvStorage, version: 2, migrations: {
    2: v1 => ({ items: v1.items.map(t => ({ ...t, tags: [] })) },
  )},
})

// todoUi.atom.ts — session-only: filter, editing state. Not persisted,
// because it lives in its own atom. That's the whole persistence config.
export const todoUi = atom('todoUi', {
  filter: 'all' as 'all' | 'active' | 'done',
  editingId: null as string | null,
})
```

## The updates — named transitions, write scopes that span atoms

```ts
// todos.updates.ts
export const addTodo = update('todos/add', { todos: todos },
  (d, title: string) => {
    d.todos.items.push({ id: nanoid(), title, done: false, tags: [] })
  })

export const toggleTodo = update('todos/toggle', { todos: todos },
  (d, id: string) => {
    const t = d.todos.items.find(t => t.id === id)!
    t.done = !t.done
  })

// Multi-atom: removing a todo must also clear the editor if it was open on it.
// One transition, atomic across both atoms — no orchestration, no torn state.
export const removeTodo = update('todos/remove',
  { todos: todos, ui: todoUi },
  (d, id: string) => {
    d.todos.items = d.todos.items.filter(t => t.id !== id)
    if (d.ui.editingId === id) d.ui.editingId = null
  })

export const clearCompleted = update('todos/clearCompleted', { todos: todos },
  d => { d.todos.items = d.todos.items.filter(t => !t.done) })
```

Every call site is a plain typed function: `addTodo('buy milk')`. The devtools
log reads `todos/add {title: "buy milk"}` → patches. "What can write to
`todoUi`?" is a grep for `todoUi` across `*.updates.ts`.

## The selectors — derivations only; reads don't need them

```ts
// todos.selectors.ts

// createSelector-style: deps in, plain values into a pure combiner.
// Joins two atoms; sync, glitch-free, recomputes once per batch.
export const visibleTodos = selector(
  todos.items, todoUi.filter,
  (items, filter) => {
    if (filter === 'active') return items.filter(t => !t.done)
    if (filter === 'done')   return items.filter(t => t.done)
    return items
  })

// Recomputes often, but consumers only re-render when the numbers change
export const stats = selector(
  todos.items,
  items => ({ total: items.length, done: items.filter(t => t.done).length }),
  { equals: shallowEqual },
)

// Family: same id → same cached node, evicted when the last row unmounts
export const todoById = selectorFamily((id: string) =>
  selector(todos.items, items => items.find(t => t.id === id))
)
```

The combiners are pure functions of plain values — testable without a store.
Dependencies are visible at the top of every declaration, reselect-style.

## The events — commands and signals

```ts
// sync.events.ts — a named, awaitable async function: calling syncNow()
// runs exactly this handler and returns its promise. The trailing option
// 'exhaust' means mashing the sync button returns the in-flight promise.
export const syncNow = event('sync/now', async () => {
  const serverTodos = await api.pullTodos()
  mergeServerTodos(serverTodos)            // an update — or noop if unchanged
}, { concurrency: 'exhaust' })

// search.events.ts — a signal: no handler, just a typed payload source
export const searchInput = streamEvent<string>('search/input')

// celebrate.events.ts — fired by a reaction, handled with a side effect
export const celebrate = event('todos/celebrate', async () => {
  await confetti.blast()
})
```

## The streamSelector — the async selector, tamed

```ts
// search.selectors.ts — as-you-type suggestions from the server.
// Keystrokes Rx suppresses never touch React: no render for the raw
// keystroke, none while debouncing, none for stale responses (switchMap
// aborts them), none for a repeated query (distinctUntilChanged).
export const suggestions = streamSelector(
  eventToStream(searchInput).pipe(
    debounceTime(200),
    distinctUntilChanged(),
    switchMap(q => q ? from(api.suggest(q)) : of([])),
  ),
  { default: [] as Suggestion[] },     // typed Suggestion[], never undefined
)
```

## The reaction — deps in, plain values in, sync react out

```ts
// todos.reactions.ts — a boolean selector + a reaction = edge-triggering by
// construction: the selector only notifies when the boolean flips, so this
// fires once when the last todo is checked off, not on every change after.
const allDone = selector(stats, ({ total, done }) => total > 0 && done === total)

reaction('todos/allDone', allDone, done => {
  if (done) celebrate()        // fire an event (or call an update) — or noop
}, { immediate: true })        // evaluate at startup: a hydrated done-list still celebrates
```

## The components — one hook, targeted re-renders everywhere

```tsx
// A row re-renders only when ITS todo changes. Toggling row 3 never
// renders row 5, the list, or anything else.
function TodoRow({ id }: { id: string }) {
  const todo = useValue(todoById(id))
  return (
    <Row onPress={() => toggleTodo(id)} onLongPress={() => removeTodo(id)}>
      <Check done={todo.done} /> <Text>{todo.title}</Text>
    </Row>
  )
}

// Sync value and stream value: consumed identically. The call site
// can't tell suggestions is async — it's just a node with a value.
function SearchBox() {
  const suggestions = useValue(suggestions)
  return (
    <>
      <TextInput onChangeText={text => searchInput(text)} />
      {suggestions.map(s => <SuggestionRow key={s.id} {...s} />)}
    </>
  )
}

function StatsBar() {
  const { total, done } = useValue(stats)          // re-renders only when counts change
  return <Text>{done}/{total} done</Text>
}

function SyncButton() {
  return <Button onPress={async () => {
    await syncNow()                              // just async/await; exhaust-safe
    toast('Synced!')
  }} />
}

// Gate on persisted-atom hydration (a non-issue on RN with MMKV — sync)
function App() {
  const ready = useValue(todos.hydrated)
  return ready ? <TodoScreen /> : <Splash />
}
```

## What the devtools timeline shows for one user session

```
stream   search/input          "gro"
stream   search/input          "groc"          (debounced — no fetch for "gro")
update   todos/add             {title: "groceries"}   wrote: todos
update   todos/toggle          {id: "t_41"}           wrote: todos
reaction todos/allDone         → event todos/celebrate
event    sync/now              (exhaust: coalesced 2 fires)
update   todos/mergeServer     wrote: todos
```

Every line is named because every primitive is named. That's the Redux
inheritance — with none of the Redux.
```
