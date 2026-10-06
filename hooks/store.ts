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

/** A script's store() calls, by key: the value it set, or undefined for a key it deleted. */
export type StoreChanges = Map<string, CodemodeJson | undefined>

const PREFIX = 'session:'
const MAX_SESSIONS = 50
/** Under $.store's 4 MiB, with room for the entry being written. */
const MAX_TOTAL_CHARS = 3_000_000

/** Each session's save in progress: two scripts' saves run one after the other, so neither reads before the other writes. */
const saving = new Map<string, Promise<void>>()

export async function loadSessionStore(kv: KeyValue, sessionId: string): Promise<Record<string, CodemodeJson>> {
  const entry = await kv.get(PREFIX + sessionId)
  return isEntry(entry) ? entry.values : {}
}

/**
 * Applies a script's changes onto the session's values as saved now, not as the script found them, so
 * scripts running side by side keep each other's keys.
 */
export async function saveSessionStore(kv: KeyValue, sessionId: string, changes: StoreChanges): Promise<void> {
  const save = (saving.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const key = PREFIX + sessionId
    const values = await loadSessionStore(kv, sessionId)
    for (const [name, value] of changes) {
      if (value === undefined) delete values[name]
      else values[name] = value
    }
    if (Object.keys(values).length === 0) await kv.delete(key)
    else await kv.set(key, { savedAt: Date.now(), values } satisfies Entry)
    await prune(kv, key)
  })
  saving.set(sessionId, save)
  try {
    await save
  } finally {
    if (saving.get(sessionId) === save) saving.delete(sessionId)
  }
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
