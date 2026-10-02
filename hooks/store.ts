// The values scripts keep with store() and load(), one entry per session in the
// plugin's own key-value store ($.store), so they outlive a resume or a restart.
// $.store is shared by every session and holds 4 MiB in all, so the oldest
// sessions' entries are dropped once there are too many.

import type { CodemodeJson } from '../types'

/** The part of `$.store` the session store needs; register.ts makes the `$` calls. */
export type KeyValue = {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
  delete: (key: string) => Promise<void>
  keys: () => Promise<string[]>
}

type Entry = { savedAt: number; values: Record<string, CodemodeJson> }

const PREFIX = 'session:'
const MAX_SESSIONS = 50
/** Under $.store's 4 MiB, with room for the entry being written. */
const MAX_TOTAL_CHARS = 3_000_000

export async function loadSessionStore(kv: KeyValue, sessionId: string): Promise<Record<string, CodemodeJson>> {
  const entry = await kv.get(PREFIX + sessionId)
  return isEntry(entry) ? entry.values : {}
}

export async function saveSessionStore(kv: KeyValue, sessionId: string, values: Record<string, CodemodeJson>): Promise<void> {
  const key = PREFIX + sessionId
  if (Object.keys(values).length === 0) await kv.delete(key)
  else await kv.set(key, { savedAt: Date.now(), values } satisfies Entry)
  await prune(kv, key)
}

/** Drops the least recently saved sessions past MAX_SESSIONS or MAX_TOTAL_CHARS, never `keep`. */
async function prune(kv: KeyValue, keep: string): Promise<void> {
  const keys = (await kv.keys()).filter(key => key.startsWith(PREFIX))
  const sessions = await Promise.all(
    keys.map(async key => {
      const entry = await kv.get(key)
      return { key, savedAt: isEntry(entry) ? entry.savedAt : 0, chars: JSON.stringify(entry ?? null).length }
    }),
  )
  sessions.sort((a, b) => a.savedAt - b.savedAt)
  let total = sessions.reduce((sum, session) => sum + session.chars, 0)
  let count = sessions.length
  for (const session of sessions) {
    if (count <= MAX_SESSIONS && total <= MAX_TOTAL_CHARS) break
    if (session.key === keep) continue
    await kv.delete(session.key)
    total -= session.chars
    count -= 1
  }
}

function isEntry(value: unknown): value is Entry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Partial<Entry>
  return typeof entry.savedAt === 'number' && typeof entry.values === 'object' && entry.values !== null
}
