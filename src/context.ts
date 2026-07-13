/**
 * Causal-attribution context. Set synchronously around the portions of event
 * handlers / reactions the runtime controls; updates read it to stamp their
 * origin. Best-effort by design: attribution survives until the handler's
 * first `await` (zone-less environments — RN/browser — can't do better without
 * instrumentation; Node could use AsyncLocalStorage later if it earns it).
 */
let current: string | null = null

export function runWithOrigin<T>(origin: string, fn: () => T): T {
  const prev = current
  current = origin
  try {
    return fn()
  } finally {
    current = prev
  }
}

export function currentOrigin(): string | null {
  return current
}
