// Reads tool input types out of the declaration files the engine lays beside the
// plugin: `.claude-plugin/types/claude-code-tools/index.d.ts` (BuiltinToolInputs)
// and `.claude-plugin/types/claude-code-mcp/index.d.ts` (McpToolInputs, the MCP
// tools connected when the plugin last loaded).

/** The declaration files, relative to the plugin folder, and the interface each declares inputs in. */
const DECLARATION_FILES = [
  { path: '.claude-plugin/types/claude-code-tools/index.d.ts', name: 'BuiltinToolInputs' },
  { path: '.claude-plugin/types/claude-code-mcp/index.d.ts', name: 'McpToolInputs' },
] as const

/** Built-in tools whose inputs the tool description lists, so a script calls them without describeTool(). */
const INLINE_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch']

/** Every tool's input type, by tool name, from the files laid in `root`; a file not laid yet is skipped. */
export async function loadDeclarations(root: string, read: (path: string) => Promise<string>): Promise<Map<string, string>> {
  const merged = new Map<string, string>()
  for (const file of DECLARATION_FILES) {
    try {
      for (const entry of parseDeclarations(await read(`${root}/${file.path}`), file.name)) merged.set(...entry)
    } catch {
      // Not laid yet (a first load) or unreadable.
    }
  }
  return merged
}

/** The tool description's list of common built-in tools' inputs, without doc comments; empty when none are declared. */
export function inlineDeclarations(declarations: Map<string, string>, available?: Set<string>): string {
  const lines = INLINE_TOOLS.filter(name => available === undefined || available.has(name)).flatMap(name => {
    const declaration = declarations.get(name)
    return declaration === undefined ? [] : [`- tools.${name}(${compactDeclaration(declaration)})`]
  })
  return lines.length === 0 ? '' : `\n\nInputs of common built-in tools (describeTool() has their doc comments, and every other tool's):\n${lines.join('\n')}`
}

/** A declaration on one line, its doc comments dropped: `{ command: string; timeout?: number }`. */
export function compactDeclaration(declaration: string): string {
  return declaration
    .replace(/\/\*\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('; ')
    .replace(/\{; /g, '{ ')
    .replace(/; \}/g, ' }')
    .replace(/[;,]; /g, '; ')
}

/** Each tool's input type, by tool name, from one interface of a declaration file. */
export function parseDeclarations(source: string, interfaceName: string): Map<string, string> {
  const declarations = new Map<string, string>()
  const lines = source.split('\n')
  const start = lines.findIndex(line => line.trim() === `interface ${interfaceName} {`)
  if (start === -1) return declarations

  // Entries sit at four spaces of indent, and their bodies close at four spaces too.
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.startsWith('  }')) break
    const entry = /^ {4}(?:"([^"]+)"|([A-Za-z_$][\w$-]*))\??: (.*)$/.exec(line)
    if (entry === null) continue
    const name = entry[1] ?? entry[2]!
    const rest = entry[3]!
    if (rest !== '{') {
      declarations.set(name, rest)
      continue
    }
    const body: string[] = ['{']
    for (i += 1; i < lines.length && lines[i] !== '    }'; i++) body.push(lines[i]!.slice(4))
    body.push('}')
    declarations.set(name, body.join('\n'))
  }
  return declarations
}
