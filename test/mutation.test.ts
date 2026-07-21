import { describe, expect, it } from 'vitest'
import { observable } from '@legendapp/state'
import { mutation } from '../src/mutation'
import { query } from '../src/query'
import { statusOf } from '../src/status'
import { eventToStream } from '../src/events'
import { update } from '../src/update'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const tick = () => sleep(5) // activation + fetch kick-off are microtask-deferred

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** A fetcher whose promises resolve only when the test says so. */
function controlledFetcher<T>() {
  const calls: { args: unknown[]; resolve: (v: T) => void; reject: (e: unknown) => void }[] = []
  const fetcher = (...args: unknown[]) =>
    new Promise<T>((resolve, reject) => {
      calls.push({ args, resolve, reject })
    })
  return { fetcher, calls }
}

describe('mutation IS an event', () => {
  it('awaitable with a result, statusOf works, and .status is the very same node', async () => {
    const save = mutation('m/save', async (x: number) => x * 2)

    expect(save.status).toBe(statusOf(save)) // carried metadata ≡ the accessor
    expect(save.status.get()).toEqual({ pending: false, inFlight: 0, error: undefined, success: false })

    const result = await save(21)
    expect(result).toBe(42)
    await tick()
    expect(save.status.get().success).toBe(true)
  })

  it('keeps event services: eventToStream taps fires, rejections land on error', async () => {
    const fail = mutation('m/fail', async () => { throw new Error('nope') })

    const seen: unknown[] = []
    const sub = eventToStream(fail).subscribe(p => seen.push(p))
    await fail().catch(() => {})
    await tick()

    expect(seen.length).toBe(1) // the tap saw the fire
    expect((fail.status.get().error as Error).message).toBe('nope')
    expect(fail.status.get().success).toBe(false)
    sub.unsubscribe()
  })
})

describe('mutation invalidates on settle', () => {
  it('success: listed queries go stale and active keys refetch', async () => {
    const { fetcher, calls } = controlledFetcher<number>()
    const q = query('m/inv-ok', fetcher, { staleTime: 60_000, default: 0 })

    const node = q() as any
    const dispose = node.onChange(() => {})
    node.get()
    await tick()
    calls[0]!.resolve(1)
    await tick()
    expect(calls.length).toBe(1) // fresh — nothing refetching

    const bump = mutation('m/bump', async () => 'ok', { invalidates: [q] })
    await bump()
    await tick()
    expect(calls.length).toBe(2) // settle → stale → active key refetched
    calls[1]!.resolve(2)
    await tick()
    expect(node.get().data).toBe(2)
    dispose()
  })

  it('error: still invalidates — the request may have landed server-side', async () => {
    const { fetcher, calls } = controlledFetcher<number>()
    const q = query('m/inv-err', fetcher, { staleTime: 60_000, default: 0 })

    const node = q() as any
    const dispose = node.onChange(() => {})
    node.get()
    await tick()
    calls[0]!.resolve(1)
    await tick()

    const bump = mutation('m/bump-err', async () => { throw new Error('boom') }, { invalidates: [q] })
    await bump().catch(() => {})
    await tick()
    expect(calls.length).toBe(2) // refetch resyncs truth after a failed write
    calls[1]!.resolve(1)
    await tick()
    dispose()
  })

  it('a static NODE entry invalidates only that key; sibling keys stay fresh', async () => {
    const { fetcher, calls } = controlledFetcher<number>()
    const q = query('m/keyed-static', fetcher, { staleTime: 60_000, default: 0 })
    const callsFor = (key: string) => calls.filter(c => c.args[0] === key)

    // two active, fresh keys
    const a = q('a') as any
    const b = q('b') as any
    const disposeA = a.onChange(() => {})
    const disposeB = b.onChange(() => {})
    a.get(); b.get()
    await tick()
    callsFor('a')[0]!.resolve(1)
    callsFor('b')[0]!.resolve(1)
    await tick()

    const bump = mutation('m/bump-a', async () => 'ok', { invalidates: [q('a')] })
    await bump()
    await tick()
    expect(callsFor('a').length).toBe(2) // 'a' refetched
    expect(callsFor('b').length).toBe(1) // 'b' untouched
    callsFor('a')[1]!.resolve(2)
    await tick()
    disposeA(); disposeB()
  })

  it('the function form receives the mutation call args — keyed invalidation per entry', async () => {
    const { fetcher, calls } = controlledFetcher<number>()
    const todoDetail = query('m/keyed-dyn', fetcher, { staleTime: 60_000, default: 0 })
    const callsFor = (key: string) => calls.filter(c => c.args[0] === key)

    const a = todoDetail('a') as any
    const b = todoDetail('b') as any
    const disposeA = a.onChange(() => {})
    const disposeB = b.onChange(() => {})
    a.get(); b.get()
    await tick()
    callsFor('a')[0]!.resolve(1)
    callsFor('b')[0]!.resolve(1)
    await tick()

    const toggle = mutation('m/toggle', async (_id: string) => 'ok', {
      invalidates: ([id]) => [todoDetail(id)],
    })
    await toggle('b')
    await tick()
    expect(callsFor('b').length).toBe(2) // the arg picked the key
    expect(callsFor('a').length).toBe(1) // sibling untouched
    callsFor('b')[1]!.resolve(2)
    await tick()
    disposeA(); disposeB()
  })

  it('with switch, the callback gets the ORIGINAL args — never the AbortSignal', async () => {
    const received: unknown[][] = []
    const save = mutation(
      'm/switch-args',
      async (_id: string, _signal: AbortSignal) => 'ok',
      {
        concurrency: 'switch',
        invalidates: args => {
          received.push(args)
          return []
        },
      },
    )

    await save('x')
    await tick()
    expect(received).toEqual([['x']]) // just the call args, signal stripped
  })

  it('with retry, invalidation runs ONCE on the final settle — never per attempt', async () => {
    const { fetcher, calls } = controlledFetcher<number>()
    const q = query('m/inv-retry', fetcher, { staleTime: 60_000, default: 0 })

    const node = q() as any
    const dispose = node.onChange(() => {})
    node.get()
    await tick()
    calls[0]!.resolve(1)
    await tick()

    let attempts = 0
    const save = mutation('m/retrying', async () => {
      attempts++
      if (attempts < 3) throw new Error('flaky')
    }, { retry: 2, retryDelay: 0, invalidates: [q] })

    await save()
    await tick()
    expect(attempts).toBe(3)
    expect(calls.length).toBe(2) // exactly one refetch — failed attempts invalidated nothing
    calls[1]!.resolve(2)
    await tick()
    dispose()
  })

  it('switch: a superseded run never invalidates; the surviving run does — once', async () => {
    const { fetcher, calls } = controlledFetcher<number>()
    const q = query('m/inv-switch', fetcher, { staleTime: 60_000, default: 0 })

    const node = q() as any
    const dispose = node.onChange(() => {})
    node.get()
    await tick()
    calls[0]!.resolve(1)
    await tick()

    const gates: ReturnType<typeof deferred<string>>[] = []
    const save = mutation(
      'm/switchsave',
      (_v: string, _signal: AbortSignal) => {
        const d = deferred<string>()
        gates.push(d)
        return d.promise // deliberately ignores the abort signal
      },
      { concurrency: 'switch', invalidates: [q] },
    )

    save('a')
    save('b') // supersedes 'a'
    gates[0]!.resolve('a-finished-anyway')
    await tick()
    expect(calls.length).toBe(1) // superseded settle: NO invalidation

    gates[1]!.resolve('b-done')
    await tick()
    expect(calls.length).toBe(2) // the surviving run invalidated, exactly once
    calls[1]!.resolve(2)
    await tick()
    dispose()
  })
})

describe('the optimistic recipe, end to end', () => {
  it('flips instantly, rolls back on failure, and status stays truthful', async () => {
    const todos = observable({
      items: [{ id: 't1', done: false }, { id: 't2', done: false }],
    }) as any

    const applyToggle = update('opt/toggle', { t: todos }, (d, id: string) => {
      const todo = d.t.items.find((t: any) => t.id === id)
      todo.done = !todo.done
    })

    const gate = deferred<void>()
    const toggleTodo = mutation('opt/toggleTodo', async (id: string) => {
      const undo = applyToggle(id)     // optimistic — synchronous, instant
      try {
        await gate.promise             // the server call
      } catch (e) {
        undo()                         // rollback = apply the inverse
        throw e
      }
    })

    const p = toggleTodo('t1').catch(() => {})
    // BEFORE the server settles: the UI already flipped
    expect(todos.items[0].done.peek()).toBe(true)

    gate.reject(new Error('500'))
    await p
    await tick()

    // rolled back — and only the touched leaf; t2 untouched throughout
    expect(todos.items.peek()).toEqual([
      { id: 't1', done: false },
      { id: 't2', done: false },
    ])
    const s = statusOf(toggleTodo).get()
    expect((s.error as Error).message).toBe('500')
    expect(s.success).toBe(false)
  })
})
