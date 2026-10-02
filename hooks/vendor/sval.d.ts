/** The part of sval's interface the runner uses. */
export default class Sval {
  constructor(options?: { ecmaVer?: number | 'latest'; sandBox?: boolean; sourceType?: 'script' | 'module' })
  /** Adds globals to the interpreter's scope (sval's `import`, renamed in the vendored copy). */
  importModule(globals: Record<string, unknown>): void
  parse(code: string): SvalNode
  run(ast: SvalNode): void
  exports: Record<string, unknown>
  /** Passed to the parser; `locations: true` puts `loc` on every node. */
  options: Record<string, unknown>
}

export type SvalNode = { type: string; [field: string]: unknown }
