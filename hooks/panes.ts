// Panes a script opens. A script ends long before its pane does, so a pane is a plain-data record in
// $.state (view, values, data, inbox) that the Pane hook draws from, presses write to, and later
// scripts read and change. Nothing here calls the engine; register.tsx makes the $ calls.

import type { CodemodeFollow, CodemodeJson, CodemodeNode, CodemodePane, CodemodePaneEvent, CodemodeProgram } from '../types'

import { CHART_COLORS, matchOf, parseColor } from './charts'
import { MIN_EVERY_MS, runRender, sourceOf } from './programs'

export const MAX_PANES = 20
export const MAX_INBOX = 100
export const MAX_VIEW_CHARS = 65_536
export const MAX_RECORD_CHARS = 524_288
export const DEFAULT_APPEND_MAX = 1000
/** ui.wait is for a quick confirmation; the person's considered answer comes back as a new turn instead. */
export const DEFAULT_WAIT_MS = 30_000
export const MAX_WAIT_MS = 120_000
/** How much of a pane's values an answer message carries. */
const MAX_ANSWER_VALUES_CHARS = 4000
/** What a Code or Markdown element takes. */
export const MAX_ELEMENT_TEXT = 10_000
/** Task output files followed at once, across the session's panes. */
export const MAX_FOLLOWS = 10
/** How long a streamed command may run: Claude Code stops a background command at its timeout, 30 minutes unless given, 2 hours at most. */
export const MAX_STREAM_MS = 7_200_000
/** Characters kept of one followed line. */
const MAX_FOLLOW_LINE_CHARS = 2000
const MAX_KEY_CHARS = 64
const PANE_ID = /^[A-Za-z0-9_-]{1,64}$/
/** How deep a view nests; the engine takes 32, and the pane's frame takes a few. */
export const MAX_VIEW_DEPTH = 24
/** The engine's bound on one Image's decoded bytes. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024

type Check =
  | 'string'
  | 'number'
  | 'boolean'
  | 'size'
  | 'cells'
  | 'json'
  | 'path'
  | 'valuesPath'
  | 'sets'
  | 'options'
  | 'href'
  | 'when'
  | 'boxHover'
  | 'textHover'
  | 'numbers'
  | 'color'
  | 'pngFile'
  | 'pngSrc'
  | 'regex'
  | readonly string[]
type Spec = { props: Record<string, Check>; required?: readonly string[]; children: 'any' | 'text' | 'none' }

const BOX_HOVER = ['scope', 'borderStyle', 'borderColor', 'borderDimColor', 'backgroundColor', 'display', 'top', 'left', 'right', 'bottom']
const TEXT_HOVER = ['scope', 'color', 'backgroundColor', 'dimColor', 'bold', 'italic', 'underline', 'strikethrough', 'inverse']

const LAYOUT: Record<string, Check> = {
  flexDirection: ['row', 'column', 'row-reverse', 'column-reverse'],
  flexGrow: 'number',
  flexShrink: 'number',
  flexWrap: ['nowrap', 'wrap', 'wrap-reverse'],
  alignItems: ['flex-start', 'center', 'flex-end', 'stretch'],
  alignSelf: ['flex-start', 'center', 'flex-end', 'auto'],
  justifyContent: ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'],
  gap: 'number',
  columnGap: 'number',
  rowGap: 'number',
  width: 'size',
  height: 'size',
  minWidth: 'size',
  minHeight: 'size',
  ...Object.fromEntries(
    ['margin', 'marginX', 'marginY', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight'].map(name => [name, 'number' as const]),
  ),
  ...Object.fromEntries(
    ['padding', 'paddingX', 'paddingY', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight'].map(name => [name, 'number' as const]),
  ),
  borderStyle: 'string',
  borderColor: 'string',
  borderDimColor: 'boolean',
  backgroundColor: 'string',
  overflow: ['visible', 'hidden'],
  display: ['flex', 'none'],
  position: ['relative', 'absolute'],
  top: 'number',
  left: 'number',
  right: 'number',
  bottom: 'number',
  key: 'string',
  hover: 'boxHover',
}

const TEXT_STYLE: Record<string, Check> = {
  color: 'string',
  backgroundColor: 'string',
  dimColor: 'boolean',
  bold: 'boolean',
  italic: 'boolean',
  underline: 'boolean',
  strikethrough: 'boolean',
  inverse: 'boolean',
  wrap: ['wrap', 'end', 'middle', 'truncate', 'truncate-start', 'truncate-middle', 'truncate-end'],
}

/** The elements a view may hold. Image and Chart draw on every surface, each in its own way (pane-view.tsx). */
const ELEMENTS: Record<string, Spec> = {
  Box: { props: LAYOUT, children: 'any' },
  Text: { props: { ...TEXT_STYLE, bind: 'path', tail: 'number', hover: 'textHover' }, children: 'text' },
  Button: {
    props: {
      key: 'string',
      label: 'string',
      hotkey: 'string',
      plain: 'boolean',
      dimColor: 'boolean',
      variant: ['primary', 'secondary'],
      emit: 'string',
      data: 'json',
      set: 'sets',
      close: 'boolean',
      push: ['queue', 'wake', 'draft'], prompt: 'string',
    },
    required: ['key'],
    children: 'text',
  },
  Input: {
    props: { key: 'string', label: 'string', placeholder: 'string', submitLabel: 'string', bind: 'valuesPath', emit: 'string', push: ['queue', 'wake', 'draft'], prompt: 'string' },
    required: ['key'],
    children: 'none',
  },
  Select: {
    props: { key: 'string', label: 'string', options: 'options', bind: 'valuesPath', emit: 'string', push: ['queue', 'wake', 'draft'], prompt: 'string' },
    required: ['key', 'options'],
    children: 'none',
  },
  Markdown: { props: { text: 'string', bind: 'path', tail: 'number', dimColor: 'boolean' }, children: 'none' },
  Code: {
    props: {
      source: 'string',
      bind: 'path',
      tail: 'number',
      language: 'string',
      path: 'string',
      startLine: 'number',
      format: ['source', 'diff'],
      wrap: ['wrap', 'truncate-end'],
    },
    children: 'none',
  },
  Link: { props: { href: 'href', label: 'string' }, required: ['href'], children: 'none' },
  Image: {
    props: { file: 'pngFile', src: 'pngSrc', bind: 'path', alt: 'string', columns: 'cells', rows: 'cells', key: 'string' },
    required: ['alt', 'columns', 'rows'],
    children: 'none',
  },
  Chart: {
    props: { kind: ['spark', 'bars', 'line'], values: 'numbers', bind: 'path', match: 'regex', columns: 'cells', rows: 'cells', color: 'color', min: 'number', max: 'number', alt: 'string' },
    required: ['kind'],
    children: 'none',
  },
}

/** Every element takes `when`: drawn only while the pane's values and data match it. */
export const SPECS: Record<string, Spec> = Object.fromEntries(
  Object.entries(ELEMENTS).map(([type, spec]) => [type, { ...spec, props: { ...spec.props, when: 'when' as const } }]),
)

/** A pane id as the engine takes it. */
export function checkPaneId(id: unknown): string {
  if (typeof id !== 'string' || !PANE_ID.test(id)) {
    throw new TypeError('A pane id is 1-64 letters, digits, "_" or "-".')
  }
  return id
}

/** A plain JSON copy of what a script passed, or a TypeError naming what. */
export function toJson(value: unknown, what: string): CodemodeJson {
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    json = undefined
  }
  if (json === undefined) throw new TypeError(`${what} must be a JSON value.`)
  return JSON.parse(json) as CodemodeJson
}

/** A JSON object a script passed, such as `values` or `data`. */
export function toObject(value: unknown, what: string): { [key: string]: CodemodeJson } {
  const json = toJson(value, what)
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new TypeError(`${what} must be an object.`)
  return json
}

/** What a script's h() builds: a node, its children flattened, null, false and true dropped. */
export function h(type: unknown, props?: unknown, ...children: unknown[]): CodemodeNode {
  if (typeof type !== 'string' || !(type in SPECS)) {
    throw new TypeError(`h(): no element ${String(type)}. Elements: ${Object.keys(SPECS).join(', ')}.`)
  }
  const flat: (CodemodeNode | string)[] = []
  const add = (child: unknown) => {
    if (child === null || child === undefined || typeof child === 'boolean') return
    if (Array.isArray(child)) return child.forEach(add)
    if (typeof child === 'string' || typeof child === 'number') return flat.push(String(child))
    flat.push(child as CodemodeNode)
  }
  children.forEach(add)
  return { type, props: props === undefined || props === null ? {} : toObject(props, `h("${type}") props`), children: flat }
}

/** Checks a view against SPECS, throwing a TypeError at the first problem with its place in the tree. */
export function checkView(view: unknown): CodemodeNode {
  const node = toJson(view, 'A view') as unknown
  const keys = new Set<string>()
  visit(node, 'view', keys, 1)
  if (JSON.stringify(node).length > MAX_VIEW_CHARS) throw new RangeError(`A view may be at most ${MAX_VIEW_CHARS} characters of JSON.`)
  return node as CodemodeNode
}

function visit(node: unknown, at: string, keys: Set<string>, depth: number): void {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) throw new TypeError(`${at}: not an element; build one with h().`)
  if (depth > MAX_VIEW_DEPTH) throw new RangeError(`${at}: a view nests at most ${MAX_VIEW_DEPTH} elements deep.`)
  const { type, props = {}, children = [] } = node as { type?: unknown; props?: unknown; children?: unknown }
  const spec = typeof type === 'string' ? SPECS[type] : undefined
  if (spec === undefined) throw new TypeError(`${at}: no element ${String(type)}. Elements: ${Object.keys(SPECS).join(', ')}.`)
  if (typeof props !== 'object' || props === null || Array.isArray(props)) throw new TypeError(`${at}: props must be an object.`)
  if (!Array.isArray(children)) throw new TypeError(`${at}: children must be an array.`)
  const here = `${at} (${type})`
  for (const [name, value] of Object.entries(props as Record<string, unknown>)) {
    const check = spec.props[name]
    if (check === undefined) throw new TypeError(`${here}: ${type} takes no prop "${name}". It takes: ${Object.keys(spec.props).join(', ')}.`)
    const problem = checkProp(check, value)
    if (problem !== undefined) throw new TypeError(`${here}: ${name} ${problem}.`)
  }
  for (const name of spec.required ?? []) {
    if (!(name in (props as object))) throw new TypeError(`${here}: ${type} needs a "${name}" prop.`)
  }
  const key = (props as { key?: unknown }).key
  if (typeof key === 'string') {
    if (key.length === 0 || key.length > MAX_KEY_CHARS) throw new TypeError(`${here}: key must be 1-${MAX_KEY_CHARS} characters.`)
    if (keys.has(key)) throw new TypeError(`${here}: the key "${key}" is used twice; each key in a view is its own.`)
    keys.add(key)
  }
  if (type === 'Code' || type === 'Markdown') {
    const text = type === 'Code' ? 'source' : 'text'
    if (!(text in (props as object)) && !('bind' in (props as object))) throw new TypeError(`${here}: ${type} needs "${text}" or "bind".`)
    const value = (props as Record<string, unknown>)[text]
    if (typeof value === 'string' && value.length > MAX_ELEMENT_TEXT) throw new RangeError(`${here}: ${text} is at most ${MAX_ELEMENT_TEXT} characters; bind a longer one with tail.`)
  }
  if (type === 'Image') {
    const sources = ['file', 'src', 'bind'].filter(name => name in (props as object))
    if (sources.length !== 1) throw new TypeError(`${here}: Image takes one of file, src or bind.`)
  }
  if (type === 'Chart' && !('values' in (props as object)) && !('bind' in (props as object))) throw new TypeError(`${here}: Chart needs "values" or "bind".`)
  children.forEach((child: unknown, i: number) => {
    const childAt = `${at}.children[${i}]`
    if (typeof child === 'string') {
      if (spec.children === 'none') throw new TypeError(`${here}: ${type} takes no children.`)
      if (child.length > MAX_ELEMENT_TEXT) throw new RangeError(`${childAt}: a string is at most ${MAX_ELEMENT_TEXT} characters; bind a longer one with tail.`)
      return
    }
    if (spec.children === 'none') throw new TypeError(`${here}: ${type} takes no children.`)
    if (spec.children === 'text' && (child as { type?: unknown })?.type !== 'Text') {
      throw new TypeError(`${childAt}: ${type} holds only strings and Text.`)
    }
    visit(child, childAt, keys, depth + 1)
  })
}

function checkProp(check: Check, value: unknown): string | undefined {
  if (Array.isArray(check)) return check.includes(value as string) ? undefined : `must be one of ${check.join(', ')}`
  switch (check) {
    case 'string':
      return typeof value === 'string' ? undefined : 'must be a string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? undefined : 'must be a number'
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'must be true or false'
    case 'size':
      return typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?%$/.test(value)) ? undefined : 'must be a number or a percentage'
    case 'json':
      return undefined
    case 'path':
      return isPath(value, ['values', 'data']) ? undefined : 'must be a path under values or data, as "data.log"'
    case 'valuesPath':
      return isPath(value, ['values']) ? undefined : 'must be a path under values, as "values.note"'
    case 'sets':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'must map paths under values to the values to set'
      for (const path of Object.keys(value)) if (!isPath(path, ['values'])) return `names "${path}", not a path under values`
      return undefined
    case 'options':
      if (!Array.isArray(value) || value.length === 0) return 'must be a list of at least one option'
      for (const option of value) {
        const v = typeof option === 'string' ? option : (option as { value?: unknown })?.value
        if (typeof v !== 'string') return 'must hold strings or { value, label? }'
      }
      return new Set(value.map(option => (typeof option === 'string' ? option : option.value))).size === value.length ? undefined : 'must not repeat a value'
    case 'href':
      return typeof value === 'string' && /^(https?|file):/.test(value) ? undefined : 'must be an https:, http: or file: URL'
    case 'cells':
      return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 255 ? undefined : 'must be a whole number of cells, 1 to 255'
    case 'when':
      return checkWhen(value)
    case 'boxHover':
    case 'textHover': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'must be an object of style overrides'
      const allowed = check === 'boxHover' ? BOX_HOVER : TEXT_HOVER
      for (const name of Object.keys(value)) if (!allowed.includes(name)) return `takes no "${name}"; it takes ${allowed.join(', ')}`
      if (check === 'boxHover' && 'display' in value && (value as { display?: unknown }).display !== 'flex') return 'display is "flex" alone, revealing a Box drawn display: "none"'
      return undefined
    }
    case 'numbers':
      return Array.isArray(value) && value.every(n => typeof n === 'number' && Number.isFinite(n)) ? undefined : 'must be a list of numbers'
    case 'color':
      return typeof value === 'string' && parseColor(value) !== undefined ? undefined : `must be "#rrggbb", "#rgb" or one of ${CHART_COLORS.join(', ')}`
    case 'regex':
      return matchOf(value) !== undefined ? undefined : 'must be a regular expression of 1-200 characters, as "time=([0-9.]+)"'
    case 'pngFile':
      return typeof value === 'string' && value.startsWith('/') && /\.png$/i.test(value) ? undefined : 'must be the absolute path of a PNG file'
    case 'pngSrc':
      if (typeof value !== 'string' || pngOf(value) === undefined) return 'must be a data:image/png;base64, URL of a PNG file'
      return (pngOf(value)!.length * 3) / 4 <= MAX_IMAGE_BYTES ? undefined : `must decode to at most ${MAX_IMAGE_BYTES} bytes`
  }
}

/**
 * The base64 of a PNG data URL, or undefined when `src` is not one: the bytes must open with PNG's
 * signature, as the engine refuses the whole drawing over an Image that doesn't.
 */
export function pngOf(src: string): string | undefined {
  const base64 = /^data:image\/png;base64,(iVBORw0KGgoAAAANSUhEUg[A-Za-z0-9+/]*={0,2})$/.exec(src)?.[1]
  return base64 !== undefined && base64.length % 4 === 0 ? base64 : undefined
}

function checkWhen(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length === 0) {
    return 'must map paths under values or data to what they must hold, as { "values.tab": "logs" }'
  }
  for (const [path, test] of Object.entries(value)) {
    if (!isPath(path, ['values', 'data'])) return `names "${path}", not a path under values or data`
    if (isOperator(test, 'exists') && typeof test.exists !== 'boolean') return `${path}: exists must be true or false`
  }
  return undefined
}

function isOperator<K extends 'not' | 'exists'>(test: unknown, name: K): test is Record<K, CodemodeJson> {
  return typeof test === 'object' && test !== null && !Array.isArray(test) && Object.keys(test).length === 1 && name in test
}

function sameJson(a: CodemodeJson | undefined, b: CodemodeJson | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function matchesTest(value: CodemodeJson | undefined, test: CodemodeJson): boolean {
  if (Array.isArray(test)) return test.some(one => sameJson(value, one))
  if (isOperator(test, 'not')) return !matchesTest(value, test.not)
  if (isOperator(test, 'exists')) return (value !== undefined && value !== null) === test.exists
  return sameJson(value, test)
}

/**
 * Whether a node's `when` holds for the pane: each path's value equals the test, is one of a list's,
 * differs under { not }, or is present (not null) under { exists: true }.
 */
export function isShown(pane: CodemodePane, when: CodemodeJson | undefined): boolean {
  if (typeof when !== 'object' || when === null || Array.isArray(when)) return true
  return Object.entries(when).every(([path, test]) => matchesTest(getAt(pane, path), test))
}

/** What a session's surfaces won't draw of a view as written, one line each, for ui.open's result. */
export function fallbacksOf(view: CodemodeNode, surfaces: readonly string[], pixels: boolean | undefined): string[] {
  const out = new Set<string>()
  const walk = (node: CodemodeNode | string) => {
    if (typeof node === 'string') return
    const props = node.props
    if (node.type === 'Image') {
      const name = `Image "${String(props.alt)}"`
      for (const surface of surfaces) {
        if (surface === 'terminal' && pixels === false) out.add(`${name}: this terminal shows no pixels, so it draws the alt text`)
        if (surface !== 'terminal' && 'file' in props) out.add(`${name}: ${surface} draws a file source as its alt text; a src draws`)
      }
    }
    if ((node.type === 'Input' || node.type === 'Select') && surfaces.includes('mobile')) out.add(`${node.type} "${String(props.key)}": the mobile app draws no field yet, only a note`)
    node.children.forEach(walk)
  }
  walk(view)
  return [...out]
}

function isPath(value: unknown, roots: readonly string[]): value is string {
  if (typeof value !== 'string') return false
  const parts = value.split('.')
  return parts.length >= 2 && roots.includes(parts[0]!) && parts.every(part => part.length > 0)
}

/** The value at a path such as "data.log" or "values.items.0.done"; undefined when absent. */
export function getAt(pane: CodemodePane, path: string): CodemodeJson | undefined {
  let at: unknown = pane
  for (const part of path.split('.')) {
    if (typeof at !== 'object' || at === null) return undefined
    at = (at as Record<string, unknown>)[part]
  }
  return at as CodemodeJson | undefined
}

/** A copy of the pane with `value` at `path`, making objects along the way. */
export function setAt(pane: CodemodePane, path: string, value: CodemodeJson): CodemodePane {
  const [root, ...rest] = path.split('.')
  if (root !== 'values' && root !== 'data') throw new TypeError(`"${path}" is not a path under values or data.`)
  return { ...pane, [root]: setIn(pane[root], rest, value) as { [key: string]: CodemodeJson } }
}

function setIn(at: CodemodeJson | undefined, parts: string[], value: CodemodeJson): CodemodeJson {
  if (parts.length === 0) return value
  const [part, ...rest] = parts as [string, ...string[]]
  if (Array.isArray(at) && /^\d+$/.test(part)) {
    const copy = [...at]
    copy[Number(part)] = setIn(copy[Number(part)], rest, value)
    return copy
  }
  const object = typeof at === 'object' && at !== null && !Array.isArray(at) ? at : {}
  return { ...object, [part]: setIn(object[part], rest, value) }
}

/** A copy with `items` added to the list at `path`, keeping its last `max`. */
export function appendAt(pane: CodemodePane, path: string, items: CodemodeJson[], max = DEFAULT_APPEND_MAX): CodemodePane {
  const current = getAt(pane, path)
  const list = Array.isArray(current) ? current : current === undefined ? [] : [current]
  return setAt(pane, path, [...list, ...items].slice(-Math.max(1, max)))
}

/** A new pane record. */
export function newPane(id: string, title: string, view: CodemodeNode): CodemodePane {
  return { id, title, view, values: {}, data: {}, inbox: [], isOpen: true, updatedAt: Date.now() }
}

/** A name in a pane's `on`: what a Button's emit (or key) says to run it. */
const HANDLER_NAME = /^[A-Za-z0-9_.-]{1,64}$/
const MAX_HANDLERS = 32
/** How much of an error a pane shows. */
const MAX_SHOWN_ERROR = 2000

/**
 * The program after a script's `render`, `on` and `every`: each given one replaces what was (`on` as a
 * whole), null removes it, and one left out stays.
 */
export function programOf(what: string, changes: { render?: unknown; on?: unknown; every?: unknown }, current: CodemodeProgram | undefined): CodemodeProgram | undefined {
  const { render, on, every } = changes
  const next: CodemodeProgram = { ...current }
  if (render === null) delete next.render
  else if (render !== undefined) next.render = sourceOf(render, `${what}: render`)
  if (on === null) delete next.on
  else if (on !== undefined) {
    if (typeof on !== 'object' || Array.isArray(on)) throw new TypeError(`${what}: on maps names to functions, as { refresh: async ({ id }) => ... }.`)
    const entries = Object.entries(on as Record<string, unknown>)
    if (entries.length > MAX_HANDLERS) throw new RangeError(`${what}: a pane takes at most ${MAX_HANDLERS} handlers.`)
    next.on = Object.fromEntries(
      entries.map(([name, fn]) => {
        if (!HANDLER_NAME.test(name)) throw new TypeError(`${what}: the handler name ${JSON.stringify(name)} is not 1-64 letters, digits, "_", "." or "-".`)
        return [name, sourceOf(fn, `${what}: on.${name}`)]
      }),
    )
  }
  if (every === null) delete next.every
  else if (every !== undefined) {
    const { ms, run } = (typeof every === 'object' && every !== null ? every : {}) as { ms?: unknown; run?: unknown }
    const period = Number(ms)
    if (!Number.isFinite(period) || period < MIN_EVERY_MS) throw new RangeError(`${what}: every is { ms, run }, ms at least ${MIN_EVERY_MS}.`)
    next.every = { ms: Math.round(period), run: sourceOf(run, `${what}: every.run`) }
  }
  return Object.keys(next).length === 0 ? undefined : next
}

/** Where a view is drawn, as a render reads it. */
export type ViewPlace = { surface: string; columns: number }

/** What the pane's render draws for its values and data, checked as a script's view is; throws as it does. */
export function renderedView(pane: CodemodePane, where: ViewPlace): CodemodeNode {
  const out = runRender(
    pane.program!.render!,
    { id: pane.id, values: structuredClone(pane.values), data: structuredClone(pane.data), surface: where.surface, columns: where.columns },
    h as (...args: unknown[]) => unknown,
  )
  const node =
    out === null || out === undefined || out === false
      ? h('Box', {})
      : typeof out === 'string' || typeof out === 'number'
        ? h('Text', {}, String(out))
        : Array.isArray(out)
          ? h('Box', { flexDirection: 'column' }, ...out)
          : out
  return checkView(node)
}

/**
 * What a pane draws: its render's view (a note in its place when the render fails, which `renderError`
 * gives), else its view; a handler's or timer's latest failure under it.
 */
export function viewOf(pane: CodemodePane, where: ViewPlace): { view: CodemodeNode; renderError?: string } {
  let view = pane.view
  let renderError: string | undefined
  if (pane.program?.render !== undefined) {
    try {
      view = renderedView(pane, where)
    } catch (thrown) {
      renderError = thrown instanceof Error ? thrown.message : String(thrown)
      view = h('Text', { color: 'red' }, `render failed: ${renderError}`.slice(0, MAX_SHOWN_ERROR))
    }
  }
  if (pane.error !== undefined) {
    view = h('Box', { flexDirection: 'column' }, view, h('Text', { color: 'red' }, `${pane.error.in} failed: ${pane.error.message}`.slice(0, MAX_SHOWN_ERROR)))
  }
  return renderError === undefined ? { view } : { view, renderError }
}

/** A pane's render run once on its values and data, as ui.open and ui.update check it before it is kept. */
function tryRender(what: string, pane: CodemodePane): void {
  if (pane.program?.render === undefined) return
  try {
    renderedView(pane, { surface: 'terminal', columns: 60 })
  } catch (thrown) {
    throw new TypeError(`${what}: render failed on the pane's values and data: ${thrown instanceof Error ? thrown.message : String(thrown)}`)
  }
}

/** One event as a line of an answer or a pane's "seen" list. */
export function eventLine(event: CodemodePaneEvent): string {
  if (event.type === 'closed') return 'closed the pane'
  const verb = event.type === 'press' ? 'pressed' : event.type === 'submit' ? 'submitted' : 'picked'
  const value = event.value === undefined ? '' : ` = ${JSON.stringify(event.value)}`
  const data = event.data === undefined ? '' : ` data=${JSON.stringify(event.data)}`
  return `${verb} ${event.element}${event.emit !== undefined && event.emit !== event.element ? ` (${event.emit})` : ''}${value}${data}`
}

/**
 * The message a `push: "wake"` element starts the model's turn with: the pane's question, the person's
 * values and the events since a script last read them, so the turn needs no ui.take round trip.
 */
export function answerText(pane: CodemodePane, events: readonly CodemodePaneEvent[], extra?: string): string {
  const values = JSON.stringify(pane.values)
  const lines = [
    `The person answered in codemode pane "${pane.id}" (${pane.title}).`,
    ...(pane.ask ? [`It asked: ${pane.ask}`] : []),
    ...(extra ? [extra] : []),
    `Values: ${values.length > MAX_ANSWER_VALUES_CHARS ? `${values.slice(0, MAX_ANSWER_VALUES_CHARS)}… (ui.get("${pane.id}") has all of it)` : values}`,
    ...(events.length > 0 ? ['What they did, oldest first (now marked read):', ...events.map(event => `- ${eventLine(event)}`)] : []),
    `The pane is ${pane.isOpen ? 'still open' : 'closed'}. Update it with ui.update or ui.set in a codemode script, and ui.close("${pane.id}") once it is done with.`,
  ]
  return lines.join('\n')
}

/** A `prompt` template with each {values.x} or {data.y} filled from the pane: strings as is, the rest as JSON. */
export function fillPrompt(template: string, pane: CodemodePane): string {
  return template.replace(/\{((?:values|data)(?:\.[^.{}\s]+)+)\}/g, (_, path: string) => {
    const value = getAt(pane, path)
    return value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value)
  })
}

/** A copy with the event added to the inbox, dropping the oldest past MAX_INBOX. */
export function pushEvent(pane: CodemodePane, event: CodemodePaneEvent): CodemodePane {
  return { ...pane, inbox: [...pane.inbox, event].slice(-MAX_INBOX) }
}

/** Throws when the record grew past MAX_RECORD_CHARS. */
export function checkSize(pane: CodemodePane): CodemodePane {
  const chars = JSON.stringify(pane).length
  if (chars > MAX_RECORD_CHARS) {
    throw new RangeError(`Pane "${pane.id}" would hold ${chars} characters of JSON; a pane holds at most ${MAX_RECORD_CHARS}. Trim data, or append with a smaller max.`)
  }
  return pane
}

/** The text a bound Text, Code or Markdown draws: strings as is, lists one item per line, anything else as JSON. */
export function boundText(value: CodemodeJson | undefined, tail?: number): string {
  if (value === undefined || value === null) return ''
  let lines: string[]
  if (Array.isArray(value)) lines = value.map(item => (typeof item === 'string' ? item : JSON.stringify(item)))
  else if (typeof value === 'string') lines = value.split('\n')
  else if (typeof value === 'object') lines = JSON.stringify(value, null, 2).split('\n')
  else lines = [String(value)]
  if (tail !== undefined && tail > 0) lines = lines.slice(-Math.floor(tail))
  return lines.join('\n')
}

/** The line a turn's prompt carries for panes with unread events, or undefined when none have any. */
export function inboxNote(panes: readonly CodemodePane[]): string | undefined {
  const unread = panes.filter(pane => pane.inbox.length > 0)
  if (unread.length === 0) return undefined
  const lines = unread.map(pane => {
    const counts = new Map<string, number>()
    for (const event of pane.inbox) {
      const name = event.type === 'closed' ? 'closed' : (event.emit ?? event.element ?? event.type)
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    const list = [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ')
    return `- "${pane.id}" (${pane.title}): ${pane.inbox.length} unread (${list})`
  })
  return `Codemode panes with events no script has read yet; read them with ui.take(id) in a codemode script:\n${lines.join('\n')}`
}

/**
 * Coalesces changes to pane records: changes made while a write is in flight land together in the next
 * one, so a script appending in a loop is a few writes, not one per call. `write` applies a function to
 * the stored record (update() in register.tsx, which may run it again on a version miss).
 */
export function paneWriter(write: (id: string, apply: (pane: CodemodePane | null) => CodemodePane | null) => Promise<void>) {
  type Change = { apply: (pane: CodemodePane | null) => CodemodePane | null; resolve: () => void; reject: (error: unknown) => void }
  const queued = new Map<string, Change[]>()
  const writing = new Map<string, Promise<void>>()

  const drain = async (id: string) => {
    while ((queued.get(id)?.length ?? 0) > 0) {
      const batch = queued.get(id)!
      queued.set(id, [])
      let outcomes: (unknown | undefined)[] = []
      try {
        await write(id, stored => {
          outcomes = []
          let pane = stored
          for (const change of batch) {
            try {
              pane = change.apply(pane)
              outcomes.push(undefined)
            } catch (error) {
              outcomes.push(error ?? new Error('The pane change failed.'))
            }
          }
          return pane
        })
      } catch (error) {
        outcomes = batch.map(() => error ?? new Error('The pane write failed.'))
      }
      batch.forEach((change, i) => (outcomes[i] === undefined ? change.resolve() : change.reject(outcomes[i])))
    }
  }

  return {
    change(id: string, apply: (pane: CodemodePane | null) => CodemodePane | null): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const list = queued.get(id) ?? []
        list.push({ apply, resolve, reject })
        queued.set(id, list)
        if (!writing.has(id)) {
          const run = drain(id).finally(() => writing.delete(id))
          writing.set(id, run)
        }
      })
    },
    /** Settles once every queued change is written. */
    async flush(): Promise<void> {
      while (writing.size > 0) await Promise.allSettled([...writing.values()])
    },
  }
}

/**
 * Output split into its complete lines, the unfinished rest kept for the next piece. A line keeps what
 * follows its last carriage return, as a terminal shows a progress line that rewrites itself.
 */
export function splitOutput(partial: string, text: string): { lines: string[]; partial: string } {
  const parts = (partial + text).replace(/\r\n/g, '\n').split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts.map(outputLine), partial: rest }
}

/** One line of output as a followed list keeps it. */
export function outputLine(line: string): string {
  const cr = line.lastIndexOf('\r')
  return (cr >= 0 ? line.slice(cr + 1) : line).slice(0, MAX_FOLLOW_LINE_CHARS)
}

/** The bytes `text` takes as UTF-8: how far into the file a follow has read. */
export function utf8Bytes(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      bytes += 4
      i += 1
    } else bytes += 3
  }
  return bytes
}

/** What a follow's status path shows. */
export function followState(follow: CodemodeFollow): string {
  return follow.state === 'ended' ? (follow.ended ?? 'ended') : follow.state
}

/**
 * A copy with a follow's new lines appended and its offset moved on; past MAX_RECORD_CHARS the list
 * drops its oldest half until the record fits, so long lines can't stop the follow.
 */
export function addFollowed(pane: CodemodePane, to: string, lines: readonly string[], offset: number): CodemodePane {
  const follows = pane.follows ?? []
  const follow = follows.find(one => one.to === to)
  if (follow === undefined) return pane
  let next = lines.length > 0 ? appendAt(pane, to, [...lines], follow.max) : pane
  while (JSON.stringify(next).length > MAX_RECORD_CHARS) {
    const list = getAt(next, to)
    if (!Array.isArray(list) || list.length <= 1) break
    next = setAt(next, to, list.slice(Math.ceil(list.length / 2)))
  }
  return { ...next, follows: follows.map(one => (one.to === to ? { ...one, offset } : one)), updatedAt: Date.now() }
}

/** A copy with a follow ended or stopped, its status path saying how. */
export function endFollow(pane: CodemodePane, to: string, state: 'ended' | 'stopped', ended?: string): CodemodePane {
  const follow = pane.follows?.find(one => one.to === to)
  if (follow === undefined || follow.state !== 'following') return pane
  const done: CodemodeFollow = { ...follow, state, ...(ended !== undefined ? { ended } : {}) }
  const next = { ...pane, follows: pane.follows!.map(one => (one.to === to ? done : one)), updatedAt: Date.now() }
  return done.status === undefined ? next : setAt(next, done.status, followState(done))
}

/** What ui.follow asks the host for; `task` is the background task ui.stream started. */
export type FollowSpec = { file: string; to: string; max: number; status?: string; fromEnd: boolean; task?: string }

/** The output file a background Bash result's text names for its task, or undefined. */
export function taskFileOf(text: string, taskId: string): string | undefined {
  const id = taskId.replace(/[^A-Za-z0-9_-]/g, '')
  if (id === '') return undefined
  return new RegExp(`(/\\S*/${id}\\.output)(?![A-Za-z0-9_-])`).exec(text)?.[1]
}

/** What the `ui` global needs from the engine; register.tsx makes the $ calls. */
export type PaneHost = {
  /** Queues a change to a pane's record (coalesced with others in flight); null removes it. */
  change: (id: string, apply: (pane: CodemodePane | null) => CodemodePane | null) => Promise<void>
  get: (id: string) => Promise<CodemodePane | null>
  /** The ids of the session's pane records, in creation order. */
  ids: () => Promise<string[]>
  /** Opens (or retitles) the engine's pane for a record. */
  show: (id: string, title: string, focus: boolean) => Promise<{ isPlaced: boolean; reason?: string }>
  /** Closes the engine's pane, leaving the record. */
  hide: (id: string) => Promise<void>
  /** Whether each of the plugin's engine panes is placed on screen. */
  placed: () => Promise<Map<string, boolean>>
  /** The surfaces the session draws on, and whether its terminal shows pixels (undefined until an Image tells). */
  drawing: () => Promise<{ surfaces: string[]; pixels?: boolean }>
  /** Why the pane's render failed the last time it drew, if it did. */
  renderError?: (id: string) => string | undefined
  /** Resolves when the pane gets an event, or once `signal` aborts. */
  nextEvent: (id: string, signal: AbortSignal) => Promise<void>
  /** Settles once every queued change is written. */
  flush: () => Promise<void>
  /** Starts following a task's output file into the pane, after the script ends too. */
  follow: (id: string, spec: FollowSpec) => Promise<{ following: true; ended?: string }>
  /** Stops the pane's follows (the one at `to`, when given); resolves how many stopped. */
  unfollow: (id: string, to?: string) => Promise<number>
  /** Stops a background task (TaskStop). */
  stopTask?: (taskId: string) => Promise<void>
}

/** What paneGlobals borrows from the run: its checks, its host-work tracking, its call rows, its end. */
export type PaneRun = {
  check: () => void
  track: <T>(work: () => Promise<T>) => Promise<T>
  recorded: <T>(name: string, args: string, work: () => Promise<T>) => Promise<T>
  sleep: (ms: number) => Promise<void>
  signal: AbortSignal
  /** Starts `command` as a background Bash task, as the script's own tools.Bash call; resolves its id and output file. */
  background?: (command: string, description: string | undefined, timeoutMs: number) => Promise<{ taskId: string; file: string }>
}

/** The `ui` global: opens, changes and reads panes, whose records outlive the script. */
export function paneGlobals(host: PaneHost, run: PaneRun) {
  const exists = async (id: string) => {
    const pane = await run.track(() => host.get(id))
    if (pane === null) throw new Error(`No pane "${id}". ui.panes() lists them; ui.open({ id, view }) makes one.`)
    return pane
  }
  /** A change that fails when the record is gone, checked for size. */
  const changeOf = (id: string, apply: (pane: CodemodePane) => CodemodePane) =>
    run.track(() =>
      host.change(id, pane => {
        if (pane === null) throw new Error(`No pane "${id}". ui.open({ id, view }) makes one.`)
        return checkSize({ ...apply(pane), updatedAt: Date.now() })
      }),
    )
  const pathOf = (path: unknown) => {
    if (!isPath(path, ['values', 'data'])) throw new TypeError(`${JSON.stringify(path)} is not a path under values or data, as "data.log".`)
    return path
  }
  /** Stops the commands ui.stream started for the pane's running follows (the one at `to`, when given). */
  const stopStreams = async (pane: CodemodePane, to?: string) => {
    const tasks = (pane.follows ?? []).filter(follow => follow.task !== undefined && follow.state === 'following' && (to === undefined || follow.to === to))
    await Promise.all(tasks.map(follow => run.track(() => host.stopTask?.(follow.task!) ?? Promise.resolve())))
  }
  /** ui.follow's and ui.stream's options, checked. */
  const followOptions = (what: string, options: unknown) => {
    const { to = 'data.log', max = DEFAULT_APPEND_MAX, status, from = 'start', description, timeout = MAX_STREAM_MS } = toObject(options ?? {}, `${what} options`) as Record<string, unknown>
    const at = pathOf(to)
    if (status !== undefined && !isPath(status, ['values', 'data'])) throw new TypeError(`${what}: status ${JSON.stringify(status)} is not a path under values or data.`)
    if (status === at) throw new TypeError(`${what}: status needs a path of its own, not the lines' path.`)
    const keep = Number(max)
    if (!Number.isFinite(keep) || keep < 1) throw new TypeError(`${what}: max must be a positive number.`)
    if (from !== 'start' && from !== 'end') throw new TypeError(`${what}: from is "start" (the default: the output so far, then what follows) or "end".`)
    if (description !== undefined && typeof description !== 'string') throw new TypeError(`${what}: description must be a string.`)
    if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1000 || timeout > MAX_STREAM_MS) {
      throw new TypeError(`${what}: timeout is the command's limit in ms, 1000 to ${MAX_STREAM_MS} (2 hours, the default).`)
    }
    return { at, keep, status: status as string | undefined, fromEnd: from === 'end', description: description as string | undefined, timeout }
  }
  const take = async (id: string) => {
    let taken: CodemodePaneEvent[] = []
    await run.track(() =>
      host.change(id, pane => {
        taken = pane?.inbox ?? []
        return pane === null ? null : { ...pane, inbox: [] }
      }),
    )
    return taken.map(event => ({ ...event }))
  }

  return {
    open: async (args: unknown) => {
      run.check()
      const { id: rawId, title, ask, view, values, data, focus, render, on, every } = (args ?? {}) as Record<string, unknown>
      if (ask !== undefined && typeof ask !== 'string') throw new TypeError('ui.open(): ask must be a string.')
      const id = checkPaneId(rawId)
      const checked = view === undefined ? undefined : checkView(view)
      const newValues = values === undefined ? undefined : toObject(values, 'values')
      const newData = data === undefined ? undefined : toObject(data, 'data')
      if (title !== undefined && typeof title !== 'string') throw new TypeError('ui.open(): title must be a string.')
      return run.recorded('ui.open', id, async () => {
        const ids = await run.track(() => host.ids())
        if (!ids.includes(id) && ids.length >= MAX_PANES) throw new RangeError(`A session holds at most ${MAX_PANES} panes; ui.remove(id) one first.`)
        let shownTitle = id
        // A view or any code defines the pane anew; an open by id alone keeps what it has.
        const isDefined = checked !== undefined || render !== undefined || on !== undefined || every !== undefined
        const program = isDefined ? programOf('ui.open()', { render, on, every }, undefined) : undefined
        await run.track(() =>
          host.change(id, stored => {
            if (stored === null && checked === undefined && program?.render === undefined) {
              throw new Error(`No pane "${id}" to open again: pass a view or a render to make it.`)
            }
            const { program: _program, error: _error, ...pane } = stored ?? newPane(id, title ?? id, checked ?? h('Box', {}))
            const next: CodemodePane = {
              ...pane,
              ...(isDefined ? (program === undefined ? {} : { program }) : stored?.program === undefined ? {} : { program: stored.program }),
              ...(!isDefined && stored?.error !== undefined ? { error: stored.error } : {}),
              title: title ?? pane.title,
              ...(ask !== undefined ? { ask } : {}),
              view: checked ?? pane.view,
              values: newValues === undefined ? pane.values : { ...pane.values, ...newValues },
              data: newData === undefined ? pane.data : { ...pane.data, ...newData },
              isOpen: true,
              updatedAt: Date.now(),
            }
            shownTitle = next.title
            tryRender('ui.open()', next)
            return checkSize(next)
          }),
        )
        let shownView: CodemodeNode | undefined
        await run.track(async () => {
          const pane = await host.get(id)
          if (pane !== null) shownView = viewOf(pane, { surface: 'terminal', columns: 60 }).view
        })
        const [shown, drawing] = await Promise.all([run.track(() => host.show(id, shownTitle, focus === true)), run.track(() => host.drawing())])
        const fallbacks = shownView === undefined ? [] : fallbacksOf(shownView, drawing.surfaces, drawing.pixels)
        return fallbacks.length > 0 ? { ...shown, fallbacks } : shown
      })
    },
    update: async (id: unknown, changes: unknown) => {
      run.check()
      const paneId = checkPaneId(id)
      if (typeof changes !== 'object' || changes === null || Array.isArray(changes)) throw new TypeError('ui.update() changes must be an object.')
      const { title, ask, view, values, data, render, on, every } = changes as Record<string, unknown>
      if (ask !== undefined && typeof ask !== 'string') throw new TypeError('ui.update(): ask must be a string.')
      const checked = view === undefined ? undefined : checkView(view)
      const newValues = values === undefined ? undefined : toObject(values, 'values')
      const newData = data === undefined ? undefined : toObject(data, 'data')
      if (title !== undefined && typeof title !== 'string') throw new TypeError('ui.update(): title must be a string.')
      const isReprogrammed = render !== undefined || on !== undefined || every !== undefined
      await changeOf(paneId, stored => {
        const { program: _program, error: _error, ...pane } = stored
        const program = isReprogrammed ? programOf('ui.update()', { render, on, every }, stored.program) : stored.program
        const next: CodemodePane = {
          ...pane,
          ...(program === undefined ? {} : { program }),
          // A new program starts clean.
          ...(!isReprogrammed && stored.error !== undefined ? { error: stored.error } : {}),
          title: (title as string | undefined) ?? pane.title,
          ...(ask !== undefined ? { ask: ask as string } : {}),
          view: checked ?? pane.view,
          values: newValues === undefined ? pane.values : { ...pane.values, ...newValues },
          data: newData === undefined ? pane.data : { ...pane.data, ...newData },
        }
        tryRender('ui.update()', next)
        return next
      })
      if (title !== undefined) {
        const pane = await exists(paneId)
        if (pane.isOpen) await run.track(() => host.show(paneId, title, false))
      }
    },
    set: (id: unknown, path: unknown, value: unknown) => {
      run.check()
      const paneId = checkPaneId(id)
      const at = pathOf(path)
      const json = toJson(value, 'ui.set() value')
      return changeOf(paneId, pane => setAt(pane, at, json))
    },
    append: (id: unknown, path: unknown, items: unknown, options?: { max?: unknown }) => {
      run.check()
      const paneId = checkPaneId(id)
      const at = pathOf(path)
      const json = toJson(items, 'ui.append() items')
      const max = options?.max === undefined ? DEFAULT_APPEND_MAX : Number(options.max)
      if (!Number.isFinite(max) || max < 1) throw new TypeError('ui.append(): max must be a positive number.')
      return changeOf(paneId, pane => appendAt(pane, at, Array.isArray(json) ? json : [json], max))
    },
    get: async (id: unknown) => {
      run.check()
      const paneId = checkPaneId(id)
      const pane = await run.track(() => host.get(paneId))
      if (pane === null) return undefined
      const renderError = host.renderError?.(paneId)
      return renderError === undefined ? structuredClone(pane) : { ...structuredClone(pane), renderError }
    },
    panes: async () => {
      run.check()
      const [ids, placed] = await Promise.all([run.track(() => host.ids()), run.track(() => host.placed())])
      const panes = await Promise.all(ids.map(id => run.track(() => host.get(id))))
      return panes
        .filter((pane): pane is CodemodePane => pane !== null)
        .map(pane => ({
          id: pane.id,
          title: pane.title,
          isOpen: pane.isOpen,
          isPlaced: placed.get(pane.id) ?? false,
          unread: pane.inbox.length,
          follows: (pane.follows ?? []).map(follow => ({ to: follow.to, file: follow.file, state: followState(follow) })),
        }))
    },
    take: async (id: unknown) => {
      run.check()
      const paneId = checkPaneId(id)
      await exists(paneId)
      return take(paneId)
    },
    wait: async (id: unknown, options?: { timeoutMs?: unknown }) => {
      run.check()
      const paneId = checkPaneId(id)
      await exists(paneId)
      const timeoutMs = options?.timeoutMs === undefined ? DEFAULT_WAIT_MS : Number(options.timeoutMs)
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_MS) {
        throw new TypeError(`ui.wait(): timeoutMs is at most ${MAX_WAIT_MS}. For an answer the person needs time over, give the pane a push: "wake" button and end your turn instead.`)
      }
      return run.recorded('ui.wait', paneId, async () => {
        // On the engine's clock, so the deadline holds however long each wait for an event takes.
        let isTimedOut = false
        const timeout = run.sleep(timeoutMs).then(() => {
          isTimedOut = true
        })
        timeout.catch(() => {})
        while (true) {
          const taken = await take(paneId)
          if (taken.length > 0) return taken
          if (isTimedOut) return []
          const stop = new AbortController()
          const onEnd = () => stop.abort()
          run.signal.addEventListener('abort', onEnd, { once: true })
          try {
            await run.track(() => Promise.race([host.nextEvent(paneId, stop.signal), timeout]))
          } finally {
            run.signal.removeEventListener('abort', onEnd)
            stop.abort()
          }
          run.check()
        }
      })
    },
    follow: async (id: unknown, file: unknown, options?: unknown) => {
      run.check()
      const paneId = checkPaneId(id)
      if (typeof file !== 'string') throw new TypeError("ui.follow(): file is the task's output file, as Bash's run_in_background result names it.")
      const { at, keep, status, fromEnd } = followOptions('ui.follow()', options)
      await stopStreams(await exists(paneId), at)
      return run.recorded('ui.follow', `${paneId} ${file}`, () =>
        run.track(() => host.follow(paneId, { file, to: at, max: keep, ...(status !== undefined ? { status } : {}), fromEnd })),
      )
    },
    stream: async (id: unknown, command: unknown, options?: unknown) => {
      run.check()
      const paneId = checkPaneId(id)
      if (typeof command !== 'string' || command.trim() === '') throw new TypeError('ui.stream(): command is the shell command to run, as a string.')
      const { at, keep, status, description, timeout } = followOptions('ui.stream()', options)
      if (run.background === undefined) throw new Error('ui.stream() needs the Bash tool, which this session does not have.')
      // A stream already at this path is replaced, its command stopped.
      await stopStreams(await exists(paneId), at)
      const { taskId, file } = await run.background(command, description, timeout)
      const followed = await run.recorded('ui.stream', `${paneId} ${command}`, () =>
        run.track(() => host.follow(paneId, { file, to: at, max: keep, ...(status !== undefined ? { status } : {}), fromEnd: false, task: taskId })),
      )
      return { ...followed, task: taskId, file }
    },
    unfollow: async (id: unknown, to?: unknown) => {
      run.check()
      const paneId = checkPaneId(id)
      const at = to === undefined ? undefined : pathOf(to)
      const pane = await exists(paneId)
      const stopped = await run.track(() => host.unfollow(paneId, at))
      await stopStreams(pane, at)
      return stopped
    },
    close: async (id: unknown) => {
      run.check()
      const paneId = checkPaneId(id)
      await changeOf(paneId, pane => ({ ...pane, isOpen: false }))
      await run.track(() => host.hide(paneId))
    },
    remove: async (id: unknown) => {
      run.check()
      const paneId = checkPaneId(id)
      const pane = await run.track(() => host.get(paneId))
      await run.track(() => host.change(paneId, () => null))
      if (pane !== null) await stopStreams(pane)
      await run.track(() => host.hide(paneId))
    },
  }
}
