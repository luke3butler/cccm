// The changes made to a parsed script or pane program before it runs: tick calls that let a busy one be
// stopped, line markers that let an error name its line, the source text a function prints as, and
// hyphenated tool names read as names rather than subtractions.

import type { SvalNode } from './vendor/sval.js'

export const TICK = '__codemode_tick'
export const AT = '__codemode_at'

/**
 * Puts a `__codemode_tick()` call at the top of every loop body and function body, so a busy script
 * can be stopped, and a `__codemode_at(line)` call before every statement, so an error names its line.
 */
export function guard(node: unknown): void {
  if (node === null || typeof node !== 'object') return
  const current = node as SvalNode
  for (const value of Object.values(current)) {
    if (Array.isArray(value)) value.forEach(guard)
    else guard(value)
  }
  if (typeof current.type !== 'string') return
  if (current.type === 'Program' || current.type === 'BlockStatement' || current.type === 'StaticBlock') {
    current.body = markLines(current.body as SvalNode[])
  } else if (current.type === 'SwitchCase') {
    current.consequent = markLines(current.consequent as SvalNode[])
  }
  if (/^(While|DoWhile|For|ForIn|ForOf)Statement$/.test(current.type)) {
    current.body = { type: 'BlockStatement', body: [tickStatement(), current.body] }
  } else if (/^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(current.type)) {
    const body = current.body as SvalNode
    if (body.type === 'BlockStatement') {
      ;(body.body as SvalNode[]).unshift(tickStatement())
    } else {
      current.body = { type: 'BlockStatement', body: [tickStatement(), { type: 'ReturnStatement', argument: body }] }
      current.expression = false
    }
  }
}

function markLines(statements: SvalNode[]): SvalNode[] {
  return statements.flatMap(statement => {
    const at = (statement.loc as { start?: { line?: number } } | undefined)?.start?.line
    return at === undefined ? [statement] : [callStatement(AT, [{ type: 'Literal', value: at }]), statement]
  })
}

function tickStatement(): SvalNode {
  return callStatement(TICK, [])
}

function callStatement(name: string, args: SvalNode[]): SvalNode {
  return {
    type: 'ExpressionStatement',
    expression: { type: 'CallExpression', callee: { type: 'Identifier', name }, arguments: args, optional: false },
  }
}

/**
 * Turns `tools.a-b(x)`, which parses as `tools.a - b(x)`, into `tools["a-b"](x)` when `a-b` is a tool's
 * name; `await`, more hyphens and a chain after the call (`.then(f)`) are kept. Nothing else changes:
 * subtracting from a tool is never meant.
 */
export function joinToolNames(node: unknown, isTool: (name: string) => boolean): void {
  if (node === null || typeof node !== 'object') return
  const current = node as SvalNode
  if (current.type === 'BinaryExpression' && current.operator === '-') {
    const joined = joinedCall(current, isTool)
    if (joined !== undefined) {
      for (const key of Object.keys(current)) if (key !== 'loc') delete current[key]
      Object.assign(current, joined)
    }
  }
  for (const value of Object.values(current)) {
    if (Array.isArray(value)) value.forEach(item => joinToolNames(item, isTool))
    else joinToolNames(value, isTool)
  }
}

/** What `tools.a - b - c(x)` becomes when `a-b-c` is a tool, or undefined. */
function joinedCall(node: SvalNode, isTool: (name: string) => boolean): SvalNode | undefined {
  const right = node.right as SvalNode
  const start = chainStart(right)
  if (start === undefined) return undefined
  // tools.a - b - c(x) is (tools.a - b) - c(x): the words between the first and last minus are on the left.
  const words = [start.name]
  let left = node.left as SvalNode
  while (left.type === 'BinaryExpression' && left.operator === '-' && (left.right as SvalNode).type === 'Identifier') {
    words.unshift((left.right as SvalNode).name as string)
    left = left.left as SvalNode
  }
  const awaited = left.type === 'AwaitExpression'
  const first = (awaited ? left.argument : left) as SvalNode
  const object = first.object as SvalNode | undefined
  const property = first.property as SvalNode | undefined
  if (first.type !== 'MemberExpression' || first.computed || first.optional) return undefined
  if (object?.type !== 'Identifier' || object.name !== 'tools' || property?.type !== 'Identifier') return undefined
  const name = [property.name as string, ...words].join('-')
  if (!isTool(name)) return undefined
  const tool: SvalNode = {
    type: 'MemberExpression',
    object: { type: 'Identifier', name: 'tools' },
    property: { type: 'Literal', value: name },
    computed: true,
    optional: false,
  }
  if (start.holder !== undefined) start.holder[start.key] = tool
  const call = start.holder === undefined ? tool : right
  return awaited ? { type: 'AwaitExpression', argument: call } : call
}

/** The word a call or member chain starts from, and the node holding it: `b` in `b(x).then(f)`. */
function chainStart(node: SvalNode): { name: string; holder?: SvalNode; key: string } | undefined {
  let holder: SvalNode | undefined
  let key = ''
  let at = node
  for (;;) {
    const next = at.type === 'CallExpression' ? 'callee' : at.type === 'MemberExpression' ? 'object' : at.type === 'ChainExpression' ? 'expression' : undefined
    if (next === undefined) break
    holder = at
    key = next
    at = at[next] as SvalNode
  }
  return at.type === 'Identifier' ? { name: at.name as string, holder, key } : undefined
}

/**
 * Gives every function in `ast` the source it was parsed from, so `String(fn)` prints its text: the
 * parser's `sourceFile` option would do the same, but it also puts the whole source in every syntax error.
 */
export function keepSources(node: unknown, code: string): void {
  if (node === null || typeof node !== 'object') return
  const current = node as SvalNode
  for (const value of Object.values(current)) {
    if (Array.isArray(value)) value.forEach(item => keepSources(item, code))
    else if (value !== null && typeof value === 'object') keepSources(value, code)
  }
  if (typeof current.type === 'string' && /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(current.type)) {
    const loc = current.loc as { source?: string } | undefined
    if (loc !== undefined) loc.source = code
  }
}
