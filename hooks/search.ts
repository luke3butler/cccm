// BM25 ranking of tools by name and description, for a script's `searchTools()`.

export type ToolEntry = { name: string; description: string }

const K1 = 1.2
const B = 0.75

/** Lowercase word pieces: `mcp__claude_ai_Gmail__create_draft` gives mcp, claude, ai, gmail, create, draft. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length > 1)
}

/** A tool's MCP server as its name spells it (`mcp__dev_radius__search` gives `dev_radius`), or undefined for a built-in. */
export function namespaceOf(name: string): string | undefined {
  const match = /^mcp__(.+?)__/.exec(name)
  return match?.[1]
}

/** `mcp__dev-radius`, `mcp__dev_radius`, `dev-radius` and `dev_radius` all name the same server. */
export function normalizeNamespace(name: string): string {
  return name
    .replace(/^mcp__/, '')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .toLowerCase()
}

export function rankTools(
  tools: readonly ToolEntry[],
  query: string,
  options: { limit?: number; namespace?: string } = {},
): ToolEntry[] {
  const limit = options.limit ?? 8
  const wanted = options.namespace === undefined ? undefined : normalizeNamespace(options.namespace)
  const pool = tools.filter(tool => {
    if (wanted === undefined) return true
    const namespace = namespaceOf(tool.name)
    return namespace !== undefined && normalizeNamespace(namespace) === wanted
  })
  const terms = [...new Set(tokenize(query))]
  if (terms.length === 0) return pool.slice(0, limit)

  // The name counts twice: a tool named for the query beats one that mentions it.
  const docs = pool.map(tool => {
    const words = [...tokenize(tool.name), ...tokenize(tool.name), ...tokenize(tool.description)]
    const counts = new Map<string, number>()
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1)
    return { tool, counts, length: words.length }
  })
  const averageLength = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length)
  const idf = new Map(
    terms.map(term => {
      const holding = docs.filter(doc => doc.counts.has(term)).length
      return [term, Math.log(1 + (docs.length - holding + 0.5) / (holding + 0.5))] as const
    }),
  )

  return docs
    .map(doc => {
      let score = 0
      for (const term of terms) {
        const count = doc.counts.get(term) ?? 0
        if (count === 0) continue
        score +=
          (idf.get(term) ?? 0) * ((count * (K1 + 1)) / (count + K1 * (1 - B + (B * doc.length) / averageLength)))
      }
      return { tool: doc.tool, score }
    })
    .filter(ranked => ranked.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(ranked => ranked.tool)
}
