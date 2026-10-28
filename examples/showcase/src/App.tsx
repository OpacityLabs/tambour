import { useEffect, useState } from "react";
import { eventToStream, statusOf } from "tambour";
import { useValue } from "tambour/react";
import {
  donate,
  refetchBooks,
  searchState,
  searchUi,
  setQuery,
  setSortBy,
  toggleKeepPrevious,
  visibleBooks,
} from "./state/books";
import {
  addTodo,
  celebrate,
  clearCompleted,
  removeTodo,
  stats,
  todos,
  toggleTodo,
} from "./state/todos";
import { syncNow } from "./state/sync";

function BooksPanelSearch() {
  const query = useValue(searchUi.query);
  const pending = useValue(searchState.pending);

  return (
    <div className="row">
      <input
        value={query}
        placeholder="Search title or author… (try austen, then tolstoy, then austen again)"
        onChange={(e) => setQuery(e.target.value)}
      />
      {pending && <span className="spinner" aria-label="loading" />}
    </div>
  );
}

// Field-granular envelope subscriptions: this footer re-renders on status
// changes but never for the (potentially large) data array itself.
function SearchStatusLine() {
  const pending = useValue(searchState.pending);
  const fetchedAt = useValue(searchState.fetchedAt);
  const stale = useValue(searchState.stale);
  return (
    <footer className="statusline">
      {pending
        ? "fetching…"
        : fetchedAt
          ? `settled ${new Date(fetchedAt).toLocaleTimeString()} · ${stale ? "stale" : "fresh for 15s"}`
          : "untouched key"}
    </footer>
  );
}

// The mutation DX: status rides on the function — no statusOf import, no
// wiring. Donate, watch "donating… → donated ✓", then watch the shelf refetch
// ITSELF: the mutation's settle invalidated the query; nobody called refetch.
function DonateButton() {
  const { pending, success } = useValue(donate.status);
  return (
    <button onClick={() => donate()} disabled={pending}>
      {pending ? "donating…" : success ? "donated ✓ — again?" : "donate a book"}
    </button>
  );
}

function BooksPanel() {
  const keepPrevious = useValue(searchUi.keepPrevious);
  const sortBy = useValue(searchUi.sortBy);
  const books = useValue(visibleBooks);

  return (
    <section className="panel">
      <header>
        <h2>Library search</h2>
        <span className="tag">
          query · mutation · streamSelector · selector
        </span>
      </header>
      <p className="hint">
        Keyed, cached, stale-while-revalidate. Retype a recent search within 15s
        — served from cache, zero requests (watch the console). Toggle “hold
        previous” and feel the difference while a new key loads.
      </p>

      <BooksPanelSearch />

      <div className="row controls">
        <label>
          <input
            type="checkbox"
            checked={keepPrevious}
            onChange={() => toggleKeepPrevious()}
          />
          hold previous results while loading
        </label>
        <label>
          sort by{" "}
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as "date" | "title")}
          >
            <option value="date">date written</option>
            <option value="title">title</option>
          </select>
        </label>
        <button onClick={() => refetchBooks()}>invalidate all</button>
        <DonateButton />
      </div>

      <ul className="books">
        {books.map((b) => (
          <li key={b.id}>
            <span className="year">{b.written}</span> {b.title}
            <span className="author"> — {b.author}</span>
          </li>
        ))}
        {books.length === 0 && <li className="empty">no matches</li>}
      </ul>

      <SearchStatusLine />
    </section>
  );
}

function TodosPanel() {
  const items = useValue(todos.items);
  const { total, done } = useValue(stats);
  const sync = useValue(statusOf(syncNow));
  const [draft, setDraft] = useState("");

  const submit = () => {
    if (draft.trim()) {
      addTodo(draft.trim());
      setDraft("");
    }
  };

  return (
    <section className="panel">
      <header>
        <h2>Todos</h2>
        <span className="tag">
          atom(persist) · update · event(exhaust) · reaction
        </span>
      </header>
      <p className="hint">
        Persisted to localStorage (survives reload). “Pull from server” is
        exhaust-protected — mash it, one request. Check everything off for the
        reaction.
      </p>

      <div className="row">
        <input
          value={draft}
          placeholder="Add a todo…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <button onClick={submit}>add</button>
      </div>

      <ul className="todos">
        {items.map((t) => (
          <li key={t.id} className={t.done ? "done" : ""}>
            <label>
              <input
                type="checkbox"
                checked={t.done}
                onChange={() => toggleTodo(t.id)}
              />
              {t.title}
            </label>
            <button className="ghost" onClick={() => removeTodo(t.id)}>
              ×
            </button>
          </li>
        ))}
        {items.length === 0 && (
          <li className="empty">
            nothing yet — add one or pull from the server
          </li>
        )}
      </ul>

      <div className="row controls">
        <button onClick={() => syncNow()} disabled={sync.pending}>
          {sync.pending
            ? "syncing…"
            : sync.success
              ? "synced ✓ — pull again"
              : "pull from server"}
        </button>
        <button className="ghost" onClick={() => clearCompleted()}>
          clear completed
        </button>
        <span className="statusline">
          {done}/{total} done
        </span>
      </div>
    </section>
  );
}

function useCelebrations(): number[] {
  const [bursts, setBursts] = useState<number[]>([]);
  useEffect(() => {
    const sub = eventToStream(celebrate).subscribe(() => {
      const id = Date.now() + Math.random();
      setBursts((b) => [...b, id]);
      setTimeout(() => setBursts((b) => b.filter((x) => x !== id)), 1600);
    });
    return () => sub.unsubscribe();
  }, []);
  return bursts;
}

export default function App() {
  const bursts = useCelebrations();
  return (
    <main>
      <h1>
        tambour <span className="dim">showcase</span>
      </h1>
      <p className="hint">
        Open the Redux DevTools extension: every update, event, and stream on
        one named timeline.
      </p>
      <div className="panels">
        <BooksPanel />
        {/* <TodosPanel /> */}
      </div>
      {bursts.map((id) => (
        <div key={id} className="confetti" aria-hidden>
          🎉🎊🎉
        </div>
      ))}
    </main>
  );
}
