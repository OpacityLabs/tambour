import { beforeEach, describe, expect, it } from 'vitest'
import { atom, clearRegistry } from '../src/atom'
import { event, streamEvent } from '../src/events'
import { runReactionLoop } from '../src/interceptors'
import { logInterceptor, type LoggerSink } from '../src/logger'
import { mutation } from '../src/mutation'
import { invalidate, query } from '../src/query'
import { update } from '../src/update'

beforeEach(() => clearRegistry())

/** Minimal sink: no `debug`, so the default level falls back to `log`. */
function makeSink() {
  const lines: string[] = []
  const errors: string[] = []
  const sink: LoggerSink = {
    log: (...a) => lines.push(a.map(String).join(' ')),
    error: (...a) => errors.push(a.map(String).join(' ')),
  }
  return { sink, lines, errors }
}

/** Settle continuations run in promise microtasks — flush before asserting. */
const flush = () => new Promise(r => setTimeout(r, 0))

/** Query activation + fetch kick-off are microtask-deferred (same as query.test). */
const tick = () => new Promise(r => setTimeout(r, 5))

/** A fetcher whose promises resolve only when the test says so. */
function controlledFetcher<T>() {
  const calls: { args: unknown[]; resolve: (v: T) => void; reject: (e: unknown) => void }[] = []
  const fetcher = (...args: unknown[]) =>
    new Promise<T>((resolve, reject) => {
      calls.push({ args, resolve, reject })
    })
  return { fetcher, calls }
}

const quiet = { colors: false as const, timestamps: false }

describe('logInterceptor: updates', () => {
  it('prints the timeline line with args, scope, and patch-based diffs', () => {
    const cart = atom('cart', { items: [] as string[], total: 0 })
    const add = update('cart/add', { cart }, (d, item: string) => {
      d.cart.items.push(item)
      d.cart.total += 1
    })
    const { sink, lines } = makeSink()
    const dispose = logInterceptor({ ...quiet, logger: sink })

    add('apple')
    dispose()

    expect(lines[0]).toMatch(/^update\s+cart\/add\s+\("apple"\)\s+wrote: cart$/)
    expect(lines).toContainEqual('  │ cart.items[0]: + "apple"')
    expect(lines).toContainEqual('  │ cart.total: 0 → 1')
  })

  it('annotates origin for updates fired inside events, and names undo records', async () => {
    const cart = atom('cart', { total: 0 })
    const set = update('cart/set', { cart }, (d, v: number) => { d.cart.total = v })
    const submit = event('checkout/submit', async () => { set(10) })
    const { sink, lines } = makeSink()
    const dispose = logInterceptor({ ...quiet, logger: sink })

    const undo = set(5)
    undo()
    await submit()
    await flush()
    dispose()

    expect(lines.find(l => l.includes('cart/set.undo'))).toBeDefined()
    expect(lines.find(l => l.includes('cart/set') && l.includes('← checkout/submit'))).toBeDefined()
  })

  it('renders zero-patch updates as ∅ no-op, and noops: false drops them', () => {
    const cart = atom('cart', { total: 0 })
    const setIfChanged = update('cart/set', { cart }, (d, v: number) => {
      if (d.cart.total !== v) d.cart.total = v
    })

    const shown = makeSink()
    const d1 = logInterceptor({ ...quiet, logger: shown.sink })
    setIfChanged(0) // equality-guarded: recipe runs, nothing changes
    d1()
    expect(shown.lines[0]).toMatch(/^update\s+cart\/set\s+\(0\)\s+∅ no-op$/)
    expect(shown.lines.join('\n')).not.toContain('wrote:')

    const dropped = makeSink()
    const d2 = logInterceptor({ ...quiet, noops: false, logger: dropped.sink })
    setIfChanged(0)
    setIfChanged(5) // a real write still prints
    d2()
    expect(dropped.lines).toHaveLength(2)
    expect(dropped.lines[0]).toContain('wrote: cart')
  })

  it("state: 'scope' prints the written atoms' post-update values", () => {
    const cart = atom('cart', { items: [] as string[], total: 0 })
    const add = update('cart/add', { cart }, (d, item: string) => {
      d.cart.items.push(item)
      d.cart.total += 1
    })
    const { sink, lines } = makeSink()
    const dispose = logInterceptor({ ...quiet, state: 'scope', logger: sink })

    add('apple')
    dispose()

    expect(lines).toContainEqual('  │ cart = {items: ["apple"], total: 1}')
  })
})

describe('logInterceptor: event lifecycle', () => {
  it('pairs fire and settle, printing outcome with duration', async () => {
    const sync = event('sync/now', async () => 'ok')
    const { sink, lines } = makeSink()
    const dispose = logInterceptor({ ...quiet, logger: sink })

    await sync()
    await flush()
    dispose()

    expect(lines[0]).toMatch(/^event\s+sync\/now$/)
    expect(lines[1]).toMatch(/^event\s+sync\/now\s+✓ \d+ms$/)
  })

  it('routes failed settles through error with the message', async () => {
    const boom = event('sync/now', async () => { throw new Error('offline') })
    const { sink, errors } = makeSink()
    const dispose = logInterceptor({ ...quiet, logger: sink })

    await boom().catch(() => {})
    await flush()
    dispose()

    expect(errors.find(l => /✗ \d+ms Error: offline/.test(l))).toBeDefined()
  })

  it('marks switch-superseded runs as ⊘, not outcomes', async () => {
    const load = event(
      'profile/load',
      async (signal: AbortSignal) => { await new Promise(r => setTimeout(r, 5)) },
      { concurrency: 'switch' },
    )
    const { sink, lines } = makeSink()
    const dispose = logInterceptor({ ...quiet, logger: sink })

    const p1 = load()
    const p2 = load()
    await Promise.all([p1, p2])
    await flush()
    dispose()

    expect(lines.find(l => l.includes('⊘ superseded'))).toBeDefined()
    expect(lines.filter(l => l.includes('✓')).length).toBe(1)
  })

  it('labels streamEvent fires as stream, and streams: false silences them', () => {
    const input = streamEvent<string>('search/input')
    const first = makeSink()
    const d1 = logInterceptor({ ...quiet, logger: first.sink })
    input('gro')
    d1()
    expect(first.lines[0]).toMatch(/^stream\s+search\/input\s+\("gro"\)$/)

    const second = makeSink()
    const d2 = logInterceptor({ ...quiet, streams: false, logger: second.sink })
    input('groc')
    d2()
    expect(second.lines).toHaveLength(0)
  })
})

describe('logInterceptor: queries', () => {
  it('narrates activation fetch → ✓ with duration, and direct invalidation → stale + refetch', async () => {
    const { fetcher, calls } = controlledFetcher<string[]>()
    const accounts = query('accounts', fetcher, { staleTime: 60_000, default: [] as string[] })
    const { sink, lines } = makeSink()
    const dispose = logInterceptor({ ...quiet, logger: sink })

    const node = accounts('professional') as any
    const off = node.onChange(() => {})
    node.get()
    await tick()
    expect(lines[0]).toMatch(/^query\s+accounts\("professional"\)\s+⇣ fetch \(activate\)$/)

    calls[0]!.resolve(['github'])
    await tick()
    expect(lines[1]).toMatch(/^query\s+accounts\("professional"\)\s+✓ \d+ms$/)

    // direct call (the retry-button path): no origin on the stale line
    invalidate(accounts('professional'))
    await tick()
    expect(lines[2]).toMatch(/^query\s+accounts\("professional"\)\s+stale$/)
    expect(lines[3]).toMatch(/⇣ fetch \(invalidate\)/)

    calls[1]!.resolve(['github'])
    await tick()
    off()
    dispose()
  })

  it('routes ✗ through error, and ties a family-wide invalidation to its mutation', async () => {
    const { fetcher, calls } = controlledFetcher<string>()
    const accounts = query('accounts', fetcher)
    const save = mutation('link/save', async () => {}, { invalidates: [accounts] })
    const { sink, lines, errors } = makeSink()
    const dispose = logInterceptor({ ...quiet, logger: sink })

    const node = accounts('consumer') as any
    const off = node.onChange(() => {})
    node.get()
    await tick()
    calls[0]!.reject(new Error('Failed to load accounts'))
    await tick()
    expect(
      errors.find(l => /query\s+accounts\("consumer"\)\s+✗ \d+ms Error: Failed to load accounts/.test(l)),
    ).toBeDefined()

    await save()
    await flush()
    expect(lines.find(l => /^query\s+accounts\(\*\)\s+stale ← link\/save$/.test(l))).toBeDefined()
    off()
    dispose()
  })

  it('queries: false silences query narration', async () => {
    const { fetcher, calls } = controlledFetcher<string>()
    const q = query('silent', fetcher)
    const { sink, lines } = makeSink()
    const dispose = logInterceptor({ ...quiet, queries: false, logger: sink })

    const node = q('x') as any
    const off = node.onChange(() => {})
    node.get()
    await tick()
    calls[0]!.resolve('v')
    await tick()
    expect(lines).toHaveLength(0)
    off()
    dispose()
  })
})

describe('logInterceptor: selection', () => {
  it('filter globs include, exclude wins, predicates decide alone', () => {
    const cart = atom('cart', { total: 0 })
    const other = atom('other', { v: 0 })
    const setTotal = update('cart/set', { cart }, (d, v: number) => { d.cart.total = v })
    const secret = update('cart/secretSet', { cart }, (d, v: number) => { d.cart.total = v })
    const setOther = update('other/set', { other }, (d, v: number) => { d.other.v = v })

    const globbed = makeSink()
    const d1 = logInterceptor({
      ...quiet,
      filter: ['cart/*'],
      exclude: 'cart/secret*',
      logger: globbed.sink,
    })
    setTotal(1)
    secret(2)
    setOther(3)
    d1()
    expect(globbed.lines.filter(l => l.startsWith('update'))).toHaveLength(1)
    expect(globbed.lines[0]).toContain('cart/set')

    const predicated = makeSink()
    const d2 = logInterceptor({
      ...quiet,
      filter: (_name, kind) => kind === 'stream',
      logger: predicated.sink,
    })
    setTotal(4)
    streamEvent<string>('search/input')('gro')
    d2()
    expect(predicated.lines).toHaveLength(1)
    expect(predicated.lines[0]).toContain('search/input')
  })

  it('redact globs mask args and suppress diffs; redact fn maps display args', async () => {
    const auth = atom('auth', { token: '' })
    const setToken = update('auth/setToken', { auth }, (d, t: string) => { d.auth.token = t })
    const globbed = makeSink()
    const d1 = logInterceptor({ ...quiet, redact: 'auth/*', logger: globbed.sink })
    setToken('hunter2')
    d1()
    expect(globbed.lines[0]).toContain('[redacted]')
    expect(globbed.lines.join('\n')).not.toContain('hunter2')

    const login = event('auth/login', async (_pw: string) => {})
    const mapped = makeSink()
    const d2 = logInterceptor({
      ...quiet,
      redact: (_name, args) => args.map(() => '***'),
      logger: mapped.sink,
    })
    await login('hunter2')
    await flush()
    d2()
    expect(mapped.lines[0]).toContain('("***")')
    expect(mapped.lines.join('\n')).not.toContain('hunter2')
  })
})

describe('logInterceptor: output modes', () => {
  it('prefers the configured level when the sink has it', () => {
    const cart = atom('cart', { total: 0 })
    const set = update('cart/set', { cart }, (d, v: number) => { d.cart.total = v })
    const debugLines: string[] = []
    const logLines: string[] = []
    const sink: LoggerSink = {
      log: (...a) => logLines.push(a.map(String).join(' ')),
      debug: (...a) => debugLines.push(a.map(String).join(' ')),
      error: () => {},
    }
    const dispose = logInterceptor({ ...quiet, logger: sink })
    set(1)
    dispose()
    expect(debugLines.length).toBeGreaterThan(0)
    expect(logLines).toHaveLength(0)
  })

  it('colors: true uses %c-styled collapsed groups for updates', () => {
    const cart = atom('cart', { total: 0 })
    const set = update('cart/set', { cart }, (d, v: number) => { d.cart.total = v })
    const groups: string[] = []
    let ended = 0
    const sink: LoggerSink = {
      log: () => {},
      error: () => {},
      groupCollapsed: (...a) => groups.push(String(a[0])),
      groupEnd: () => { ended += 1 },
    }
    const dispose = logInterceptor({ colors: true, timestamps: false, logger: sink })
    set(1)
    dispose()
    expect(groups[0]).toContain('%cupdate%c cart/set')
    expect(ended).toBe(1)
  })

  it('timestamps render as HH:MM:SS.mmm', () => {
    const cart = atom('cart', { total: 0 })
    const set = update('cart/set', { cart }, (d, v: number) => { d.cart.total = v })
    const { sink, lines } = makeSink()
    const dispose = logInterceptor({ colors: false, logger: sink })
    set(1)
    dispose()
    expect(lines[0]).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}$/)
  })
})

describe('logInterceptor: always-on signals and lifecycle', () => {
  it('reaction loops print through error regardless of filters', () => {
    const { sink, errors } = makeSink()
    const dispose = logInterceptor({ ...quiet, filter: 'nothing/*', logger: sink })
    runReactionLoop('cart/mirror', ['cart/mirror', 'cart/set'])
    dispose()
    expect(errors[0]).toContain('reaction loop circuit-broken: cart/mirror')
    expect(errors[0]).toContain('cart/mirror → cart/set')
  })

  it('dispose stops all narration', () => {
    const cart = atom('cart', { total: 0 })
    const set = update('cart/set', { cart }, (d, v: number) => { d.cart.total = v })
    const { sink, lines } = makeSink()
    const dispose = logInterceptor({ ...quiet, logger: sink })
    set(1)
    dispose()
    set(2)
    expect(lines.filter(l => l.startsWith('update'))).toHaveLength(1)
  })

  it('a throwing sink never breaks the update itself', () => {
    const cart = atom('cart', { total: 0 })
    const set = update('cart/set', { cart }, (d, v: number) => { d.cart.total = v })
    const sink: LoggerSink = {
      log: () => { throw new Error('sink exploded') },
      error: () => {},
    }
    const dispose = logInterceptor({ ...quiet, logger: sink })
    expect(() => set(1)).not.toThrow()
    expect(cart.total.peek()).toBe(1)
    dispose()
  })
})
