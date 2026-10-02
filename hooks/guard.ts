// The changes made to a parsed script or pane program before it runs: tick calls that let a busy one be
// stopped, line markers that let an error name its line, and the source text a function prints as.

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
