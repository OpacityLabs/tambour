import { resetAll, restore, snapshot } from './atom'
import { addInterceptor } from './interceptors'

/**
 * The subset of the Redux DevTools Extension connection we speak. Injectable
 * for tests and for RN (where the extension arrives via different transports).
 */
export interface DevtoolsConnector {
  init(state: unknown): void
  send(action: Record<string, unknown>, state: unknown): void
  subscribe(listener: (message: any) => void): (() => void) | void
}

export interface DevtoolsOptions {
  /** Instance name shown in the extension UI. */
  name?: string
  /** Inject a connector (tests / RN transports). Default: the browser extension. */
  connector?: DevtoolsConnector
}

/**
 * Redux DevTools Extension adapter — patches serialize cleanly into its action
 * log, and time travel works by restoring full atom snapshots (the extension
 * stores per-action states and hands them back on jump).
 *
 * Speaks the extension's message protocol only; the `redux` package is not
 * involved. Everything here is an interceptor — the core doesn't know devtools
 * exist. Returns a dispose function.
 */
export function connectDevtools(options: DevtoolsOptions = {}): () => void {
  const extension = (globalThis as any).__REDUX_DEVTOOLS_EXTENSION__
  const connector: DevtoolsConnector | undefined =
    options.connector ?? extension?.connect({ name: options.name ?? 'concordia' })
  if (!connector) return () => {}   // no extension, no cost

  connector.init(snapshot())

  const unsubscribeMessages = connector.subscribe(message => {
    if (message?.type !== 'DISPATCH') return
    const kind = message.payload?.type
    if (kind === 'JUMP_TO_ACTION' || kind === 'JUMP_TO_STATE') {
      restore(JSON.parse(message.state))
    } else if (kind === 'RESET') {
      resetAll()
      connector.init(snapshot())
    } else if (kind === 'COMMIT') {
      connector.init(snapshot())
    }
  })

  const removeInterceptor = addInterceptor({
    after: record =>
      connector.send(
        {
          type: record.name,
          args: record.args,
          scope: record.scope,
          ...(record.origin ? { origin: record.origin } : {}),
          patches: record.patches,
        },
        snapshot(),
      ),
    onEventFire: (name, args) => connector.send({ type: `event ${name}`, args }, snapshot()),
    onEventError: (name, error, args) =>
      connector.send({ type: `event:error ${name}`, error: String(error), args }, snapshot()),
    onReactionLoop: (name, chain) =>
      connector.send({ type: `reaction:loop ${name}`, chain }, snapshot()),
  })

  return () => {
    removeInterceptor()
    if (typeof unsubscribeMessages === 'function') unsubscribeMessages()
  }
}
