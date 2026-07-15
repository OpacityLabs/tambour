// A command: named, awaitable, exhaust-protected. Mash the button — re-fires
// return the in-flight promise and statusOf stays truthful (one pending).

import { event } from 'concordia'
import { pullTodos } from '../api'
import { mergeServerTodos } from './todos'

export const syncNow = event(
  'sync/now',
  async () => {
    const incoming = await pullTodos()
    mergeServerTodos(incoming) // a named update — `sync/now → todos/mergeServer` on the timeline
  },
  { concurrency: 'exhaust' },
)
