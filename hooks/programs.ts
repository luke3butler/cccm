// The code a pane carries: a script passes functions to ui.open, and the record keeps their source, so
// they outlive the script and a reload. A render runs here, in a sandboxed interpreter of its own, each
// time the pane draws; handlers and timers run as scripts (register.tsx).

import { AT, TICK, guard, keepSources } from './guard'
import { table } from './table'
import Sval from './vendor/sval.js'

/** The most source one function may be. */
export const MAX_PROGRAM_SOURCE = 20_000
/** The shortest period of a pane's timer. */
export const MIN_EVERY_MS = 1000
/** How long one render may compute. */
export const RENDER_MS = 250
/** Compiled functions kept, by source; the oldest drop off. */
const MAX_COMPILED = 64

/**
 * A function a script passed as source that evaluates to it. Arrows and function expressions print as
 * written; a method (`render({ data }) { ... }`) prints without its name or `async`, so it gets
 * `function` back, or `async function` when its body awaits.
 */
export function sourceOf(value: unknown, what: string): string {
  if (typeof value !== 'function' && typeof value !== 'string') throw new TypeError(`${what} must be a function.`)
  const text = String(value).trim()
  if (text.includes('[native code]')) throw new TypeError(`${what} must be a function the script wrote, not a built-in one.`)
  if (text.length > MAX_PROGRAM_SOURCE) throw new RangeError(`${what} may be at most ${MAX_PROGRAM_SOURCE} characters of source.`)
  let problem: unknown
  for (const candidate of [text, `function ${text}`, `async function ${text}`]) {
    try {
      new Sval({ ecmaVer: 'latest', sandBox: true }).parse(`(${candidate})`)
      return candidate
    } catch (thrown) {
      problem ??= thrown
    }
  }
  throw new SyntaxError(`${what} is not a function's source (${problem instanceof Error ? problem.message : String(problem)}).`)
}

const compiled = new Map<string, (...args: unknown[]) => unknown>()
/** While a render runs: when it must stop, and the line of it that ran last. */
let deadline = Infinity
let line = 0

/** The function `source` evaluates to, made once in an interpreter whose only globals are `globals`. */
function compile(source: string, globals: Record<string, unknown>): (...args: unknown[]) => unknown {
  const known = compiled.get(source)
  if (known !== undefined) {
    compiled.delete(source)
    compiled.set(source, known)
    return known
  }
  const interpreter = new Sval({ ecmaVer: 'latest', sandBox: true })
  interpreter.options.locations = true
  interpreter.importModule({
    ...globals,
    [TICK]: () => {
      if (performance.now() > deadline) throw new Error(`render computed for more than ${RENDER_MS} ms.`)
    },
    [AT]: (at: number) => {
      line = at
    },
    fetch: undefined,
    XMLHttpRequest: undefined,
    WebSocket: undefined,
  })
  const code = `exports.f = (${source}\n);`
  const ast = interpreter.parse(code)
  keepSources(ast, code)
  guard(ast)
  interpreter.run(ast)
  const fn = interpreter.exports.f
  if (typeof fn !== 'function') throw new TypeError('not a function.')
  compiled.set(source, fn as (...args: unknown[]) => unknown)
  if (compiled.size > MAX_COMPILED) compiled.delete(compiled.keys().next().value!)
  return fn as (...args: unknown[]) => unknown
}

/** What a render reads. */
export type RenderArgs = {
  id: string
  values: Record<string, unknown>
  data: Record<string, unknown>
  surface: string
  columns: number
}

/**
 * Runs a pane's render on `args` with `h` and `table` as its globals, at most RENDER_MS of it; what it returns is
 * the caller's to check. Throws with the line the render reached.
 */
export function runRender(source: string, args: RenderArgs, h: (...args: unknown[]) => unknown): unknown {
  deadline = performance.now() + RENDER_MS
  try {
    const render = compile(source, { h, table })
    line = 0
    const out = render(args)
    if (typeof (out as { then?: unknown } | null)?.then === 'function') {
      throw new TypeError('render returns elements, not a promise: fetch in an `on` handler or `every`, ui.set the result, and render reads it from data.')
    }
    return out
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown)
    // Line 1 is the wrapper's, which is the source's first line too.
    throw new Error(line > 0 ? `${message} (render line ${line})` : message)
  } finally {
    deadline = Infinity
  }
}
