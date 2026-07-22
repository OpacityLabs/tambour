import type { Patch } from 'immer'
import { getAtomNode } from './atom'
import { addInterceptor, type QueryFetchReason, type UpdateRecord } from './interceptors'

/** What the logger narrates. Reaction loops are not a kind — they are bugs,
 *  always error-routed and never filtered. For queries the filterable name is
 *  the FAMILY name ('accounts'), never the key. */
export type LogKind = 'update' | 'event' | 'stream' | 'query'

/** Name selection: a glob (`'todos/*'`), a list of globs (OR), or a predicate.
 *  A predicate is the whole decision — `exclude` is not layered on top of it. */
export type NameFilter = string | string[] | ((name: string, kind: LogKind) => boolean)

/** The console surface the logger writes to. Injectable for tests and for
 *  routing the formatted lines somewhere else (file, ring buffer). */
export interface LoggerSink {
  log(...args: unknown[]): void
  error(...args: unknown[]): void
  debug?(...args: unknown[]): void
  info?(...args: unknown[]): void
  groupCollapsed?(...args: unknown[]): void
  group?(...args: unknown[]): void
  groupEnd?(): void
}

export interface LogInterceptorOptions {
  /** Only narrate matching names (glob(s) or predicate). Default: everything. */
  filter?: NameFilter
  /** Silence matching names. Wins over `filter`. Ignored when `filter` is a
   *  predicate (the predicate is the whole decision). */
  exclude?: string | string[]
  /** Kind toggles — `streams: false` is the usual noise fix. Default: all on. */
  updates?: boolean
  events?: boolean
  streams?: boolean
  queries?: boolean
  /** Browser console groups start collapsed. Default: true. */
  collapsed?: boolean
  /** Patch-based `old → new` lines under each update. Default: true. */
  diff?: boolean
  /** 'scope' prints each written atom's post-update value — cost proportional
   *  to the write, never the world. Default: 'none'. */
  state?: 'none' | 'scope'
  /** Updates whose recipe changed nothing (zero patches — e.g. an
   *  equality-guarded poll apply) render as a muted `∅ no-op` line: the
   *  update ran, nothing was written. `false` drops them entirely.
   *  Default: true. */
  noops?: boolean
  /** Wall-clock per line, for correlating with network tabs and server logs.
   *  Default: true. */
  timestamps?: boolean
  /** Rich output (console groups + %c styling): 'auto' detects a browser,
   *  `false` forces plain aligned lines (CI, Metro, log aggregation). */
  colors?: 'auto' | true | false
  /** Truncation depth for printed values — keeps Metro terminals readable
   *  when an update carries a 500-item array. Default: 3. */
  depth?: number
  /** Console method for normal lines; `'debug'` hides the timeline behind the
   *  browser's Verbose filter. Failed settles and reaction loops always use
   *  `error`. Default: 'debug' (falls back to `log` if the sink lacks it). */
  level?: 'debug' | 'log' | 'info'
  /** One-time legend line at install teaching the glyph vocabulary
   *  (… ✓ ✗ ⊘ ∅ ⇣ ←) — the timeline should be readable without folklore.
   *  `false` suppresses. Default: true. */
  banner?: boolean
  /** Secrets guard. Glob(s): matching entries print `[redacted]` and suppress
   *  diffs/state (values may carry the secret too). Function: maps args for
   *  display only — diffs still print. */
  redact?: string | string[] | ((name: string, args: unknown[]) => unknown[])
  /** Sink for output. Default: console. */
  logger?: LoggerSink
}

// ---- formatting -------------------------------------------------------------

function globToRegExp(glob: string): RegExp {
  const source = glob
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`)
}

function toRegExps(globs: string | string[] | undefined): RegExp[] {
  if (globs === undefined) return []
  return (Array.isArray(globs) ? globs : [globs]).map(globToRegExp)
}

/** Compact single-line value rendering, depth- and length-bounded so one huge
 *  payload can't flood a terminal. */
function preview(value: unknown, depth: number): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  const t = typeof value
  if (t === 'string') {
    const s = value as string
    return JSON.stringify(s.length > 64 ? `${s.slice(0, 64)}…` : s)
  }
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(value)
  if (t === 'function') return `ƒ ${(value as { name?: string }).name ?? ''}`.trimEnd()
  if (t === 'symbol') return String(value)
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Map) return `Map(${value.size})`
  if (value instanceof Set) return `Set(${value.size})`
  if (Array.isArray(value)) {
    if (depth <= 0) return `[… ${value.length}]`
    const head = value.slice(0, 10).map(v => preview(v, depth - 1))
    const rest = value.length > 10 ? `, … ${value.length - 10} more` : ''
    return `[${head.join(', ')}${rest}]`
  }
  if (depth <= 0) return '{…}'
  const entries = Object.entries(value as object)
  const head = entries.slice(0, 8).map(([k, v]) => `${k}: ${preview(v, depth - 1)}`)
  const rest = entries.length > 8 ? `, … ${entries.length - 8} more` : ''
  return `{${head.join(', ')}${rest}}`
}

function previewArgs(args: unknown[], depth: number): string {
  return args.length ? `(${args.map(a => preview(a, depth)).join(', ')})` : ''
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : preview(error, 1)
}

/** `['todos', 3, 'done']` → `todos[3].done` (Immer paths put the atom first). */
function joinPath(path: (string | number)[]): string {
  let out = ''
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`
    else out += out ? `.${seg}` : seg
  }
  return out
}

/** `old → new` lines straight from the record — the patches carry the new
 *  values, the inverse patches carry the old; no snapshot is ever taken.
 *  (Immer encodes some inverses as array-length replaces; those lookups miss
 *  and render as `?` rather than guessing.) */
function diffLines(patches: Patch[], inverse: Patch[], depth: number): string[] {
  const oldByPath = new Map<string, Patch>()
  for (const p of inverse) oldByPath.set(JSON.stringify(p.path), p)
  return patches.map(p => {
    const path = joinPath(p.path)
    const old = oldByPath.get(JSON.stringify(p.path))
    if (p.op === 'replace')
      return `${path}: ${old ? preview(old.value, depth) : '?'} → ${preview(p.value, depth)}`
    if (p.op === 'add') return `${path}: + ${preview(p.value, depth)}`
    return `${path}: − ${old ? preview(old.value, depth) : '?'}`
  })
}

function wallClock(): string {
  const d = new Date()
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

const now: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now()

const STYLE = {
  update: 'color:#4caf50;font-weight:bold',
  event: 'color:#2196f3;font-weight:bold',
  stream: 'color:#00bcd4;font-weight:bold',
  query: 'color:#9c27b0;font-weight:bold',
  plain: 'color:inherit;font-weight:normal',
  muted: 'color:#9e9e9e;font-weight:normal',
  ok: 'color:#4caf50;font-weight:bold',
  fail: 'color:#f44336;font-weight:bold',
} as const

/** Aligned plain line matching the timeline format in examples/todo-dx.md. */
function plainLine(kind: string, name: string, rest: string): string {
  return `${kind.padEnd(8)} ${name.padEnd(22)} ${rest}`.trimEnd()
}

// ---- the interceptor --------------------------------------------------------

/**
 * Narrate the runtime timeline — updates (with patch-based diffs), event
 * lifecycles (fire → settle with duration/outcome), streams, reaction loops —
 * to the console. Pure interceptor: zero core changes, zero cost when
 * disposed, works in browser consoles, Metro terminals, Node, and CI.
 * Returns a dispose function.
 */
export function logInterceptor(options: LogInterceptorOptions = {}): () => void {
  const {
    filter,
    exclude,
    updates = true,
    events = true,
    streams = true,
    queries = true,
    collapsed = true,
    diff = true,
    state = 'none',
    noops = true,
    timestamps = true,
    colors = 'auto',
    depth = 3,
    level = 'debug',
    banner = true,
    redact,
    logger = console as LoggerSink,
  } = options

  // name selection, compiled once — this runs on every fire/settle/update
  const allowName: (name: string, kind: LogKind) => boolean = (() => {
    if (typeof filter === 'function') return filter
    const include = filter === undefined ? null : toRegExps(filter)
    const omit = toRegExps(exclude)
    return (name: string) => {
      if (omit.some(r => r.test(name))) return false
      return include === null || include.some(r => r.test(name))
    }
  })()
  const kindOn: Record<LogKind, boolean> = {
    update: updates,
    event: events,
    stream: streams,
    query: queries,
  }
  const shows = (kind: LogKind, name: string) => kindOn[kind] && allowName(name, kind)

  const redactGlobs = typeof redact === 'function' ? null : toRegExps(redact)
  const masked = (name: string) => redactGlobs !== null && redactGlobs.some(r => r.test(name))
  const mapArgs = typeof redact === 'function' ? redact : (_: string, args: unknown[]) => args

  const isBrowser =
    typeof document !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    (navigator as { product?: string }).product !== 'ReactNative'
  const rich = colors === true || (colors === 'auto' && isBrowser && !!logger.groupCollapsed)
  const openGroup = collapsed ? (logger.groupCollapsed ?? logger.group) : (logger.group ?? logger.groupCollapsed)

  const emit = ((logger[level] ?? logger.log) as (...a: unknown[]) => void).bind(logger)
  const emitError = logger.error.bind(logger)
  const ts = () => (timestamps ? ` ${wallClock()}` : '')

  if (banner) {
    const legend =
      '[tambour] timeline on — … fired  ✓ settled  ✗ failed  ⊘ superseded  ∅ no-op  ⇣ fetch  stale invalidated  ← caused-by'
    try {
      if (rich) emit(`%c${legend}`, STYLE.muted)
      else emit(legend)
    } catch {
      /* a broken sink at install — the per-entry guards handle the rest */
    }
  }

  function printUpdate(record: UpdateRecord): void {
    const hidden = masked(record.name)
    const shownArgs = hidden ? [] : mapArgs(record.name, record.args)
    const argsText = hidden ? '[redacted]' : previewArgs(shownArgs, depth)
    const originPart = record.origin ? ` ← ${record.origin}` : ''

    // zero patches: the update ran but wrote nothing — saying `wrote:` would
    // be a lie, and there is no diff/state body to group
    if (record.patches.length === 0) {
      if (!noops) return
      if (rich) {
        emit(
          `%cupdate%c ${record.name}${argsText ? ` ${argsText}` : ''} %c∅ no-op${originPart}${ts()}`,
          STYLE.update, STYLE.plain, STYLE.muted,
        )
      } else {
        emit(plainLine('update', record.name, `${argsText ? `${argsText}  ` : ''}∅ no-op${originPart}${ts()}`))
      }
      return
    }

    const meta = `wrote: ${record.scope.join(', ')}${originPart}`

    const body: string[] = []
    if (!hidden && diff) body.push(...diffLines(record.patches, record.inverse, depth))
    if (!hidden && state === 'scope') {
      for (const key of record.scope) {
        // scope keys resolve through the atom registry; a renamed scope key
        // (`{ c: cart }`) has no registered atom — skip rather than guess
        const node = getAtomNode(key) as { peek(): unknown } | undefined
        if (node) body.push(`${key} = ${preview(node.peek(), depth)}`)
      }
    }

    if (rich && openGroup && logger.groupEnd) {
      openGroup.call(
        logger,
        `%cupdate%c ${record.name}${argsText ? ` ${argsText}` : ''} %c${meta}${ts()}`,
        STYLE.update, STYLE.plain, STYLE.muted,
      )
      if (!hidden && shownArgs.length) emit('args', ...shownArgs)
      for (const line of body) emit(line)
      logger.groupEnd()
    } else {
      emit(plainLine('update', record.name, `${argsText ? `${argsText}  ` : ''}${meta}${ts()}`))
      for (const line of body) emit(`  │ ${line}`)
    }
  }

  function printFire(kind: LogKind, name: string, args: unknown[]): void {
    const argsText = masked(name) ? '[redacted]' : previewArgs(mapArgs(name, args), depth)
    // command events await a settle — mark the fire as unfinished so the
    // fire/settle pair can't read as two occurrences. Streams ARE complete
    // at fire; no marker.
    const marker = kind === 'event' ? '…' : ''
    const tail = `${marker}${ts()}`.trim()
    if (rich) {
      emit(
        `%c${kind}%c ${name}${argsText ? ` ${argsText}` : ''}${tail ? ` %c${tail}` : ''}`,
        STYLE[kind], STYLE.plain, ...(tail ? [STYLE.muted] : []),
      )
    } else {
      emit(plainLine(kind, name, `${argsText ? `${argsText}  ` : ''}${tail}`))
    }
  }

  function printSettle(name: string, error: unknown, superseded: boolean, start: number | undefined): void {
    const ms = start !== undefined ? ` ${Math.max(0, Math.round(now() - start))}ms` : ''
    let outcome: string
    let style: string
    let sink = emit
    if (superseded) {
      outcome = `⊘ superseded${ms}`
      style = STYLE.muted
    } else if (error !== undefined) {
      outcome = `✗${ms} ${errorText(error)}`
      style = STYLE.fail
      sink = emitError
    } else {
      outcome = `✓${ms}`
      style = STYLE.ok
    }
    if (rich) sink(`%cevent%c ${name} %c${outcome}%c${ts()}`, STYLE.event, STYLE.plain, style, STYLE.muted)
    else sink(plainLine('event', name, `${outcome}${ts()}`))
  }

  /** `accounts("professional")` — the composite that fills the name column. */
  function queryLabel(name: string, keyArgs: unknown[] | 'all'): string {
    if (keyArgs === 'all') return `${name}(*)`
    const keyText = masked(name) ? ' [redacted]' : previewArgs(keyArgs, depth)
    return `${name}${keyText}`
  }

  function printQueryFetch(name: string, keyArgs: unknown[], reason: QueryFetchReason): void {
    const label = queryLabel(name, keyArgs)
    if (rich) {
      emit(`%cquery%c ${label} %c⇣ fetch (${reason})${ts()}`, STYLE.query, STYLE.plain, STYLE.muted)
    } else {
      emit(plainLine('query', label, `⇣ fetch (${reason})${ts()}`))
    }
  }

  function printQuerySettle(
    name: string,
    keyArgs: unknown[],
    error: unknown | undefined,
    start: number | undefined,
  ): void {
    const label = queryLabel(name, keyArgs)
    const ms = start !== undefined ? ` ${Math.max(0, Math.round(now() - start))}ms` : ''
    if (error !== undefined) {
      const line = `✗${ms} ${errorText(error)}`
      if (rich) emitError(`%cquery%c ${label} %c${line}%c${ts()}`, STYLE.query, STYLE.plain, STYLE.fail, STYLE.muted)
      else emitError(plainLine('query', label, `${line}${ts()}`))
    } else {
      if (rich) emit(`%cquery%c ${label} %c✓${ms}%c${ts()}`, STYLE.query, STYLE.plain, STYLE.ok, STYLE.muted)
      else emit(plainLine('query', label, `✓${ms}${ts()}`))
    }
  }

  function printQueryInvalidate(name: string, keyArgs: unknown[] | 'all', origin: string | null): void {
    const label = queryLabel(name, keyArgs)
    const rest = `stale${origin ? ` ← ${origin}` : ''}`
    if (rich) emit(`%cquery%c ${label} %c${rest}${ts()}`, STYLE.query, STYLE.plain, STYLE.muted)
    else emit(plainLine('query', label, `${rest}${ts()}`))
  }

  // fire → settle pairing by args identity (the interceptor contract) — start
  // times are kept for every command event regardless of filtering so the map
  // stays clean; streams never settle and are never stored. Query fetches
  // pair the same way: the entry's args array is identity-stable across one
  // fetch's lifetime, and one fetch per key is in flight at a time.
  const starts = new Map<unknown[], number>()
  const queryStarts = new Map<unknown[], number>()

  // `after`/`onEventFire` run unprotected inside update()/fire() — a logger
  // crash must never take the app's writes down with it
  const guard = (fn: () => void) => {
    try {
      fn()
    } catch (err) {
      try {
        emitError('[tambour] logInterceptor failed:', err)
      } catch {
        /* the sink itself is broken — nothing left to do */
      }
    }
  }

  return addInterceptor({
    after: record => guard(() => {
      if (shows('update', record.name)) printUpdate(record)
    }),
    onEventFire: (name, args, kind) => guard(() => {
      const k: LogKind = kind === 'stream' ? 'stream' : 'event'
      if (k === 'event') starts.set(args, now())
      if (shows(k, name)) printFire(k, name, args)
    }),
    onEventSettle: (name, error, args, superseded) => {
      const start = starts.get(args)
      starts.delete(args)
      guard(() => {
        if (shows('event', name)) printSettle(name, error, superseded, start)
      })
    },
    // a circuit-broken loop is a bug, not timeline noise — always printed
    onReactionLoop: (name, chain) => guard(() => {
      emitError(`reaction loop circuit-broken: ${name} (chain: ${chain.join(' → ')})`)
    }),
    onQueryFetch: (name, keyArgs, reason) => guard(() => {
      queryStarts.set(keyArgs, now())
      if (shows('query', name)) printQueryFetch(name, keyArgs, reason)
    }),
    onQuerySettle: (name, keyArgs, error) => {
      const start = queryStarts.get(keyArgs)
      queryStarts.delete(keyArgs)
      guard(() => {
        if (shows('query', name)) printQuerySettle(name, keyArgs, error, start)
      })
    },
    onQueryInvalidate: (name, keyArgs, origin) => guard(() => {
      if (shows('query', name)) printQueryInvalidate(name, keyArgs, origin)
    }),
  })
}
