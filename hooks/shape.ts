// A value's outline as a TypeScript-like type, for a script's `shape()` and a failed script's call list:
// `{ data: { page: number; results: { id: string; tags?: string[] }[] } }`. An array's items merge into
// one type, a key some items lack marked `?`, differing types joined with `|`.

/** Items of an array read before its type is printed. */
const ITEMS_READ = 100
/** Keys of an object printed before the rest are counted. */
const KEYS_SHOWN = 25
/** Nesting printed before `{…}` stands for the rest. */
const DEPTH_SHOWN = 8

/** What the values seen at one place had: their primitive types, and their objects and arrays merged. */
type Node = {
  types: Set<string>
  /** Each key, with the merged values under it and how many objects had it. */
  keys?: Map<string, { node: Node; count: number }>
  objects: number
  /** The merged items of every array seen here; undefined while all were empty. */
  items?: Node
  arrays: number
}

const emptyNode = (): Node => ({ types: new Set(), objects: 0, arrays: 0 })

/** The outline of `value`; `maxChars` cuts it, ending in `…`. */
export function shape(value: unknown, maxChars = Infinity): string {
  const node = emptyNode()
  add(node, value, 0)
  const text = print(node, 0)
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1))}…` : text
}

function add(node: Node, value: unknown, depth: number): void {
  if (value === null) node.types.add('null')
  else if (Array.isArray(value)) {
    node.arrays += 1
    if (depth >= DEPTH_SHOWN) return
    for (const item of value.slice(0, ITEMS_READ)) add((node.items ??= emptyNode()), item, depth + 1)
  } else if (typeof value === 'object') {
    node.objects += 1
    node.keys ??= new Map()
    if (depth >= DEPTH_SHOWN) return
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const entry = node.keys.get(key) ?? { node: emptyNode(), count: 0 }
      entry.count += 1
      add(entry.node, item, depth + 1)
      node.keys.set(key, entry)
    }
  } else node.types.add(typeof value)
}

function print(node: Node, depth: number): string {
  const parts = printParts(node, depth)
  return parts.length === 0 ? 'unknown' : parts.join(' | ')
}

/** The types `node` held, each printed; more than one is a union. */
function printParts(node: Node, depth: number): string[] {
  const parts = [...node.types]
  if (node.objects > 0) parts.push(depth >= DEPTH_SHOWN ? '{…}' : printObject(node, depth))
  if (node.arrays > 0) {
    if (node.items === undefined) parts.push(depth >= DEPTH_SHOWN ? '[…]' : '[]')
    else {
      const items = printParts(node.items, depth + 1)
      parts.push(items.length === 1 ? `${items[0]}[]` : `(${items.join(' | ')})[]`)
    }
  }
  return parts
}

function printObject(node: Node, depth: number): string {
  const entries = [...node.keys!]
  if (entries.length === 0) return '{}'
  const fields = entries.slice(0, KEYS_SHOWN).map(([key, entry]) => {
    const name = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)
    return `${name}${entry.count < node.objects ? '?' : ''}: ${print(entry.node, depth + 1)}`
  })
  if (entries.length > KEYS_SHOWN) fields.push(`… ${entries.length - KEYS_SHOWN} more`)
  return `{ ${fields.join('; ')} }`
}
