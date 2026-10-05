// Runs one codemode script: parses it, guards its loops and functions, runs it in
// the sval interpreter with the script globals, and formats what it output.

import type { ModelCompleteRequest, ModelCompleteResult, ModelEffort, ToolCallResult, ToolInfo } from 'claude-code'

import type { CodemodeCall, CodemodeCalls, CodemodeDiffs, CodemodeJson } from '../types'
import { addDiffs, fileDiffsOf } from './diffs'
import { helpText, type HelpLimits } from './help'
import { h, paneGlobals, taskFileOf, type PaneHost } from './panes'
import { namespaceOf, normalizeNamespace, rankTools, type ToolEntry } from './search'
import { table } from './table'
import { plainText } from './text'
import { AT, TICK, guard, keepSources } from './guard'
import Sval from './vendor/sval.js'

export const TOOL_NAME = 'run'
export const TOOL_ID = 'mcp__codemode__run'

const DEFAULT_MAX_OUTPUT_TOKENS = 10_000
const CHARS_PER_TOKEN = 4
const MAX_STORED_VALUE_CHARS = 262_144
const MAX_STORED_TOTAL_CHARS = 1_048_576
const MAX_IMAGES = 20
/** Model calls one script may have in flight (the rest queue), and in all. */
const MAX_CONCURRENT_MODEL_CALLS = 4
const MAX_MODEL_CALLS = 200
const DEFAULT_MODEL = 'haiku'
/** The limits help() quotes. */
const HELP_LIMITS: HelpLimits = {
  defaultModel: DEFAULT_MODEL,
  maxConcurrentModelCalls: MAX_CONCURRENT_MODEL_CALLS,
  maxModelCalls: MAX_MODEL_CALLS,
  maxImages: MAX_IMAGES,
  defaultMaxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
}
const EFFORTS: readonly ModelEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
/** How many of a script's latest calls its row shows, and how much of each one's arguments. */
const RECENT_CALLS = 8
const CALL_ARGS_CHARS = 120
/** How many of a failed script's calls its result lists, the latest first kept. */
const FAILURE_CALLS = 20
/** The API's limit for one image, as base64. */
const MAX_IMAGE_CHARS = 5 * 1024 * 1024
/** Of the hook's 10 s of its own time, what a script may not eat into, so the result still gets written. */
const CPU_RESERVE_MS = 1_500
const MAIN = '__codemode_main'

/** The tool description: Claude Code cuts an MCP tool's description at 2048 characters, so the reference is in SCRIPT_HELP. */
export const DESCRIPTION = `Run a JavaScript script that calls Claude Code's tools, MCP tools included, and get back only what the script outputs. Use it to run tool calls in parallel, chain them, and filter or aggregate large results before you read them, so they never fill your context.

The script is the body of an async function in a sandboxed interpreter: top-level await and return work, and there are no Node APIs, file system, network or timers. It reaches everything through tools: tools.Bash({ command }), tools.Read({ file_path }), tools.mcp__<server>__<tool>({ ... }).

Read the script parameter's description before your first script: it lists the globals, what tool calls resolve to, and the inputs of common built-in tools.

A script worth keeping can be saved and run again by name, with args: the name parameter lists the saved ones. Run one in place of writing it again.`

/** The reference a script is written against, in the `script` parameter's description. */
export const SCRIPT_HELP = `JavaScript source. A first line // @options: {"max_output_tokens": 2000, "timeout_ms": 60000} sets the options.

return help("panes") reads a topic's detail and examples; help() lists the topics. Read a topic before you first use what it covers.

Globals:
- tools.<name>(args): call a tool with one object of arguments (mcp__dev-radius__search is tools.mcp__dev_radius__search), through the same permission checks and hooks as your own calls. Built-in tools resolve to { text, result }: text is what you would read, result the tool's structured record (Bash: stdout, stderr; Read: result.file.content, the raw text). Bash rejects on a non-zero exit, the output in the error; end a command with "|| true" to read a failing one's output. MCP tools resolve to { content, structuredContent, text }. A failed or denied call rejects with the tool's error text; Promise.allSettled() keeps the calls that succeed. An output Claude Code would show you as a preview is whole in text, up to 4 MiB. help("tools")
- ALL_TOOLS, searchTools(query, { limit?, namespace? }), describeNamespace(server), describeTool(name): find tools and their arguments (describeTool's declaration is the input type as TypeScript). Most MCP tools are not in your own tool list.
- session: { id, cwd, projectDir, repo, turns (prompts sent) }. session.usage({ breakdown? }) resolves { startedAt, context, rateLimits, cost }; breakdown "full" sends a token-count request per tool, "summary" doesn't. session.messages({ agentId?, as?: "api" }) resolves the transcript as { role, text, toolUses, toolResults? } rows.
- text(value), console.log(...) and a top-level return make the output; image(value) adds an image; exit() ends the script successfully. help("output")
- sleep(ms).
- models.complete({ prompt, model?, system?, maxTokens?, effort? }) resolves { text, usage }; models.classify(text, labels) resolves one of labels or undefined. They cost tokens: use them over many items whose raw text would fill your context. help("models")
- table(text or lines): command output in columns (iostat, ps, df) as rows keyed by its header, numbers as numbers.
- args: a saved script's args (the name parameter); help("saved") says how to save a script.
- store(key, value) / load(key): small JSON values across scripts in this session, kept only when the script succeeds; store(key, undefined) deletes.
- ui and h(): panes beside the transcript that outlive the script; later scripts change them by id. ui.open({ id, title, ask?, view: h(...) }), ui.update, ui.set(id, "data.x", value), ui.append(id, "data.log", items), ui.follow(id, outputFile, { to, status }) (a background task's output, live after your turn ends), ui.take(id), ui.panes(), ui.close(id), ui.remove(id). To ask the person something, don't wait for them: open a pane with ask and a push: "wake" button, return, and end your turn. Elements: Box, Text, Button, Input, Select, Markdown, Code, Link, Image, Chart; any takes when: { "values.tab": "logs" }. A pane can carry code: render(state) draws it, on: { name: fn } runs on presses, every: { ms, run } polls slowly. Live data: ui.stream(id, command, { to }) runs a command and follows its output, not every. help("panes") has their props, binding, push routes, follows and layouts; read it before your first pane.

The result starts with "Script completed" or "Script failed", then the output; a failed script keeps its partial output and ends with "Script error:", the line that ran last, and the calls it made. Output past max_output_tokens (default ${DEFAULT_MAX_OUTPUT_TOKENS}) keeps its start and end, and the full text is saved to a file. Tool calls are real: calls made before a failure are not undone. Await every call you start. CPU-heavy work fails after about 8 seconds of interpreter time; time spent waiting on tools does not count.`

/**
 * The tool's input schema; `reference` is appended to the script parameter's description (the built-in
 * tools' inputs), and `saved` to the name parameter's (the saved scripts).
 */
export function inputSchema(reference = '', saved = '') {
  return {
    type: 'object',
    properties: {
      script: { type: 'string', description: SCRIPT_HELP + reference },
      name: {
        type: 'string',
        description: `A saved script to run in place of script, by its name. It reads args as the args global. help("saved") says how to save one.\n\n${saved}`,
      },
      args: { type: 'object', description: "The saved script's args, checked against those its meta declares." },
      max_output_tokens: {
        type: 'integer',
        minimum: 1,
        description: `Output limit (default ${DEFAULT_MAX_OUTPUT_TOKENS}). Longer output keeps its start and end, and the full text is saved to a file.`,
      },
      timeout_ms: { type: 'integer', minimum: 1, description: 'Wall-clock deadline for the whole script, tool calls included. Unset by default.' },
    },
    additionalProperties: false,
  }
}

export type ScriptInput = {
  script: string
  max_output_tokens?: number
  timeout_ms?: number
}

/** What the runner needs from the engine; register.ts makes every `$` call. */
export type Host = {
  listTools: () => Promise<ToolInfo[]>
  callTool: (input: { tool: string } & Record<string, unknown>) => Promise<ToolCallResult>
  loadStore: () => Promise<Record<string, CodemodeJson>>
  saveStore: (values: Record<string, CodemodeJson>) => Promise<void>
  /** Writes a long output in full and answers its path, or undefined when it could not. */
  saveOutput: (name: string, text: string) => Promise<string | undefined>
  /** Reads a file Claude Code saved a long tool output to; rejects past the read limit. */
  readFile: (path: string) => Promise<string>
  /** The tool's input type as TypeScript, when the engine's declarations have it. */
  declarationOf: (tool: ToolInfo) => Promise<string | undefined>
  /** Resolves after `ms`; rejects when `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  /** One completion; `signal` cuts it when the script ends. */
  complete: (request: ModelCompleteRequest, signal: AbortSignal) => Promise<ModelCompleteResult>
  /** One of `labels` for `text`, or undefined. */
  classify: (text: string, labels: string[], model: string | undefined) => Promise<string | undefined>
  /** The session facts a script reads as `session`, once per run. */
  sessionFacts: () => Promise<SessionFacts>
  /** `$.session.usage(args)`, as the engine answers it. */
  sessionUsage: (args: Record<string, unknown> | undefined) => Promise<unknown>
  /** `$.session.messages(args)`, as the engine answers it. */
  sessionMessages: (args: Record<string, unknown> | undefined) => Promise<unknown>
  /** Shows the script's tool calls so far in its row; fire and forget. */
  showCalls?: (calls: CodemodeCalls) => void
  /** Shows the file changes the script's tool calls made under its result, as Bash's row does; called once, at the end. */
  showDiffs?: (diffs: CodemodeDiffs) => Promise<void>
  /** Panes for the `ui` global; without it a script has no `ui`. */
  panes?: PaneHost
}

/** What a script reads as `session`. */
export type SessionFacts = { id: string; cwd: string; projectDir: string; repo: { root: string; remote: string | null } | null; turns: number }

export type RunContext = {
  signal: AbortSignal
  budget: { readonly remainingMs: number }
  toolUseId: string
  /** Globals beside the script's own, as a pane handler's argument. */
  globals?: Record<string, unknown>
}

/** An image a script added with image(), checked and typed by its signature. */
export type ScriptImage = { data: string; mediaType: string }

export type ScriptResult = { text: string; images: ScriptImage[] }

/** The tool's result: the text alone, or the text and the images as content blocks. */
export function toolResult(run: ScriptResult) {
  if (run.images.length === 0) return run.text
  return [
    { type: 'text', text: run.text },
    ...run.images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } })),
  ]
}

type ScriptOptions = { max_output_tokens?: number; timeout_ms?: number }

/** Thrown by `exit()`, caught as success. */
const EXIT: unique symbol = Symbol('codemode exit')

export function identifierOf(name: string): string {
  return name.replace(/[^A-Za-z0-9_$]/g, '_')
}

export async function runScript(host: Host, input: ScriptInput, ctx: RunContext): Promise<ScriptResult> {
  const started = performance.now()
  const parsed = parseOptions(input.script)
  if ('error' in parsed) return { text: await formatResult({ started, calls: 0, images: 0, output: [], error: parsed.error }), images: [] }

  const maxOutputTokens = input.max_output_tokens ?? parsed.options.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  const timeoutMs = input.timeout_ms ?? parsed.options.timeout_ms
  const deadline = timeoutMs === undefined ? Infinity : started + timeoutMs

  const output: string[] = []
  const images: ScriptImage[] = []
  let calls = 0
  let modelCalls = 0
  let modelTokens = 0
  let failedCalls = 0
  const made: CodemodeCall[] = []
  let diffs: CodemodeDiffs = { files: [], more: 0 }
  const showCalls = () =>
    host.showCalls?.({ total: calls, failed: failedCalls, recent: made.slice(-RECENT_CALLS).map(call => ({ ...call })) })
  let isFinished = false
  /** The script line that ran last; with several async calls in flight, it may be another call's. */
  let line = 0

  const listed = (await host.listTools()).filter(tool => tool.name !== TOOL_ID)
  const byName = new Map<string, ToolInfo>()
  for (const tool of listed) {
    byName.set(tool.name, tool)
    byName.set(identifierOf(tool.name), tool)
  }
  const entries: ToolEntry[] = listed.map(tool => ({ name: tool.name, description: tool.description }))

  const [loaded, facts] = await Promise.all([host.loadStore(), host.sessionFacts()])
  const stored: Record<string, CodemodeJson> = { ...loaded }
  let hasStored = false

  // Ends the host waits (sleeps, the deadline) once the script is over.
  const stop = new AbortController()
  const onAbort = () => stop.abort()
  ctx.signal.addEventListener('abort', onAbort, { once: true })

  /** Rejects the run from outside the script: the deadline passed, or the script can never finish. */
  let fail: (error: Error) => void = () => {}
  const failed = new Promise<never>((_, reject) => {
    fail = reject
  })
  failed.catch(() => {})

  // Host work in flight (tool calls, sleeps). When none is, and the script is still awaiting once the
  // engine's next turn comes round (every microtask run by then), nothing is left that could resume it.
  let pending = 0
  let isSettled = false
  const watch = () => {
    if (pending > 0 || isSettled) return
    host.sleep(0, stop.signal).then(
      () => {
        if (!isSettled && pending === 0) {
          fail(new Error('The script awaits a promise that never settles: no tool call or sleep() is pending.'))
        }
      },
      () => {},
    )
  }
  const track = async <T>(work: () => Promise<T>): Promise<T> => {
    pending += 1
    try {
      return await work()
    } finally {
      pending -= 1
      watch()
    }
  }

  if (timeoutMs !== undefined) {
    host.sleep(timeoutMs, stop.signal).then(
      () => fail(new Error(`Timed out after ${timeoutMs} ms (timeout_ms).`)),
      () => {},
    )
  }

  const check = () => {
    if (isFinished) throw new Error('The script has ended.')
    if (ctx.signal.aborted) throw new Error('Interrupted.')
    if (performance.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms (timeout_ms).`)
    if (ctx.budget.remainingMs < CPU_RESERVE_MS) {
      throw new Error('Out of interpreter time: the script computed for too long between tool calls.')
    }
  }

  const callTool = async (tool: ToolInfo, args: unknown) => {
    check()
    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
      throw new TypeError(`tools.${identifierOf(tool.name)}() takes one object of arguments.`)
    }
    const plain = args === undefined ? {} : (JSON.parse(JSON.stringify(args)) as Record<string, unknown>)
    calls += 1
    return recorded(tool.name, argsPreview(plain), () => runCall(tool, plain), () => false)
  }

  /** Runs one nested call as a row of the script's: running, then ok or error, with its time. */
  const recorded = async <T>(name: string, args: string, work: () => Promise<T>, isError: (value: T) => boolean): Promise<T> => {
    const call: CodemodeCall = { tool: name, args, status: 'running' }
    made.push(call)
    showCalls()
    const callStarted = performance.now()
    const settle = (failed: boolean) => {
      if (call.status !== 'running') return
      call.status = failed ? 'error' : 'ok'
      call.ms = Math.round(performance.now() - callStarted)
      if (failed) failedCalls += 1
      showCalls()
    }
    try {
      const value = await work()
      settle(isError(value))
      return value
    } catch (thrown) {
      settle(true)
      throw thrown
    }
  }

  // Model calls past MAX_CONCURRENT_MODEL_CALLS wait here for a free slot.
  let modelsInFlight = 0
  const waitingForModel: (() => void)[] = []
  const inModelSlot = async <T>(work: () => Promise<T>): Promise<T> => {
    while (modelsInFlight >= MAX_CONCURRENT_MODEL_CALLS) await new Promise<void>(resolve => waitingForModel.push(resolve))
    modelsInFlight += 1
    try {
      return await work()
    } finally {
      modelsInFlight -= 1
      waitingForModel.shift()?.()
    }
  }
  const modelCall = <T>(kind: string, model: string, text: string, work: () => Promise<T>, isError: (value: T) => boolean) => {
    check()
    if (modelCalls >= MAX_MODEL_CALLS) throw new RangeError(`models: a script may make at most ${MAX_MODEL_CALLS} model calls.`)
    modelCalls += 1
    return recorded(`models.${kind}`, argsPreview({ prompt: `${model}: ${text}` }), () => track(() => inModelSlot(work)), isError)
  }
  const models = {
    complete: async (request: unknown) => {
      const checked = completeRequest(request)
      const result = await modelCall('complete', checked.model, checked.prompt, () => host.complete(checked, stop.signal), r => !r.isAnswered)
      modelTokens += result.usage.input_tokens + result.usage.output_tokens
      if (!result.isAnswered) throw new Error(`models.complete(): no reply (${noReplyReason(result)}).`)
      return { text: result.text, usage: { ...result.usage } }
    },
    classify: async (text: unknown, labels: unknown, options?: { model?: unknown }) => {
      if (typeof text !== 'string') throw new TypeError('models.classify() takes the text to classify as a string.')
      if (!Array.isArray(labels) || labels.length < 2 || !labels.every(label => typeof label === 'string')) {
        throw new TypeError('models.classify() takes two or more labels as strings.')
      }
      const model = options?.model === undefined ? undefined : String(options.model)
      return modelCall('classify', model ?? 'small model', text, () => host.classify(text, [...labels] as string[], model), () => false)
    },
  }

  const runCall = async (tool: ToolInfo, plain: Record<string, unknown>) => {
    const ran: ToolCallResult = await track(() => host.callTool({ ...plain, tool: tool.name }))
    if (ran.deny !== undefined) throw new Error(ran.deny)
    if (!ran.isError) diffs = addDiffs(diffs, fileDiffsOf(tool.name, ran.result))
    // Read answers a file the conversation already holds with a stub pointing at that earlier result,
    // which a script never saw; the call passed Read's checks, so read the file for it.
    const unchanged = tool.name === 'Read' ? unchangedPath(ran.result) : undefined
    if (unchanged !== undefined) return track(() => reread(host, unchanged, plain))
    const saved = await track(() => savedOutput(host, ran))
    if (tool.mcp) {
      const reply = mcpResult(ran, saved)
      if (ran.isError) throw Object.assign(new Error(reply.text || `${tool.name} failed.`), { result: reply })
      return reply
    }
    if (ran.isError) throw new Error(ran.text ?? String(ran.result ?? `${tool.name} failed.`))
    if (saved === undefined) return { text: ran.text ?? '', result: ran.result }
    const record = ran.result as Record<string, unknown> | undefined
    return {
      text: saved.text ?? ran.text ?? '',
      result: saved.text !== undefined && typeof record?.stdout === 'string' ? { ...record, stdout: saved.text } : ran.result,
      fullOutputPath: saved.path,
    }
  }

  const tools = new Proxy({} as Record<string, unknown>, {
    get(_, key) {
      if (typeof key !== 'string' || key === 'then' || key === 'toJSON') return undefined
      if (key === TOOL_ID || key === TOOL_NAME) throw new Error('A codemode script cannot start another codemode script.')
      const tool = byName.get(key)
      if (tool === undefined) {
        throw new ReferenceError(`No tool named ${key}. Find tools with searchTools(), describeNamespace() or ALL_TOOLS.`)
      }
      return (args?: unknown) => callTool(tool, args)
    },
    has: (_, key) => typeof key === 'string' && byName.has(key),
    ownKeys: () => listed.map(tool => identifierOf(tool.name)),
    getOwnPropertyDescriptor: (_, key) =>
      typeof key === 'string' && byName.has(key)
        ? { configurable: true, enumerable: true, value: (args?: unknown) => callTool(byName.get(key)!, args) }
        : undefined,
  })

  /** A `session` method: its one optional argument as plain JSON, the engine's answer as plain data, shown as a row. */
  const sessionCall = (name: string, call: (args: Record<string, unknown> | undefined) => Promise<unknown>) => async (args?: unknown) => {
    check()
    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
      throw new TypeError(`session.${name}() takes one object of arguments, or none.`)
    }
    const plain = args === undefined ? undefined : (JSON.parse(JSON.stringify(args)) as Record<string, unknown>)
    const value = await recorded(`session.${name}`, plain === undefined ? '' : argsPreview(plain), () => track(() => call(plain)), () => false)
    return structuredClone(value)
  }

  const print = (...values: unknown[]) => {
    output.push(values.map(formatValue).join(' '))
  }

  const globals: Record<string, unknown> = {
    [TICK]: check,
    [AT]: (at: number) => {
      line = at
    },
    tools,
    session: { ...structuredClone(facts), usage: sessionCall('usage', host.sessionUsage), messages: sessionCall('messages', host.sessionMessages) },
    models,
    ALL_TOOLS: entries.map(entry => ({ ...entry })),
    searchTools: async (query: unknown, options: { limit?: number; namespace?: string } = {}) =>
      rankTools(entries, String(query ?? ''), options).map(entry => ({ ...entry })),
    describeTool: async (name: unknown) => {
      const tool = byName.get(String(name))
      if (tool === undefined) return undefined
      const declaration = await track(() => host.declarationOf(tool))
      return { name: tool.name, description: tool.description, mcp: tool.mcp, ...(declaration ? { declaration } : {}) }
    },
    describeNamespace: async (name: unknown) => {
      const wanted = normalizeNamespace(String(name ?? ''))
      const members = entries.filter(entry => {
        const namespace = namespaceOf(entry.name)
        return namespace !== undefined && normalizeNamespace(namespace) === wanted
      })
      if (members.length === 0) return undefined
      return { name: namespaceOf(members[0]!.name), tools: members.map(entry => ({ ...entry })) }
    },
    text: (value: unknown) => print(value),
    console: { log: print, info: print, warn: print, error: print, debug: print },
    image: (value: unknown) => {
      check()
      if (images.length >= MAX_IMAGES) throw new RangeError(`image(): a script may add at most ${MAX_IMAGES} images.`)
      images.push(imageOf(value))
    },
    sleep: (ms: unknown) => {
      check()
      const wait = Number(ms)
      return track(() => host.sleep(Number.isFinite(wait) && wait > 0 ? wait : 0, stop.signal))
    },
    exit: () => {
      throw EXIT
    },
    store: (key: unknown, value: unknown) => {
      if (typeof key !== 'string') throw new TypeError('store() takes a string key.')
      if (value === undefined) {
        delete stored[key]
      } else {
        const json = JSON.stringify(value)
        if (json === undefined) throw new TypeError('store() takes a JSON value.')
        if (json.length > MAX_STORED_VALUE_CHARS) {
          throw new RangeError(`store(): a value may be at most ${MAX_STORED_VALUE_CHARS} characters of JSON.`)
        }
        stored[key] = JSON.parse(json) as CodemodeJson
        if (JSON.stringify(stored).length > MAX_STORED_TOTAL_CHARS) {
          delete stored[key]
          throw new RangeError(`store(): all values together may be at most ${MAX_STORED_TOTAL_CHARS} characters of JSON.`)
        }
      }
      hasStored = true
    },
    load: (key: unknown) => {
      const value = stored[String(key)]
      return value === undefined ? undefined : structuredClone(value)
    },
    ui:
      host.panes === undefined
        ? undefined
        : paneGlobals(host.panes, {
            check,
            track,
            recorded: (name, args, work) => recorded(name, args, work, () => false),
            sleep: ms => host.sleep(ms, stop.signal),
            signal: stop.signal,
            background: async (command, description, timeoutMs) => {
              const bash = byName.get('Bash')
              if (bash === undefined) throw new Error('ui.stream() runs its command through Bash, which this session does not have.')
              const ran = (await callTool(bash, { command, run_in_background: true, timeout: timeoutMs, ...(description !== undefined ? { description } : {}) })) as { text: string; result?: unknown }
              const taskId = (ran.result as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId
              const file = typeof taskId === 'string' ? taskFileOf(ran.text, taskId) : undefined
              if (typeof taskId !== 'string' || file === undefined) throw new Error(`ui.stream(): Bash started no background task: ${ran.text.slice(0, 300)}`)
              return { taskId, file }
            },
          }),
    h: host.panes === undefined ? undefined : h,
    table,
    help: (topic?: unknown) => helpText(topic, HELP_LIMITS),
    // Shadow what the host environment might have, so a script reaches the world only through tools.
    fetch: undefined,
    XMLHttpRequest: undefined,
    WebSocket: undefined,
    Fragment: undefined,
    ...ctx.globals,
  }

  let error: unknown
  try {
    const interpreter = new Sval({ ecmaVer: 'latest', sandBox: true })
    // Positions on every node, for the line markers guard() adds.
    interpreter.options.locations = true
    interpreter.importModule(globals)
    // The wrapper's opening sits on the script's first line, so line numbers match the script.
    const code = `exports.${MAIN} = async function () {${parsed.body}\n};`
    const ast = interpreter.parse(code)
    // A function passed to ui.open (a pane's render or handlers) is kept as its source.
    keepSources(ast, code)
    guard(ast)
    interpreter.run(ast)
    const main = interpreter.exports[MAIN] as () => Promise<unknown>
    const running = untilAborted(main(), ctx.signal)
    running.catch(() => {})
    watch()
    const value = await Promise.race([running, failed])
    if (value !== undefined) print(value)
  } catch (thrown) {
    if (thrown !== EXIT) error = thrown
  } finally {
    isFinished = true
    isSettled = true
    stop.abort()
    ctx.signal.removeEventListener('abort', onAbort)
  }
  if (made.some(call => call.status === 'running')) {
    for (const call of made) if (call.status === 'running') call.status = 'left'
    showCalls()
  }

  // Pane writes the script did not await land before its result does.
  await host.panes?.flush()
  if (diffs.files.length > 0) await host.showDiffs?.(diffs).catch(() => {})
  if (error === undefined && hasStored) await host.saveStore(stored)

  const text = await formatResult({
    started,
    calls,
    images: images.length,
    modelCalls,
    modelTokens,
    output,
    error,
    line,
    made,
    maxOutputTokens,
    save: text => host.saveOutput(identifierOf(ctx.toolUseId), text),
  })
  return { text, images }
}

function parseOptions(script: string): { options: ScriptOptions; body: string } | { error: Error } {
  const firstLine = script.split('\n', 1)[0] ?? ''
  const match = /^\s*\/\/\s*@options:\s*(.*)$/.exec(firstLine)
  if (match === null) return { options: {}, body: script }
  try {
    const options = JSON.parse(match[1]!) as ScriptOptions
    if (typeof options !== 'object' || options === null) throw new Error('not an object')
    // The options line stays in the body as a comment, so line numbers match the script.
    return { options, body: script }
  } catch (thrown) {
    return { error: new SyntaxError(`Invalid // @options: line (${errorText(thrown)}).`) }
  }
}

/** A call's arguments on one line: the one that says most for common tools, else JSON. */
function argsPreview(args: Record<string, unknown>): string {
  const main = ['command', 'file_path', 'pattern', 'query', 'url', 'prompt', 'title', 'name', 'id'].map(key => args[key]).find(value => typeof value === 'string')
  const text = typeof main === 'string' ? main : Object.keys(args).length === 0 ? '' : JSON.stringify(args)
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > CALL_ARGS_CHARS ? `${line.slice(0, CALL_ARGS_CHARS - 1)}…` : line
}

/** A models.complete() argument, checked and with its defaults. */
function completeRequest(request: unknown): ModelCompleteRequest {
  const given = (typeof request === 'object' && request !== null ? request : {}) as Record<string, unknown>
  if (typeof given.prompt !== 'string' || given.prompt === '') throw new TypeError('models.complete() takes { prompt } as a non-empty string.')
  const checked: ModelCompleteRequest = { model: typeof given.model === 'string' ? given.model : DEFAULT_MODEL, prompt: given.prompt }
  if (typeof given.system === 'string') checked.system = given.system
  if (given.maxTokens !== undefined) {
    if (!Number.isInteger(given.maxTokens) || (given.maxTokens as number) < 1) throw new TypeError('models.complete(): maxTokens is a positive integer.')
    checked.maxTokens = given.maxTokens as number
  }
  if (given.effort !== undefined) {
    if (!EFFORTS.includes(given.effort as ModelEffort)) throw new TypeError(`models.complete(): effort is one of ${EFFORTS.join(', ')}.`)
    checked.effort = given.effort as ModelEffort
  }
  return checked
}

function noReplyReason(result: ModelCompleteResult): string {
  if (result.isAnswered) return 'answered'
  const details = result as { reason: string; status?: number; error?: string }
  return [details.reason, details.status, details.error].filter(part => part !== undefined).join(' ')
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) reject(new Error('Interrupted.'))
    signal.addEventListener('abort', () => reject(new Error('Interrupted.')), { once: true })
    promise.then(resolve, reject)
  })
}

/** Read's default line count, as the tool has it. */
const READ_DEFAULT_LIMIT = 2000

/** The path of a Read result that says the file is unchanged since an earlier Read, else undefined. */
function unchangedPath(result: unknown): string | undefined {
  const record = result as { type?: unknown; file?: { filePath?: unknown } } | undefined
  return record?.type === 'file_unchanged' && typeof record.file?.filePath === 'string' ? record.file.filePath : undefined
}

/** A Read of `path` as the tool answers one: numbered lines from `offset`, at most `limit` of them. */
async function reread(host: Host, path: string, args: Record<string, unknown>) {
  const lines = (await host.readFile(path)).split('\n')
  const offset = Number.isInteger(args.offset) && (args.offset as number) > 0 ? (args.offset as number) : 1
  const limit = Number.isInteger(args.limit) && (args.limit as number) > 0 ? (args.limit as number) : READ_DEFAULT_LIMIT
  const shown = lines.slice(offset - 1, offset - 1 + limit)
  return {
    text: shown.map((line, i) => `${offset + i}\t${line}`).join('\n'),
    result: { type: 'text', file: { filePath: path, content: shown.join('\n'), numLines: shown.length, startLine: offset, totalLines: lines.length } },
  }
}

type SavedOutput = { path: string; text?: string }

/**
 * Where Claude Code saved a tool output too long to show the model (its `text` is then a preview), with
 * the saved text when it could be read, so a script filters the whole output rather than the preview.
 */
async function savedOutput(host: Host, ran: ToolCallResult): Promise<SavedOutput | undefined> {
  const record = ran.result as { persistedOutputPath?: unknown } | undefined
  const path =
    typeof record?.persistedOutputPath === 'string'
      ? record.persistedOutputPath
      : /^<persisted-output>\s*\n[^\n]*Full output saved to: (\S+)/.exec(ran.text ?? '')?.[1]
  if (path === undefined) return undefined
  try {
    return { path, text: await host.readFile(path) }
  } catch {
    return { path }
  }
}

function mcpResult(ran: ToolCallResult, saved: SavedOutput | undefined) {
  const result = (ran.result ?? {}) as { content?: unknown; structuredContent?: unknown }
  const text = saved?.text ?? ran.text ?? ''
  const content =
    Array.isArray(result.content) && saved?.text === undefined ? result.content : [{ type: 'text', text }]
  return {
    content,
    ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    text,
    ...(saved !== undefined ? { fullOutputPath: saved.path } : {}),
  }
}

const IMAGE_EXPECTS =
  'image() takes a base64 data: URL, an image block ({ type: "image", data, mimeType }), or what tools.Read resolves to for an image file.'

/** Base64 of the formats the API takes inline; the signatures start at byte 0, so their encodings are prefixes. */
const IMAGE_SIGNATURES: [string, RegExp][] = [
  ['image/png', /^iVBORw0KGg/],
  ['image/jpeg', /^\/9j\/(?!9)/],
  ['image/gif', /^R0lGOD[dl]h/],
  ['image/webp', /^UklG.{8}RUJQ/],
]

/**
 * Checks an image() argument and types it by its signature: the API rejects the whole request on a bad
 * image, and the block stays in the transcript, so a bad one would fail every later turn.
 */
export function imageOf(value: unknown): ScriptImage {
  const url = imageUrl(value)
  if (/^https?:/i.test(url)) {
    throw new TypeError('image(): remote URLs are not supported. Save the image to a file and pass what tools.Read resolves to.')
  }
  const comma = url.indexOf(',')
  const header = comma === -1 ? [] : url.slice(url.indexOf(':') + 1, comma).split(';')
  if (!/^data:/i.test(url) || comma === -1 || !header.slice(1).some(part => part.toLowerCase() === 'base64')) {
    throw new TypeError(IMAGE_EXPECTS)
  }
  // Line breaks from wrapped base64 are dropped; a declared type is ignored for the detected one.
  const data = url.slice(comma + 1).replace(/\s+/g, '')
  if (data.length > MAX_IMAGE_CHARS) throw new RangeError(`image(): an image may be at most ${MAX_IMAGE_CHARS} characters of base64.`)
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new TypeError('image(): the data is not valid base64 (truncated or corrupted?).')
  }
  const signature = IMAGE_SIGNATURES.find(([, pattern]) => pattern.test(data.slice(0, 16)))
  if (signature === undefined) throw new TypeError('image(): the data is not a PNG, JPEG, GIF or WebP image.')
  return { data, mediaType: signature[0] }
}

/** The image as a data: URL, from each shape image() takes. */
function imageUrl(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(IMAGE_EXPECTS)
  const item = value as Record<string, unknown>
  if (typeof item.image_url === 'string') return item.image_url
  if (item.type !== 'image') {
    // What a tool call resolved to, { text, result }, its result the image.
    if (typeof item.result === 'object' && item.result !== null) return imageUrl(item.result)
    throw new TypeError(IMAGE_EXPECTS)
  }
  // An MCP block's data, Read's file.base64, or an API block's source.data.
  const file = item.file as { base64?: unknown } | undefined
  const source = item.source as { data?: unknown } | undefined
  const data = [item.data, file?.base64, source?.data].find(candidate => typeof candidate === 'string' && candidate !== '')
  if (typeof data !== 'string') throw new TypeError(IMAGE_EXPECTS)
  return /^data:/i.test(data) ? data : `data:;base64,${data}`
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'
  if (value instanceof Error) return errorText(value)
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function errorText(thrown: unknown): string {
  if (thrown instanceof Error) return `${thrown.name}: ${thrown.message}`
  return formatValue(thrown)
}

async function formatResult(run: {
  started: number
  calls: number
  images: number
  modelCalls?: number
  modelTokens?: number
  output: string[]
  error?: unknown
  /** The script line that ran last, named beside a runtime error. */
  line?: number
  /** The nested calls, listed after the error of a failed script. */
  made?: readonly CodemodeCall[]
  maxOutputTokens?: number
  save?: (text: string) => Promise<string | undefined>
}): Promise<string> {
  const seconds = ((performance.now() - run.started) / 1000).toFixed(1)
  const pictures = run.images === 0 ? '' : `, ${run.images} image${run.images === 1 ? '' : 's'}`
  const models = !run.modelCalls ? '' : `, ${run.modelCalls} model call${run.modelCalls === 1 ? '' : 's'}${run.modelTokens ? ` (${tokenCount(run.modelTokens)} tokens)` : ''}`
  const count = `${run.calls} tool call${run.calls === 1 ? '' : 's'}${models}${pictures}`
  const header = run.error === undefined ? `Script completed in ${seconds}s, ${count}` : `Script failed after ${seconds}s, ${count}`

  // Colors and cursor moves from commands are noise to the model, and cost tokens.
  let text = plainText(run.output.join('\n'))
  const limit = (run.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS) * CHARS_PER_TOKEN
  if (text.length > limit) {
    const path = await run.save?.(text)
    const half = Math.floor(limit / 2)
    const where = path === undefined ? 'the full output could not be saved' : `full output in ${path}`
    text = `${text.slice(0, half)}\n\n[... ${text.length - limit} characters omitted; ${where} ...]\n\n${text.slice(-half)}`
  }

  const parts = [header]
  if (text.length > 0) parts.push(text)
  if (run.error !== undefined) {
    const near = run.line ? ` (near line ${run.line})` : ''
    parts.push(`Script error: ${plainText(errorText(run.error))}${near}`)
    if (run.made !== undefined && run.made.length > 0) parts.push(callList(run.made))
  }
  return parts.join('\n')
}
/** A failed script's nested calls, so a retry knows what already took effect. */
function callList(made: readonly CodemodeCall[]): string {
  const shown = made.slice(-FAILURE_CALLS)
  const earlier = made.length - shown.length
  const lines = shown.map(call => {
    const args = call.args === '' ? '' : `  ${call.args}`
    const ms = call.ms === undefined ? '' : `  ${call.ms} ms`
    const left = call.status === 'left' ? '  (still running when the script ended; it may still take effect)' : ''
    return `  ${CALL_WORDS[call.status].padEnd(6)} ${call.tool}${args}${ms}${left}`
  })
  return ['Calls the script made:', ...(earlier > 0 ? [`  … ${earlier} earlier call${earlier === 1 ? '' : 's'}`] : []), ...lines].join('\n')
}

const CALL_WORDS: Record<CodemodeCall['status'], string> = { running: 'left', ok: 'ok', error: 'failed', left: 'left' }

function tokenCount(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k`
}
