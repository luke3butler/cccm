// Saved scripts: files written once and run by name, by the model (the tool's `name` and `args`) or by the
// person (/codemode <name>). A project's are in <root>/.claude/codemode, the person's own in
// ~/.claude/codemode; a project's wins a name both have. Nothing here calls the engine.

import type { CodemodeJson } from '../types'

import Sval from './vendor/sval.js'

/** Where saved scripts are, under a project root and under the home directory. */
export const SAVED_DIR = '.claude/codemode'
/** A saved script's name, which is its file's name without `.js`. */
export const SAVED_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
/** Files one listing reads in each folder. */
const MAX_SAVED = 100
/** A meta description's length, and how much of it the tool's listing shows. */
const MAX_DESCRIPTION = 1000
const LISTED_DESCRIPTION = 200
const ARG_TYPES = ['string', 'number', 'boolean', 'object', 'array'] as const

export type ArgType = (typeof ARG_TYPES)[number]
export type ArgSpec = { type: ArgType; description?: string; default?: CodemodeJson; required?: boolean }
export type SavedMeta = { description?: string; args?: Record<string, ArgSpec> }
export type SavedScope = 'project' | 'personal'
export type SavedPlace = { scope: SavedScope; dir: string }

/** One saved script: its name, where it is, its meta, and the source to run. */
export type SavedScript = { name: string; scope: SavedScope; path: string; meta: SavedMeta; script: string }
/** A listing's row: a script that parsed, or one that did not and why. */
export type SavedEntry = { name: string; scope: SavedScope; path: string; description?: string; args?: Record<string, ArgSpec>; error?: string }

/** The file system a listing needs; register.tsx makes the `$` calls. */
export type SavedFs = {
  /** The names of the files in `dir`, or undefined when there is no such folder. */
  list: (dir: string) => Promise<string[] | undefined>
  read: (path: string) => Promise<string>
}

/** The folders saved scripts are in, the project's first. */
export function savedPlaces(projectDir: string | undefined, home: string | undefined): SavedPlace[] {
  const places: SavedPlace[] = []
  if (projectDir) places.push({ scope: 'project', dir: `${projectDir.replace(/\/$/, '')}/${SAVED_DIR}` })
  if (home) {
    const dir = `${home.replace(/\/$/, '')}/${SAVED_DIR}`
    if (!places.some(place => place.dir === dir)) places.push({ scope: 'personal', dir })
  }
  return places
}

/** Every saved script in `places`, by name; a name in an earlier place hides the same name in a later one. */
export async function listSaved(fs: SavedFs, places: SavedPlace[]): Promise<SavedEntry[]> {
  const byName = new Map<string, SavedEntry>()
  for (const place of places) {
    const names = ((await fs.list(place.dir).catch(() => undefined)) ?? [])
      .filter(file => file.endsWith('.js') && SAVED_NAME.test(file.slice(0, -3)))
      .sort()
      .slice(0, MAX_SAVED)
    const entries = await Promise.all(
      names.map(async (file): Promise<SavedEntry> => {
        const name = file.slice(0, -3)
        const path = `${place.dir}/${file}`
        try {
          const { meta } = parseSaved(await fs.read(path), name)
          return { name, scope: place.scope, path, description: meta.description, args: meta.args }
        } catch (thrown) {
          return { name, scope: place.scope, path, error: thrown instanceof Error ? thrown.message : String(thrown) }
        }
      }),
    )
    for (const entry of entries) if (!byName.has(entry.name)) byName.set(entry.name, entry)
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** The saved script `name`, parsed; undefined when no place has it. Throws when its file does not parse. */
export async function findSaved(fs: SavedFs, places: SavedPlace[], name: string): Promise<SavedScript | undefined> {
  if (!SAVED_NAME.test(name)) throw new TypeError(`"${name}" is not a saved script's name: letters, digits, - and _, starting with a letter or digit.`)
  for (const place of places) {
    const path = `${place.dir}/${name}.js`
    let source: string
    try {
      source = await fs.read(path)
    } catch {
      continue
    }
    return { name, scope: place.scope, path, ...parseSaved(source, name) }
  }
  return undefined
}

/**
 * A saved script's meta and the source to run. The meta is an optional `export const meta = { ... }` of
 * plain literals before any other statement (comments, and the // @options: line, may come first); it
 * stays in the source as `const meta`, so the script can read it, and lines keep their numbers.
 */
export function parseSaved(source: string, name: string): { meta: SavedMeta; script: string } {
  const at = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*export(?=\s+const\s+meta\s*=)/.exec(source)
  if (at === null) {
    if (/^\s*export\s/m.test(source)) throw new SyntaxError(`${name}.js: the only export a saved script has is \`export const meta = { ... }\`, before its other statements.`)
    return { meta: {}, script: source }
  }
  const script = source.slice(0, at[0].length - 'export'.length) + '      ' + source.slice(at[0].length)
  let ast: { body: Array<{ expression?: { body?: { body?: unknown[] } } }> }
  try {
    ast = new Sval({ ecmaVer: 'latest', sandBox: true }).parse(`(async function () {${script}\n})`) as unknown as typeof ast
  } catch (thrown) {
    throw new SyntaxError(`${name}.js does not parse: ${thrown instanceof Error ? thrown.message : String(thrown)}`)
  }
  const first = ast.body[0]?.expression?.body?.body?.[0] as
    | { type: string; declarations?: Array<{ id: { type: string; name?: string }; init: unknown }> }
    | undefined
  const declared = first?.type === 'VariableDeclaration' ? first.declarations?.[0] : undefined
  if (declared === undefined || declared.id.name !== 'meta') throw new SyntaxError(`${name}.js: meta must be declared alone, as its first statement.`)
  return { meta: metaOf(literalOf(declared.init, 'meta'), name), script }
}

/** A literal's value: strings, numbers, booleans, null, and arrays and objects of them. */
function literalOf(node: unknown, where: string): CodemodeJson {
  const n = node as {
    type: string
    value?: unknown
    regex?: unknown
    operator?: string
    argument?: { type: string; value?: unknown }
    expressions?: unknown[]
    quasis?: Array<{ value: { cooked: string } }>
    elements?: unknown[]
    properties?: Array<{ type: string; computed?: boolean; kind?: string; method?: boolean; key: { type: string; name?: string; value?: unknown }; value: unknown }>
  }
  switch (n.type) {
    case 'Literal':
      if (n.regex === undefined && (n.value === null || ['string', 'number', 'boolean'].includes(typeof n.value))) return n.value as CodemodeJson
      break
    case 'TemplateLiteral':
      if (n.expressions?.length === 0) return n.quasis![0]!.value.cooked
      break
    case 'UnaryExpression':
      if (n.operator === '-' && n.argument?.type === 'Literal' && typeof n.argument.value === 'number') return -n.argument.value
      break
    case 'ArrayExpression':
      return n.elements!.map((element, i) => {
        if (element === null) throw new SyntaxError(`${where}[${i}] is a hole; meta is plain literals.`)
        return literalOf(element, `${where}[${i}]`)
      })
    case 'ObjectExpression': {
      const out: Record<string, CodemodeJson> = {}
      for (const property of n.properties!) {
        const key = property.key.type === 'Identifier' ? property.key.name : typeof property.key.value === 'string' ? property.key.value : undefined
        if (property.type !== 'Property' || property.computed || property.kind !== 'init' || property.method || key === undefined) {
          throw new SyntaxError(`${where} has a property that is not \`name: literal\`; meta is plain literals.`)
        }
        out[key] = literalOf(property.value, `${where}.${key}`)
      }
      return out
    }
  }
  throw new SyntaxError(`${where} is not a plain literal (a string, number, boolean, null, array or object of them).`)
}

/** The meta checked: a description, and args each a type name or `{ type, description?, default?, required? }`. */
function metaOf(value: CodemodeJson, name: string): SavedMeta {
  const fail = (why: string): never => {
    throw new TypeError(`${name}.js: ${why}`)
  }
  if (!isPlain(value)) return fail('meta is an object.')
  const meta: SavedMeta = {}
  for (const key of Object.keys(value)) if (key !== 'description' && key !== 'args') fail(`meta takes description and args, not ${key}.`)
  if (value.description !== undefined) {
    if (typeof value.description !== 'string') fail('meta.description is a string.')
    meta.description = (value.description as string).slice(0, MAX_DESCRIPTION)
  }
  if (value.args !== undefined) {
    if (!isPlain(value.args)) return fail('meta.args is an object of { name: type or spec }.')
    meta.args = {}
    for (const [arg, given] of Object.entries(value.args)) {
      const spec = (typeof given === 'string' ? { type: given } : given) as Record<string, CodemodeJson>
      if (!isPlain(spec) || !ARG_TYPES.includes(spec.type as ArgType)) fail(`meta.args.${arg}'s type is one of ${ARG_TYPES.join(', ')}.`)
      for (const key of Object.keys(spec)) if (!['type', 'description', 'default', 'required'].includes(key)) fail(`meta.args.${arg} takes type, description, default and required, not ${key}.`)
      if (spec.description !== undefined && typeof spec.description !== 'string') fail(`meta.args.${arg}.description is a string.`)
      if (spec.required !== undefined && typeof spec.required !== 'boolean') fail(`meta.args.${arg}.required is true or false.`)
      if (spec.default !== undefined && !isType(spec.default, spec.type as ArgType)) fail(`meta.args.${arg}.default is not a ${spec.type as string}.`)
      meta.args[arg] = spec as unknown as ArgSpec
    }
  }
  return meta
}

/**
 * The `args` a saved script reads: `given` checked against its meta, with the defaults. A script without
 * meta.args takes any JSON object.
 */
export function argsOf(meta: SavedMeta, given: unknown, name: string): Record<string, CodemodeJson> {
  if (given === undefined || given === null) given = {}
  if (!isPlain(given as CodemodeJson)) throw new TypeError(`${name}'s args are an object.`)
  const values = given as Record<string, CodemodeJson>
  if (meta.args === undefined) return { ...values }
  const known = Object.keys(meta.args)
  for (const key of Object.keys(values)) {
    if (!(key in meta.args)) throw new TypeError(known.length === 0 ? `${name} takes no args.` : `${name} has no arg "${key}"; its args are ${known.join(', ')}.`)
  }
  const out: Record<string, CodemodeJson> = {}
  for (const [arg, spec] of Object.entries(meta.args)) {
    const value = values[arg] ?? spec.default
    if (value === undefined) {
      if (spec.required) throw new TypeError(`${name} needs the arg "${arg}" (${spec.type}${spec.description ? `: ${spec.description}` : ''}).`)
      continue
    }
    if (!isType(value, spec.type)) throw new TypeError(`${name}'s arg "${arg}" is a ${spec.type}, not ${JSON.stringify(value).slice(0, 80)}.`)
    out[arg] = value
  }
  return out
}

/**
 * Args as the person types them after /codemode <name>: a JSON object, or words, each `key=value` or a
 * value for the next arg in meta's order. A value reads as its arg's type: a number, true or false, JSON
 * for an object or array; quotes keep spaces in one.
 */
export function commandArgs(meta: SavedMeta, text: string, name: string): Record<string, CodemodeJson> {
  const trimmed = text.trim()
  if (trimmed === '') return {}
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as Record<string, CodemodeJson>
    } catch (thrown) {
      throw new SyntaxError(`${name}'s args are not JSON (${thrown instanceof Error ? thrown.message : String(thrown)}).`)
    }
  }
  const order = Object.keys(meta.args ?? {})
  const out: Record<string, CodemodeJson> = {}
  for (const word of wordsOf(trimmed)) {
    const pair = /^([A-Za-z_$][\w$]*)=([\s\S]*)$/.exec(word)
    const key = pair !== null && (meta.args === undefined || pair[1]! in meta.args) ? pair[1]! : order.find(arg => !(arg in out))
    if (key === undefined) {
      throw new TypeError(order.length === 0 ? `${name} takes no args, or takes them as key=value.` : `${name} takes ${order.length} args (${order.join(', ')}); "${word}" is one more.`)
    }
    out[key] = valueOf(pair !== null && key === pair[1] ? pair[2]! : word, meta.args?.[key]?.type)
  }
  return out
}

/** A typed word as its arg's type; without one, JSON when it parses, else the text. */
function valueOf(word: string, type: ArgType | undefined): CodemodeJson {
  if (type === 'string') return word
  if (type === 'number') {
    const number = Number(word)
    return word.trim() !== '' && Number.isFinite(number) ? number : word
  }
  if (type === 'boolean') return ({ true: true, yes: true, false: false, no: false } as Record<string, boolean>)[word.toLowerCase()] ?? word
  try {
    return JSON.parse(word) as CodemodeJson
  } catch {
    return word
  }
}

/**
 * Words split on spaces, a quoted run ("..." or '...') kept whole. A word, or a key=value's value, that is
 * all one quoted run loses its quotes; quotes inside one (tags=["x"]) stay, for JSON.
 */
function wordsOf(text: string): string[] {
  const words: string[] = []
  for (const match of text.matchAll(/(?:[^\s"']+|"(?:[^"\\]|\\.)*"|'[^']*')+/g)) {
    const quoted = /^([A-Za-z_$][\w$]*=)?(?:"((?:[^"\\]|\\.)*)"|'([^']*)')$/.exec(match[0])
    words.push(quoted === null ? match[0] : (quoted[1] ?? '') + (quoted[2] !== undefined ? quoted[2].replace(/\\(.)/g, '$1') : quoted[3]!))
  }
  return words
}

/** The listing the tool's `name` parameter carries: each script, its args and what it does. */
export function savedListing(entries: SavedEntry[]): string {
  const usable = entries.filter(entry => entry.error === undefined)
  if (usable.length === 0) return `None saved yet: save one as ${SAVED_DIR}/<name>.js under the project root, or ~/${SAVED_DIR}/<name>.js for every project. help("saved") has the file's shape.`
  return `Saved scripts:\n${usable
    .map(entry => {
      const args = entry.args === undefined ? '' : `(${Object.entries(entry.args).map(([arg, spec]) => `${arg}${spec.required ? '' : '?'}: ${spec.type}`).join(', ')})`
      const about = entry.description ? `: ${clip(entry.description, LISTED_DESCRIPTION)}` : ''
      return `- ${entry.name}${args}${about}`
    })
    .join('\n')}`
}

/** What /codemode with no name shows: each saved script and where it is, and those that don't parse. */
export function savedReport(entries: SavedEntry[], places: SavedPlace[]): string {
  if (entries.length === 0) return `No saved codemode scripts. Save one as <name>.js in ${places.map(place => place.dir).join(' or ')}.`
  return entries
    .map(entry => {
      if (entry.error !== undefined) return `${entry.name} (${entry.scope}): does not load: ${entry.error}`
      return `${entry.name} (${entry.scope})${entry.description ? ` — ${clip(entry.description, LISTED_DESCRIPTION)}` : ''}`
    })
    .join('\n')
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function isPlain(value: CodemodeJson | undefined): value is Record<string, CodemodeJson> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isType(value: CodemodeJson, type: ArgType): boolean {
  switch (type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isPlain(value)
    default:
      return typeof value === type
  }
}
