import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallArgs } from 'claude-code'

import type { CodemodeCalls, CodemodeDiffs, CodemodeFollow, CodemodeJson, CodemodeNode, CodemodePane, CodemodePaneEvent } from '../types'

import { inlineDeclarations, loadDeclarations } from './declarations'
import { drawPane, type DrawnImage, type PaneElements } from './pane-view'
import {
  MAX_FOLLOWS,
  addFollowed,
  answerText,
  checkSize,
  endFollow,
  fillPrompt,
  inboxNote,
  outputLine,
  paneWriter,
  pushEvent,
  setAt,
  splitOutput,
  taskFileOf,
  utf8Bytes,
  viewOf,
  type FollowSpec,
  type PaneHost,
} from './panes'
import { DESCRIPTION, TOOL_NAME, inputSchema, runScript, toolResult, type Host, type RunContext } from './runner'
import { argsOf, commandArgs, findSaved, listSaved, savedListing, savedPlaces, savedReport, type SavedFs, type SavedMeta, type SavedPlace } from './saved'
import { loadSessionStore, saveSessionStore, type KeyValue } from './store'
import { drawToolResult, drawToolUse, hasImages } from './view'

/** Each codemode call's tool calls, by the call's tool_use_id, for its row. */
const callsByRun = atom({ plugin: 'codemode', key: 'calls' } as const, undefined as unknown as CodemodeCalls)
/** Whether each codemode row shows its whole script, by tool_use_id. */
const isExpandedByRun = atom({ plugin: 'codemode', key: 'isExpanded' } as const, false)
/** Whether each codemode result shows all its lines, by tool_use_id. */
const isResultExpandedByRun = atom({ plugin: 'codemode', key: 'isResultExpanded' } as const, false)
/** The file changes each codemode call's tool calls made, by tool_use_id, drawn under its result. */
const diffsByRun = atom({ plugin: 'codemode', key: 'diffs' } as const, { files: [], more: 0 } as CodemodeDiffs)
/** Each script-opened pane's record, by pane id. */
const paneById = atom({ plugin: 'codemode', key: 'pane' } as const, null as CodemodePane | null)
/** The ids of the session's pane records. */
const paneIds = atom({ plugin: 'codemode', key: 'paneIds' } as const, [] as string[])
/** The output files of this session's background Bash commands, newest last. */
const taskFiles = atom({ plugin: 'codemode', key: 'taskFiles' } as const, [] as string[])
const pixels = atom({ plugin: 'codemode', key: 'pixels' } as const, null as boolean | null)
/** Task output files remembered; the oldest drop off. */
const MAX_TASK_FILES = 200

/** The built-in tools' inputs the script parameter carries, made on session.start. */
let reference = ''
/** The saved-script folders as last listed (names, sizes, times), so a prompt re-registers only on a change. */
let savedStamp: string | undefined
/** How much of the saved scripts' names the command's hint shows. */
const MAX_HINT_CHARS = 80

function savedFsOf($: EngineInterface): SavedFs {
  return {
    list: async dir => {
      if (!(await $.fs.exists(dir))) return undefined
      return (await $.fs.list(dir)).filter(entry => entry.kind === 'file' || entry.isLink).map(entry => entry.name)
    },
    read: async path => String(await $.fs.read(path)),
  }
}

async function savedPlacesOf($: EngineInterface): Promise<SavedPlace[]> {
  const [root, home] = await Promise.all([$.session.root().catch(() => undefined), $.env.get('HOME').catch(() => undefined)])
  return savedPlaces(root, home ?? undefined)
}

/** What the saved-script folders hold now, by name, size and time; cheap to compare each prompt. */
async function savedStampOf($: EngineInterface, places: SavedPlace[]): Promise<string> {
  const parts = await Promise.all(
    places.map(async place => {
      try {
        if (!(await $.fs.exists(place.dir))) return `${place.dir}:-`
        const entries = await $.fs.list(place.dir)
        return `${place.dir}:${entries.map(entry => `${entry.name}/${entry.size}/${entry.mtimeMs}`).join(',')}`
      } catch {
        return `${place.dir}:?`
      }
    }),
  )
  return parts.join('|')
}

/**
 * Registers the tool, its name parameter listing the saved scripts, and /codemode with their names as
 * its hint; again only when the folders changed since, so the tool list stays as the prompt cached it.
 */
/** The saved script `name` and its checked args, or why it can't run: missing, not loading, or the args wrong. */
async function savedScript(
  $: EngineInterface,
  name: string,
  argsFor: (found: { name: string; meta: SavedMeta }) => Record<string, CodemodeJson>,
): Promise<{ script: string; args: Record<string, CodemodeJson> } | { error: string }> {
  const places = await savedPlacesOf($)
  const fs = savedFsOf($)
  try {
    const found = await findSaved(fs, places, name)
    if (found === undefined) {
      const names = (await listSaved(fs, places)).filter(entry => entry.error === undefined).map(entry => entry.name)
      return { error: `no saved script "${name}". ${names.length === 0 ? `None are saved: save one as ${places.map(place => `${place.dir}/${name}.js`).join(' or ')}.` : `Saved: ${names.join(', ')}.`}` }
    }
    return { script: found.script, args: argsFor(found) }
  } catch (thrown) {
    return { error: thrown instanceof Error ? thrown.message : String(thrown) }
  }
}

async function registerTool($: EngineInterface): Promise<void> {
  const places = await savedPlacesOf($)
  const stamp = await savedStampOf($, places)
  if (stamp === savedStamp) return
  savedStamp = stamp
  const entries = await listSaved(savedFsOf($), places)
  await $.tool.register({ name: TOOL_NAME, description: DESCRIPTION, inputSchema: inputSchema(reference, savedListing(entries)) })
  const names = entries.filter(entry => entry.error === undefined).map(entry => entry.name).join('|')
  await $.command.register({
    name: 'codemode',
    description: 'Run a saved codemode script, or list them',
    argumentHint: names === '' ? '[name] [args]' : `[${names.length > MAX_HINT_CHARS ? `${names.slice(0, MAX_HINT_CHARS - 1)}…` : names}] [args]`,
  })
}


/** Scripts waiting in ui.wait() for the person to act in a pane, by pane id; a reload ends those scripts anyway. */
const waiters = new Map<string, Set<() => void>>()
function notify(id: string): void {
  const waiting = waiters.get(id)
  waiters.delete(id)
  for (const wake of waiting ?? []) wake()
}

/** How often a wait wakes to check for an event or its end. */
const IDLE_SLICE_MS = 250

/**
 * Waits up to `ms` without spending the hook's budget, ending early once `isDone()` or `signal` says so.
 * A hook has 10 s of its own time, and a `$.clock` wait counts against it; any other `$` call in flight
 * does not, so the wait is short `sleep` processes, checked between.
 */
async function idle($: EngineInterface, ms: number, signal: AbortSignal, isDone: () => boolean = () => false): Promise<void> {
  const end = Date.now() + ms
  while (!signal.aborted && !isDone()) {
    const left = end - Date.now()
    if (left <= 0) return
    const slice = Math.min(left, IDLE_SLICE_MS)
    await $.process.run(['sleep', (slice / 1000).toFixed(3)], { timeoutMs: slice + 1000 })
  }
}

/** Writes pane records through `$`, keeping the id list in step; a removed pane's follows stop. */
function recordWriter($: EngineInterface) {
  return paneWriter(async (id, apply) => {
    let result: CodemodePane | null = null
    await update($, memberOf(paneById, { requestId: id }), (pane: CodemodePane | null) => (result = apply(pane)))
    const ids = await read($, paneIds)
    const isListed = ids.includes(id)
    if (result === null ? isListed : !isListed) {
      await update($, paneIds, list => (result === null ? list.filter(one => one !== id) : list.includes(id) ? list : [...list, id]))
    }
    if (result === null) for (const follower of followers.values()) if (follower.id === id) follower.stop()
    // session.start makes it; a host that never ran that hook starts a timer on this call's.
    if (programs !== undefined || (result as CodemodePane | null)?.program?.every !== undefined) (programs ??= programsOn($)).sync(id, result)
  })
}

/** Tool input types by tool name, read once per load. */
let declarations: Promise<Map<string, string>> | undefined

/** What a script run needs from the engine, through `$`; the tool.call hook adds its row's calls and diffs. */
/** Where codemode saves long outputs and a failed script's replies: a folder of the system's temporary one. */
async function savedFolderOf($: EngineInterface): Promise<string> {
  return `${((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')}/claude-codemode`
}

function scriptHost($: EngineInterface, extra: Pick<Host, 'showCalls' | 'showDiffs'> = {}): Host {
  const kv: KeyValue = {
    get: key => $.store.get(key),
    set: (key, value) => $.store.set(key, value),
    delete: key => $.store.delete(key),
    keys: () => $.store.keys(),
  }
  return {
    listTools: () => $.tool.list(),
    callTool: input => $.tool.call(input as unknown as ToolCallArgs),
    loadStore: async () => loadSessionStore(kv, await $.session.id()),
    saveStore: async values => saveSessionStore(kv, await $.session.id(), values),
    saveOutput: async (name, text) => {
      try {
        const path = `${await savedFolderOf($)}/${name}.txt`
        await $.fs.write(path, text)
        return path
      } catch {
        return undefined
      }
    },
    readFile: async path => String(await $.fs.read(path)),
    statFile: async path => {
      const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
      return stat?.kind === 'file' ? { size: stat.size, mtimeMs: stat.mtimeMs, realPath: stat.realPath } : undefined
    },
    savedFolder: async () => {
      const folder = await savedFolderOf($)
      return (await $.fs.stat(folder, { resolve: true }).catch(() => undefined))?.realPath
    },
    now: () => Date.now(),
    warn: text => $.ui.log(text),
    declarationOf: async tool => {
      declarations ??= loadDeclarations($.plugin.root, async path => String(await $.fs.read(path)))
      return (await declarations).get(tool.name)
    },
    // A short wait (the runner's next-turn check) stays on the clock; longer ones must not spend the budget.
    sleep: async (ms, signal) => {
      if (ms < 50) return $.clock.sleep(ms, { signal })
      await idle($, ms, signal)
      if (signal.aborted) throw new Error('The wait ended.')
    },
    complete: (request, signal) => $.model.complete(request, { signal }),
    classify: (text, labels, model) => $.model.classify(text, labels, model === undefined ? undefined : { model }),
    sessionFacts: async () => {
      const [id, cwd, projectDir, repo, turns] = await Promise.all([
        $.session.id(),
        $.session.cwd(),
        $.session.root(),
        $.session.repo().catch(() => null),
        $.session.turns(),
      ])
      return { id, cwd, projectDir, repo: repo === null ? null : { root: repo.root, remote: repo.remote }, turns }
    },
    sessionUsage: args => $.session.usage(args as Parameters<typeof $.session.usage>[0]),
    sessionMessages: args => (args === undefined ? $.session.messages() : $.session.messages(args as Parameters<typeof $.session.messages>[0])),
    ...extra,
    panes: paneHost($),
  }
}

/** Tool calls one pane's handlers and timer may make in a minute, together. */
const MAX_PROGRAM_CALLS_PER_MINUTE = 30
/** How long one handler or timer run may take, tool calls included. */
const PROGRAM_TIMEOUT_MS = 60_000
/** A run's interpreter time between two awaits: a busy loop stops instead of holding the plugin. */
const PROGRAM_SLICE_MS = 2_000
/** Failures in a row that pause a pane's timer. */
const MAX_EVERY_FAILURES = 3

/** Why a run failed, from its result: the script error line, else the text's start. */
function failureOf(text: string): string {
  return (/^Script error: (.*)$/m.exec(text)?.[1] ?? text).replace(/^Error: /, '').slice(0, 2000)
}

/**
 * Runs pane handlers and timers as scripts on session.start's `$`, as follows run, so they outlive the
 * script that set them; a reload makes it again and starts each open pane's timer anew.
 */
let programs:
  | {
      /** Starts, restarts or stops the pane's timer to match its record. */
      sync: (id: string, pane: CodemodePane | null) => void
      /** Runs one of the pane's handlers on `arg`; a run of the same one in flight skips it. */
      run: (id: string, name: string, source: string, arg: { [key: string]: CodemodeJson }) => void
    }
  | undefined

function programsOn($: EngineInterface): NonNullable<typeof programs> {
  const writer = recordWriter($)
  const timers = new Map<string, { ms: number; source: string; stop: AbortController }>()
  const running = new Set<string>()
  const failures = new Map<string, number>()
  const calls = new Map<string, number[]>()

  /** A script host whose tool calls count against the pane's minute, and whose every await starts a new slice. */
  const hostFor = (id: string, resumed: () => void): Host => {
    const host = scriptHost($)
    const after = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => (...args: A) => fn(...args).finally(resumed)
    const panes = Object.fromEntries(
      Object.entries(host.panes!).map(([name, fn]) => [name, name === 'renderError' ? fn : after(fn as (...args: unknown[]) => Promise<unknown>)]),
    ) as unknown as PaneHost
    return {
      ...host,
      callTool: after(async input => {
        const now = Date.now()
        const recent = (calls.get(id) ?? []).filter(at => at > now - 60_000)
        if (recent.length >= MAX_PROGRAM_CALLS_PER_MINUTE) {
          throw new Error(`The pane "${id}" made ${MAX_PROGRAM_CALLS_PER_MINUTE} tool calls in the last minute, its limit; slow its every.ms.`)
        }
        calls.set(id, [...recent, now])
        return host.callTool(input)
      }),
      sleep: after(host.sleep),
      complete: after(host.complete),
      classify: after(host.classify),
      panes,
    }
  }

  const runOnce = async (id: string, name: string, source: string, arg: { [key: string]: CodemodeJson }): Promise<void> => {
    const key = `${id}\n${name}`
    if (running.has(key)) return
    running.add(key)
    try {
      let sliceStart = performance.now()
      const ctx: RunContext = {
        signal: new AbortController().signal,
        budget: {
          get remainingMs() {
            return PROGRAM_SLICE_MS + 1_500 - (performance.now() - sliceStart)
          },
        },
        toolUseId: `pane-${id}-${name}`,
        globals: { __codemode_arg: arg },
      }
      const run = await runScript(
        hostFor(id, () => (sliceStart = performance.now())),
        { script: `return await (${source}\n)(__codemode_arg)`, timeout_ms: PROGRAM_TIMEOUT_MS },
        ctx,
      )
      const failed = run.text.startsWith('Script failed')
      const inRow = failed ? (failures.get(key) ?? 0) + 1 : 0
      failures.set(key, inRow)
      await writer.change(id, pane => {
        if (pane === null) return null
        if (!failed) {
          if (pane.error?.in !== name) return pane
          const { error: _error, ...rest } = pane
          return rest
        }
        const error = { in: name, message: failureOf(run.text), at: Date.now() }
        const every = pane.program?.every
        const pause = name === 'every' && every !== undefined && inRow >= MAX_EVERY_FAILURES
        return {
          ...pane,
          error: pause ? { ...error, message: `${error.message} (paused after ${inRow} failures in a row; set every again to restart it)` } : error,
          ...(pause ? { program: { ...pane.program, every: { ...every, paused: true as const } } } : {}),
        }
      })
    } catch (thrown) {
      // The run could not start, or its result could not be written: say so, if the record is still there.
      const message = thrown instanceof Error ? thrown.message : String(thrown)
      await writer.change(id, pane => (pane === null ? null : { ...pane, error: { in: name, message, at: Date.now() } })).catch(() => {})
    } finally {
      running.delete(key)
    }
  }

  const tick = async (id: string) => {
    const pane = await read($, memberOf(paneById, { requestId: id })).catch(() => null)
    const every = pane?.program?.every
    if (pane === null || every === undefined || !pane.isOpen) return
    await runOnce(id, 'every', every.run, { id, values: pane.values, data: pane.data })
  }

  return {
    sync: (id, pane) => {
      const every = pane?.isOpen ? pane.program?.every : undefined
      const wanted = every === undefined || every.paused ? undefined : every
      const current = timers.get(id)
      if (current !== undefined && wanted !== undefined && current.ms === wanted.ms && current.source === wanted.run) return
      current?.stop.abort()
      timers.delete(id)
      if (wanted === undefined) return
      failures.delete(`${id}\nevery`)
      // Waits in sleep processes, as follows do: a $.clock wait counts against session.start's budget, long spent.
      const stop = new AbortController()
      timers.set(id, { ms: wanted.ms, source: wanted.run, stop })
      void (async () => {
        while (!stop.signal.aborted) {
          await idle($, wanted.ms, stop.signal)
          if (!stop.signal.aborted) await tick(id)
        }
      })().catch(() => {})
    },
    run: (id, name, source, arg) => void runOnce(id, name, source, arg),
  }
}

/** Why each pane's render failed the last time it drew, for ui.get. */
const renderErrors = new Map<string, string>()

/**
 * Learns whether the terminal shows pixels, once a session: a blit of a drawn Image's own source is
 * taken where pixels show, and denied naming the alt where they don't. Made on session.start's `$`, as
 * the blit runs after the drawing that holds the Image.
 */
let pixelCheck: ((id: string, image: DrawnImage) => void) | undefined

function pixelCheckOn($: EngineInterface): NonNullable<typeof pixelCheck> {
  let isChecking = false
  return (id, image) => {
    if (isChecking) return
    isChecking = true
    void (async () => {
      if ((await read($, pixels)) !== null) return
      await $.process.run(['sleep', '0.2'], { timeoutMs: 2000 })
      const blitted = await $.ui.blit({ requestId: id, key: image.key, source: image.source })
      if (blitted.deny === undefined) await update($, pixels, () => true)
      else if (/\balt\b/i.test(blitted.deny)) await update($, pixels, () => false)
    })()
      .catch(() => {})
      .finally(() => (isChecking = false))
  }
}

/**
 * The follows' engine side, made in session.start: a follow outlives the script that started it, and
 * runs on that hook's `$` so that interrupting the script's call doesn't end it. A reload makes it again.
 */
let follows:
  | {
      run: (id: string, follow: CodemodeFollow) => void
      stop: (follower: Follower, state: 'ended' | 'stopped', ended?: string) => Promise<void>
      /** A task ended: its file's running follows read the rest, and every record following it says how it ended. */
      end: (file: string, ended: string) => Promise<void>
    }
  | undefined

function followsOn($: EngineInterface): NonNullable<typeof follows> {
  const writer = recordWriter($)
  return {
    run: (id, follow) => runFollow($, writer, id, follow),
    stop: (follower, state, ended) => stopFollow($, writer, follower, state, ended),
    end: async (file, ended) => {
      const running = [...followers.values()].filter(follower => follower.file === file)
      await Promise.all(running.map(follower => stopFollow($, writer, follower, 'ended', ended)))
      // A follow whose tail had already gone (the file removed, a reload that couldn't start it).
      for (const pane of await allPanes($)) {
        for (const follow of pane.follows ?? []) {
          if (follow.file === file && follow.state === 'following') {
            await writer.change(pane.id, stored => (stored === null ? null : endFollow(stored, follow.to, 'ended', ended))).catch(() => {})
          }
        }
      }
    },
  }
}

/** A running follow: a `tail -f` of the task's output file, its lines appended to the pane. */
type Follower = { id: string; to: string; file: string; stop: () => void; done: Promise<void> }
/** The running follows, by pane id and `to` path. */
const followers = new Map<string, Follower>()
/** Output files whose task has ended, and how, from the tasks' notifications. */
const endedTasks = new Map<string, string>()
/** How long an ended task's follow reads on, so `tail` delivers the last of the output. */
const FOLLOW_SETTLE_MS = 500

/** Starts a follow from its record's offset; one already running at the same `to` stops. */
function runFollow($: EngineInterface, writer: ReturnType<typeof recordWriter>, id: string, follow: CodemodeFollow): void {
  const key = `${id}\n${follow.to}`
  followers.get(key)?.stop()
  const stream = $.process.spawn({ argv: ['tail', '-c', `+${follow.offset + 1}`, '-f', follow.file] })
  let isStopped = false
  let finish = () => {}
  const follower: Follower = {
    id,
    to: follow.to,
    file: follow.file,
    stop: () => {
      if (isStopped) return
      isStopped = true
      void stream.return(undefined as never).catch(() => {})
    },
    done: new Promise<void>(resolve => (finish = resolve)),
  }
  followers.set(key, follower)
  // Appends while this follow is the pane's own; stops once the pane or its follow is gone.
  const append = (lines: string[], offset: number) =>
    writer
      .change(id, pane => {
        if (followers.get(key) !== follower) return pane
        if (pane === null || pane.follows?.find(one => one.to === follow.to)?.state !== 'following') {
          follower.stop()
          return pane
        }
        return addFollowed(pane, follow.to, lines, offset)
      })
      .catch(() => {})
  void (async () => {
    let partial = ''
    let offset = follow.offset
    try {
      for await (const chunk of stream) {
        if (chunk.stream !== 'stdout') continue
        offset += utf8Bytes(chunk.text)
        const split = splitOutput(partial, chunk.text)
        partial = split.partial
        if (split.lines.length > 0) void append(split.lines, offset - utf8Bytes(partial))
      }
    } catch {
      // The file went, or the stream closed; the follow ends with what it had.
    }
    // A last line the task wrote without a newline.
    if (partial !== '') await append([outputLine(partial)], offset)
    await writer.flush()
    if (followers.get(key) === follower) followers.delete(key)
    finish()
  })()
}

/** Ends or stops a running follow once its last lines are in, writing its state. */
async function stopFollow($: EngineInterface, writer: ReturnType<typeof recordWriter>, follower: Follower, state: 'ended' | 'stopped', ended?: string): Promise<void> {
  if (state === 'ended') await idle($, FOLLOW_SETTLE_MS, new AbortController().signal)
  follower.stop()
  await follower.done
  await writer.change(follower.id, pane => (pane === null ? null : endFollow(pane, follower.to, state, ended))).catch(() => {})
}

/** A task ended: the follows of its output file read the rest and say how it ended. */
function taskEnded(file: string, ended: string): void {
  endedTasks.set(file, ended)
  void follows?.end(file, ended).catch(() => {})
}

/** The tasks a notification prompt reports ended: each one's output file and how it ended. */
function endedTasksOf(text: string): { file: string; ended: string }[] {
  return [...text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)].flatMap(match => {
    const body = match[1]!
    const file = /<output-file>([^<]+)<\/output-file>/.exec(body)?.[1]?.trim()
    if (file === undefined) return []
    const status = /<status>([^<]+)<\/status>/.exec(body)?.[1]?.trim() ?? 'ended'
    const exit = /exit code (-?\d+)/.exec(body)?.[1]
    return [{ file, ended: exit === undefined ? status : `${status} (exit code ${exit})` }]
  })
}

/**
 * A background Bash command's output file that this session started, as the command's result named it:
 * a follow reads nothing else, so a script can't use it to read files its tools would ask about. The
 * list, not the path's folders, decides: the folder is named for the session the process began as,
 * which /clear changes.
 */
async function checkTaskFile($: EngineInterface, file: string): Promise<void> {
  if (!(await read($, taskFiles)).includes(file)) {
    throw new Error(
      `ui.follow() reads the output file of a background Bash command this session started, the path its run_in_background result names; ${JSON.stringify(file)} is not one. Use the path from that result as it is.`,
    )
  }
  const stat = await $.fs.stat(file).catch(() => undefined)
  if (stat === undefined || stat.kind !== 'file' || stat.isLink) throw new Error(`No task output file ${file}.`)
}

/** The engine side of a script's `ui`, through this hook's `$`. */
function paneHost($: EngineInterface): PaneHost {
  const writer = recordWriter($)
  return {
    change: writer.change,
    get: id => read($, memberOf(paneById, { requestId: id })),
    ids: () => read($, paneIds),
    show: async (id, title, focus) => {
      const opened = await $.ui.open({ id, title, ...(focus ? { focus: true as const } : {}) })
      return opened.isPlaced ? { isPlaced: true } : { isPlaced: false, reason: String(opened.reason) }
    },
    hide: id => $.ui.close({ id }),
    placed: async () => new Map((await $.ui.panes()).map(pane => [pane.id, pane.isPlaced])),
    drawing: async () => {
      // Advisory: a session that can't say draws as asked.
      const [surfaces, shows] = await Promise.all([$.session.surfaces().catch(() => [] as const), read($, pixels).catch(() => null)])
      return { surfaces: [...surfaces], ...(shows === null ? {} : { pixels: shows }) }
    },
    renderError: id => renderErrors.get(id),
    nextEvent: async (id, signal) => {
      let isWoken = false
      const wake = () => {
        isWoken = true
      }
      const set = waiters.get(id) ?? new Set()
      set.add(wake)
      waiters.set(id, set)
      try {
        await idle($, Infinity, signal, () => isWoken)
      } finally {
        waiters.get(id)?.delete(wake)
      }
    },
    flush: writer.flush,
    follow: async (id, spec: FollowSpec) => {
      // ui.stream's file came from the Bash result it asked for; the Bash hook's note of it may not be readable yet.
      if (spec.task !== undefined) await update($, taskFiles, list => (list.includes(spec.file) ? list : [...list, spec.file].slice(-MAX_TASK_FILES)))
      await checkTaskFile($, spec.file)
      // session.start makes it; a host that never ran that hook gets this call's.
      const engine = (follows ??= followsOn($))
      const isRunning = followers.has(`${id}\n${spec.to}`)
      if (!isRunning && followers.size >= MAX_FOLLOWS) throw new RangeError(`At most ${MAX_FOLLOWS} follows run at once; ui.unfollow(id) one first.`)
      const offset = spec.fromEnd ? (await $.fs.stat(spec.file)).size : 0
      const follow: CodemodeFollow = {
        file: spec.file,
        to: spec.to,
        max: spec.max,
        ...(spec.status !== undefined ? { status: spec.status } : {}),
        offset,
        state: 'following',
        ...(spec.task !== undefined ? { task: spec.task } : {}),
      }
      await writer.change(id, pane => {
        if (pane === null) throw new Error(`No pane "${id}".`)
        // From the start, the list holds this file's output alone.
        let next: CodemodePane = { ...pane, follows: [...(pane.follows ?? []).filter(one => one.to !== spec.to), follow], updatedAt: Date.now() }
        if (!spec.fromEnd) next = setAt(next, spec.to, [])
        if (spec.status !== undefined) next = setAt(next, spec.status, 'following')
        return checkSize(next)
      })
      await writer.flush()
      engine.run(id, follow)
      const ended = endedTasks.get(spec.file)
      const follower = followers.get(`${id}\n${spec.to}`)
      if (ended !== undefined && follower !== undefined) void engine.stop(follower, 'ended', ended)
      return ended === undefined ? { following: true } : { following: true, ended }
    },
    stopTask: async taskId => {
      await $.tool.call({ tool: 'TaskStop', task_id: taskId } as unknown as ToolCallArgs).catch(() => {})
    },
    unfollow: async (id, to) => {
      const stopping = [...followers.values()].filter(follower => follower.id === id && (to === undefined || follower.to === to))
      await Promise.all(stopping.map(follower => follows?.stop(follower, 'stopped')))
      // A follow recorded as running with nothing running it (a reload that couldn't start it) stops too.
      await writer.change(id, pane => {
        if (pane === null) return null
        let next = pane
        for (const follow of pane.follows ?? []) if (to === undefined || follow.to === to) next = endFollow(next, follow.to, 'stopped')
        return next
      })
      return stopping.length
    },
  }
}

/** Every pane record the session holds. */
async function allPanes($: EngineInterface): Promise<CodemodePane[]> {
  const panes = await Promise.all((await read($, paneIds)).map(id => read($, memberOf(paneById, { requestId: id }))))
  return panes.filter((pane): pane is CodemodePane => pane !== null)
}

/**
 * Panes whose answer is queued as a prompt whose turn has not started: further wake presses stay in the
 * inbox, so a burst of presses is one turn, and the next prompt's note names what they added.
 */
const pendingWakes = new Set<string>()

/**
 * What a press, an Enter or a pick does: writes the person's values, adds an event when the element emits
 * one or pushes, closes, then pushes: `wake` queues a turn carrying the answer, `draft` fills the prompt box.
 */
async function act($: EngineInterface, id: string, node: CodemodeNode, event?: Omit<CodemodePaneEvent, 'at' | 'element' | 'emit' | 'data'>, value?: string) {
  const props = node.props
  const key = String(props.key)
  const push = event === undefined ? 'queue' : props.push
  const emit = typeof props.emit === 'string' ? props.emit : push === 'wake' || push === 'draft' ? key : undefined
  const bind = typeof props.bind === 'string' ? props.bind : `values.${key}`
  // A handler of the pane's named by the emit (or the key) takes the event in place of the inbox.
  const name = typeof props.emit === 'string' ? props.emit : key
  let handler: string | undefined
  let latest: CodemodePane | null = null
  await update($, memberOf(paneById, { requestId: id }), pane => {
    if (pane === null) return null
    handler = event === undefined ? undefined : pane.program?.on?.[name]
    let next = pane
    if (value !== undefined && node.type !== 'Button') next = setAt(next, bind, value)
    if (typeof props.set === 'object' && props.set !== null && !Array.isArray(props.set)) {
      for (const [path, setTo] of Object.entries(props.set)) next = setAt(next, path, setTo)
    }
    if (emit !== undefined && event !== undefined && (handler === undefined || push === 'wake' || push === 'draft')) {
      next = pushEvent(next, { ...event, element: key, emit, ...(props.data !== undefined ? { data: props.data } : {}), at: Date.now() })
    }
    if (props.close === true) next = { ...next, isOpen: false }
    latest = next === pane ? pane : { ...next, updatedAt: Date.now() }
    return latest
  })
  if (emit !== undefined && event !== undefined) notify(id)
  if (handler !== undefined && event !== undefined && latest !== null) {
    const pane: CodemodePane = latest
    const happened = { ...event, element: key, ...(typeof props.emit === 'string' ? { emit: props.emit } : {}), ...(props.data !== undefined ? { data: props.data } : {}) }
    ;(programs ??= programsOn($)).run(id, `on.${name}`, handler, { id, event: happened, values: pane.values, data: pane.data })
  }
  if (props.close === true) await $.ui.close({ id })
  if (push === 'wake' && !pendingWakes.has(id)) {
    // The answer is written now, its events marked read: a plugin's own prompt.submit hooks never see
    // the prompts it submits, so none could write it as the prompt enters.
    pendingWakes.add(id)
    try {
      let answer: string | undefined
      await update($, memberOf(paneById, { requestId: id }), pane => {
        if (pane === null) return null
        answer = answerText(pane, pane.inbox)
        return { ...pane, inbox: [] }
      })
      if (answer === undefined) pendingWakes.delete(id)
      else await $.prompt.submit({ text: answer })
    } catch {
      pendingWakes.delete(id)
    }
  }
  if (push === 'draft' && latest !== null) {
    const pane: CodemodePane = latest
    const text =
      typeof props.prompt === 'string'
        ? fillPrompt(props.prompt, pane)
        : `About the codemode pane "${pane.id}" (${pane.title}): ${JSON.stringify(pane.values)}`
    await $.prompt.fill({ text, mode: 'append' })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    follows = followsOn($)
    programs = programsOn($)
    pixelCheck = pixelCheckOn($)
    // A reload keeps the records; open again the panes that were open, in case the engine dropped them,
    // and follow on from where each follow had read to.
    try {
      const shown = new Set((await $.ui.panes()).map(pane => pane.id))
      for (const pane of await allPanes($)) {
        if (pane.isOpen && !shown.has(pane.id)) void $.ui.open({ id: pane.id, title: pane.title })
        for (const follow of pane.follows ?? []) if (follow.state === 'following') follows.run(pane.id, follow)
        programs.sync(pane.id, pane)
      }
    } catch {
      // No panes to bring back.
    }
    declarations = loadDeclarations($.plugin.root, async path => String(await $.fs.read(path)))
    let available: Set<string> | undefined
    try {
      available = new Set((await $.tool.list()).map(tool => tool.name))
    } catch {
      // List every declared one.
    }
    reference = inlineDeclarations(await declarations, available)
    savedStamp = undefined
    await registerTool($)
    await $.command.register({
      name: 'codemode-pane',
      description: 'Open a pane a codemode script made (the latest, or one by id)',
      argumentHint: '[id]',
    })

    return next(e)
  })

  // Keep the tool in the prompt's list: behind ToolSearch, as MCP tools are by default, the model seldom reaches for it.
  // The row shows the script and the calls it makes, not the tool's name and raw input.
  on('ui.render', { component: 'ToolUse', props: { tool: 'mcp__codemode__run' } }, async ($, e, next) => {
    if (e.component !== 'ToolUse') return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const isExpanded = memberOf(isExpandedByRun, e)
    return drawToolUse({ Box, Text, Button }, e.props, await read($, memberOf(callsByRun, e)), {
      isExpanded: await read($, isExpanded),
      onToggle: () => update($, isExpanded, value => !value),
    })
  })

  // The result under the row: the output without its header, folded when long. Claude Code's own block
  // draws an errored call (a refusal, an interrupt) and a result with images.
  on('ui.render', { component: 'ToolResult', props: { tool: 'mcp__codemode__run' } }, async ($, e, next) => {
    if (e.component !== 'ToolResult' || e.props.isErrored || hasImages(e.props.output)) return next(e)
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const isExpanded = memberOf(isResultExpandedByRun, e)
    const diffs = await read($, memberOf(diffsByRun, e))
    return drawToolResult(
      { Box, Text, Button, Code },
      e.props,
      { isExpanded: await read($, isExpanded), onToggle: () => update($, isExpanded, value => !value) },
      diffs,
    )
  })

  // A pane the model opens is unasked, so a narrow terminal holds it back; the person's command opens it at any width.
  on('command.run', { command: 'codemode-pane' }, async ($, e) => {
    const panes = await allPanes($)
    const wanted = e.args.trim()
    const pane = wanted === '' ? panes.findLast(one => one.isOpen) ?? panes.at(-1) : panes.find(one => one.id === wanted)
    if (pane === undefined) {
      const list = panes.map(one => one.id).join(', ')
      return { text: panes.length === 0 ? 'No codemode panes in this session.' : `No codemode pane "${wanted}". Panes: ${list}.` }
    }
    if (!pane.isOpen) await update($, memberOf(paneById, { requestId: pane.id }), stored => (stored === null ? null : { ...stored, isOpen: true }))
    const opened = await $.ui.open({ id: pane.id, title: pane.title, focus: true })
    return { text: opened.isPlaced ? `Opened the codemode pane "${pane.id}".` : `The codemode pane "${pane.id}" could not open: ${String(opened.reason)}` }
  })

  // The person runs a saved script: no model turn, and a pane it opens seats at any width, as the person asked.
  // With no name, the saved scripts and those that don't load.
  on('command.run', { command: 'codemode' }, async ($, e, next) => {
    const [, name = '', rest = ''] = /^\s*(\S*)\s*([\s\S]*)$/.exec(e.args) ?? []
    if (name === '') {
      const places = await savedPlacesOf($)
      return { text: savedReport(await listSaved(savedFsOf($), places), places) }
    }
    const saved = await savedScript($, name, found => argsOf(found.meta, commandArgs(found.meta, rest, found.name), found.name))
    if ('error' in saved) return { text: `codemode: ${saved.error}` }
    const run = await runScript(
      scriptHost($),
      { script: saved.script },
      { signal: next.signal, budget: next.budget, toolUseId: `command-${name}-${Date.now()}`, globals: { args: saved.args } },
    )
    return { text: run.images.length === 0 ? run.text : `${run.text}\n(${run.images.length} image${run.images.length === 1 ? '' : 's'} not shown: a command's output is text.)` }
  })

  // A pane a script opened: its record's view, drawn with its values and data.
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.component !== 'Pane') return next(e)
    const pane = await read($, memberOf(paneById, { requestId: e.requestId }))
    if (pane === null) return next(e)
    const id = e.requestId
    const { view, renderError } = viewOf(pane, { surface: e.surface, columns: e.props.bodyColumns })
    if (renderError === undefined) renderErrors.delete(id)
    else renderErrors.set(id, renderError)
    const drawn = drawPane(
      $.ui.resolve(e) as unknown as PaneElements,
      { ...pane, view },
      {
        press: node => act($, id, node, { type: 'press' }),
        input: (node, value) => act($, id, node, undefined, value),
        submit: (node, value) => act($, id, node, { type: 'submit', value }, value),
        select: (node, value) => act($, id, node, { type: 'select', value }, value),
      },
      { surface: e.surface, bodyColumns: e.props.bodyColumns },
    )
    const image = drawn.images[0]
    if (image !== undefined && (await read($, pixels)) === null) (pixelCheck ??= pixelCheckOn($))(id, image)
    return drawn.tree
  })

  // The person closing a pane is an event of its own; the record stays for a later script.
  on('ui.close', async ($, e, next) => {
    if (e.origin.kind === 'person') {
      try {
        const member = memberOf(paneById, { requestId: e.id })
        if ((await read($, member)) !== null) {
          await update($, member, pane => (pane === null ? null : pushEvent({ ...pane, isOpen: false }, { type: 'closed', at: Date.now() })))
          notify(e.id)
        }
      } catch {
        // The pane closes all the same.
      }
    }
    return next(e)
  })

  // Each prompt carries a note naming the panes with events no script has read. A task's notification
  // ends the follows of its output file.
  on('prompt.submit', async ($, e, next) => {
    if ((e.origin as { kind: string }).kind === 'task-notification') {
      for (const { file, ended } of endedTasksOf(e.text)) taskEnded(file, ended)
    }
    // A script saved, changed or removed since: the tool's listing and the command's hint follow.
    await registerTool($).catch(() => {})
    let note: string | undefined
    try {
      note = inboxNote(await allPanes($))
    } catch {
      note = undefined
    }
    return next(note === undefined ? e : { ...e, context: [...(e.context ?? []), note] })
  })

  // A wake's turn has started: the pane's next wake press queues a turn of its own.
  on('turn.start', ($, e, next) => {
    pendingWakes.clear()
    return next(e)
  })

  // A background command's output file, kept so ui.follow can read it: the model's own Bash calls and a
  // script's alike come through here.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const done = await next(e)
    const taskId = (done.result as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId
    const file = typeof taskId === 'string' && typeof done.text === 'string' ? taskFileOf(done.text, taskId) : undefined
    if (file !== undefined) {
      await update($, taskFiles, list => [...list.filter(one => one !== file), file].slice(-MAX_TASK_FILES)).catch(() => {})
    }
    return done
  })

  on('tool.describe', { tool: 'mcp__codemode__run' }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false }))

  on('tool.call', { tool: 'mcp__codemode__run' }, async ($, e, next) => {
    // Writes the latest calls to the row's state, one write at a time, so a burst of calls is one redraw.
    const shown = memberOf(callsByRun, { requestId: e.tool_use_id ?? 'run' })
    let latest: CodemodeCalls | undefined
    let writing: Promise<void> | undefined
    const showCalls = (calls: CodemodeCalls) => {
      latest = calls
      writing ??= (async () => {
        try {
          while (latest !== undefined) {
            const calls = latest
            latest = undefined
            await update($, shown, () => calls)
          }
        } catch {
          // The row draws without its calls.
        } finally {
          writing = undefined
        }
      })()
    }
    const host = scriptHost($, {
      showCalls,
      showDiffs: async diffs => {
        await update($, memberOf(diffsByRun, { requestId: e.tool_use_id ?? 'run' }), () => diffs)
      },
    })
    const args = e as { script?: unknown; name?: unknown; args?: unknown; max_output_tokens?: unknown; timeout_ms?: unknown }
    let script = typeof args.script === 'string' ? args.script : ''
    let globals: Record<string, unknown> | undefined
    if (args.name !== undefined) {
      if (typeof args.name !== 'string' || args.script !== undefined) return { result: 'Script failed: give script, or the name of a saved script, not both.' }
      const saved = await savedScript($, args.name, found => argsOf(found.meta, args.args, found.name))
      if ('error' in saved) return { result: `Script failed: ${saved.error}` }
      script = saved.script
      globals = { args: saved.args }
    } else if (args.args !== undefined) {
      return { result: 'Script failed: args are for a saved script, run by name.' }
    }
    const run = await runScript(
      host,
      {
        script,
        max_output_tokens: typeof args.max_output_tokens === 'number' ? args.max_output_tokens : undefined,
        timeout_ms: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
      },
      { signal: next.signal, budget: next.budget, toolUseId: e.tool_use_id ?? 'run', globals },
    )

    await writing
    return { result: toolResult(run) }
  }).catch(($, e, next) => ({
    result:
      next.error.kind === 'timeout'
        ? 'Script failed: it ran out of time. It computed too long between tool calls (CPU-heavy work belongs in a Bash command).'
        : `Script failed: ${next.error.message ?? 'the codemode hook threw.'}`,
  }))
}