// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { event } from '../src/events'
import { statusOf } from '../src/status'
import { use$ } from '../src/react'

afterEach(() => cleanup())

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/**
 * The mutation-DX claims under test:
 *
 * 1. Fire and settle each assign multiple status fields (pending/success/
 *    error) in ONE batch → a component holding several per-field use$ hooks
 *    renders exactly once per moment.
 * 2. No torn frame is observable: never { pending: true, success: true },
 *    never a settle where success lands a render after pending.
 * 3. Per-field silence: an error-only subscriber stays silent through a whole
 *    successful fire→settle cycle (error never changes value).
 */
describe('statusOf granularity through use$', () => {
  it('one render per moment, frames never torn, error subscriber silent on success', async () => {
    const gate = deferred<string>()
    const save = event('gran/save', () => gate.promise)
    const status$ = statusOf(save) as any

    const frames: { pending: boolean; success: boolean }[] = []
    let errorRenders = 0

    function StatusProbe() {
      const pending = use$(status$.pending) as boolean
      const success = use$(status$.success) as boolean
      frames.push({ pending, success })
      return null
    }
    function ErrorProbe() {
      errorRenders++
      use$(status$.error)
      return null
    }

    render(<><StatusProbe /><ErrorProbe /></>)
    expect(frames).toEqual([{ pending: false, success: false }]) // 1: idle

    let p!: Promise<unknown>
    act(() => { p = save() })
    expect(frames.length).toBe(2) // 2: fire — one render, not one per field

    await act(async () => {
      gate.resolve('ok')
      await p
      await sleep(1)
    })
    expect(frames).toEqual([
      { pending: false, success: false }, // idle
      { pending: true, success: false }, // in flight
      { pending: false, success: true }, // saved — same render as the pending flip
    ])

    expect(errorRenders).toBe(1) // error stayed undefined → never notified
  })
})
