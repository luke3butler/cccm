// Runs the codemode runner outside Claude Code, against a fake host: `bun scripts/smoke.ts`.
// A check that does not need `claude plugin test`, which runs only while hooks modules are on.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { compactDeclaration, inlineDeclarations, parseDeclarations } from '../hooks/declarations'
import { runScript, toolResult, type Host } from '../hooks/runner'
import { loadSessionStore, saveSessionStore, type KeyValue } from '../hooks/store'

const root = join(import.meta.dir, '..')
const typesDir = join(root, '.claude-plugin/types')
const declarations = new Map<string, string>()
for (const [file, name] of [['claude-code-tools/index.d.ts', 'BuiltinToolInputs'], ['claude-code-mcp/index.d.ts', 'McpToolInputs']] as const) {
  const path = join(typesDir, file)
  if (existsSync(path)) for (const entry of parseDeclarations(readFileSync(path, 'utf8'), name)) declarations.set(...entry)
}

let inFlight = 0
let maxInFlight = 0
const host: Host = {
  listTools: async () => [
    { name: 'Bash', description: 'Run a shell command.', mcp: false },
    { name: 'Read', description: 'Read a file.', mcp: false },
    { name: 'mcp__big__dump', description: 'A large MCP output.', mcp: true },
    { name: 'mcp__slow__wait', description: 'Never answers.', mcp: true },
  ],
  callTool: async input =>
    input.tool === 'Read'
      ? { result: { type: 'file_unchanged', file: { filePath: input.file_path } }, text: 'Wasted call — file unchanged since your last Read.' }
      : input.tool === 'mcp__slow__wait'
      ? new Promise(() => {})
      : input.tool === 'Bash'
      ? { result: { stdout: 'preview', stderr: '', persistedOutputPath: '/saved/bash.txt' }, text: '<persisted-output>\nOutput too large. Full output saved to: /saved/bash.txt\n\nPreview' }
      : { result: { content: [{ type: 'text', text: 'preview' }] }, text: '<persisted-output>\nOutput too large. Full output saved to: /saved/mcp.txt\n\nPreview' },
  loadStore: async () => ({}),
  complete: async request => {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise(resolve => setTimeout(resolve, 10))
    inFlight -= 1
    const usage = { input_tokens: 600, output_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    return request.prompt === 'overloaded'
      ? { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded_error', usage }
      : { isAnswered: true, text: `${request.model}: ${request.prompt}`, usage }
  },
  classify: async (text, labels) => labels[text.length % labels.length],
  sessionFacts: async () => ({ id: 'smoke', cwd: '/work/sub', projectDir: '/work', repo: { root: '/work', remote: null } }),
  saveStore: async () => {},
  saveOutput: async () => undefined,
  readFile: async path => (path === '/notes.md' ? 'one\ntwo\nthree\n' : `full ${path}`),
  declarationOf: async tool => declarations.get(tool.name),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new Error('aborted'))
      })
    }),
}
const ctx = { signal: new AbortController().signal, budget: { remainingMs: Infinity }, toolUseId: 'smoke' }

const checks: [string, string, string][] = [
  ['full Bash output', 'const b = await tools.Bash({ command: "x" })\nreturn b.result.stdout + "|" + b.fullOutputPath', 'full /saved/bash.txt|/saved/bash.txt'],
  ['full MCP output', 'const m = await tools.mcp__big__dump({})\nreturn m.content[0].text', 'full /saved/mcp.txt'],
  ['session facts', 'return [session.id, session.cwd, session.projectDir, session.repo.root].join(" ")', 'smoke /work/sub /work /work'],
  ['models.complete', 'return (await models.complete({ prompt: "hi" })).text', 'haiku: hi'],
  ['model calls in the header', 'await Promise.all([1, 2].map(n => models.complete({ prompt: String(n) })))', '0 tool calls, 2 model calls (2.0k tokens)'],
  ['models.complete without a reply rejects', 'await models.complete({ prompt: "overloaded" })', 'no reply (api-error 529 overloaded_error)'],
  ['models.complete checks its input', 'await models.complete({ prompt: "x", effort: "huge" })', 'effort is one of low'],
  ['models.classify', 'return await models.classify("abc", ["bug", "feature"])', 'feature'],
  ['models.classify checks its labels', 'await models.classify("abc", ["only"])', 'two or more labels'],
  ['an unchanged Read is read again', 'const r = await tools.Read({ file_path: "/notes.md", offset: 2, limit: 2 })\nreturn [r.text, r.result.file.startLine, r.result.file.totalLines]', '"2\\tone'.replace('one', 'two')],
  ['classify alone shows no token count', 'await models.classify("abc", ["bug", "feature"])\nreturn "done"', '0 tool calls, 1 model call\n'],
  ['a failed script lists its calls', 'await tools.Bash({ command: "x" })\nthrow new Error("boom")', 'Script error: Error: boom (near line 2)\nCalls the script made:\n  ok     Bash  x  '],
  ['MCP output still resolves', 'return (await tools.mcp__big__dump({})).isError === undefined', '\ntrue'],
  ['error line', 'const a = 1\n\nmissingVariable.boom', '(near line 3)'],
  ['template escapes', 'return `a\\nb`.length', '\n3'],
  ['busy loop', '// @options: {"timeout_ms": 50}\nwhile (true) {}', 'Timed out after 50 ms'],
  ['deadline mid-call', '// @options: {"timeout_ms": 50}\nawait tools.mcp__slow__wait({})', 'Timed out after 50 ms'],
  ['sleep', 'await sleep(20)\nawait Promise.all([sleep(5), sleep(10)])\nreturn "slept"', 'Script completed'],
  ['never settles', 'text("before")\nawait new Promise(() => {})', 'never settles'],
  ['never settles after a call', 'await tools.Bash({ command: "x" })\nawait new Promise(() => {})', 'never settles'],
  ['long microtask chain is not stuck', 'for (let i = 0; i < 2000; i++) await Promise.resolve(i)\nreturn "done"', 'Script completed'],
]
if (declarations.size > 0) checks.push(['Bash declaration', 'return (await describeTool("Bash")).declaration', 'command: string'])

let failed = 0
const report = (name: string, ok: boolean, detail: string) => {
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n${detail}`}`)
}
for (const [name, script, expected] of checks) {
  const started = performance.now()
  const { text: result } = await runScript(host, { script }, ctx)
  report(`${name} (${Math.round(performance.now() - started)} ms)`, result.includes(expected), result)
}

// Model calls queue past four in flight.
maxInFlight = 0
const queued = await runScript(host, { script: 'await Promise.all(Array.from({ length: 10 }, (_, i) => models.complete({ prompt: String(i) })))' }, ctx)
report('model calls queue past 4 in flight', maxInFlight === 4 && queued.text.includes('10 model calls'), `${maxInFlight} ${queued.text}`)

// image(): each shape it takes becomes one checked image; bad data fails the script.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAbklEQVR4nO3PwQkAMRADse2/qnSWKyIsxodg3saaO7Pa8vzdngcAAAAAAAAAAAAAAAAAAAAAAAAAAAD4I2BOefkHAOXlHwCUl38AUF7+AUB5+QcA5eUfAJSXfwBQXv4BQHn5BwDl5R8AlJd/8NYH1J34xNmXXPwAAAAASUVORK5CYII='
const pictures = await runScript(
  { ...host, callTool: async () => ({ result: { type: 'image', file: { base64: PNG, type: 'image/png', originalSize: 1 } }, text: '[image]' }) },
  { script: `const read = await tools.Bash({ command: "x" })\nimage(read)\nimage(read.result)\nimage({ type: "image", data: "${PNG}", mimeType: "image/png" })\nimage("data:image/png;base64,${PNG}")\nreturn "shown"` },
  ctx,
)
report('image shapes', pictures.images.length === 4 && pictures.images.every(i => i.mediaType === 'image/png') && pictures.text.includes('4 images'), pictures.text)
const blocks = toolResult(pictures)
report('image blocks', Array.isArray(blocks) && blocks[1]?.type === 'image' && (blocks[1] as { source: { media_type: string } }).source.media_type === 'image/png', JSON.stringify(blocks).slice(0, 200))
for (const [name, script, expected] of [
  ['image rejects a remote URL', 'image("https://example.com/a.png")', 'remote URLs'],
  ['image rejects bad base64', 'image("data:image/png;base64,iVBORw0KGg!")', 'not valid base64'],
  ['image rejects other formats', 'image("data:image/png;base64,SGVsbG8gd29ybGQh")', 'not a PNG'],
] as const) {
  const ran = await runScript(host, { script }, ctx)
  report(name, ran.images.length === 0 && ran.text.includes(expected), ran.text)
}
report('no images is plain text', typeof toolResult({ text: 'x', images: [] }) === 'string', '')

// The session store: values per session, the least recently saved sessions dropped past 50.
const map = new Map<string, unknown>()
const kv: KeyValue = {
  get: async key => structuredClone(map.get(key)),
  set: async (key, value) => void map.set(key, structuredClone(value)),
  delete: async key => void map.delete(key),
  keys: async () => [...map.keys()],
}
await saveSessionStore(kv, 'a', { cursor: 1 })
await saveSessionStore(kv, 'b', { cursor: 2 })
const loaded = [(await loadSessionStore(kv, 'a')).cursor, (await loadSessionStore(kv, 'b')).cursor, Object.keys(await loadSessionStore(kv, 'none')).length]
report('store per session', JSON.stringify(loaded) === '[1,2,0]', JSON.stringify(loaded))
for (let i = 0; i < 60; i++) {
  await saveSessionStore(kv, `s${i}`, { i })
  await Bun.sleep(1)
}
report('store keeps the 50 newest', map.size === 50 && map.has('session:s59') && !map.has('session:a'), `${map.size} ${[...map.keys()].slice(0, 3)}`)
await saveSessionStore(kv, 's59', {})
report('store drops an emptied session', !map.has('session:s59'), [...map.keys()].join(' '))

if (declarations.size > 0) {
  const bash = compactDeclaration(declarations.get('Bash')!)
  report('compact declaration', bash.startsWith('{ command: string; timeout?: number;') && !bash.includes('/**'), bash)
  const inline = inlineDeclarations(declarations, new Set(['Bash', 'Read', 'Edit']))
  report('inline declarations', inline.includes('tools.Read({ file_path: string;') && !inline.includes('tools.Write'), inline)
  console.log(inlineDeclarations(declarations))
}
console.log(declarations.size > 0 ? `${declarations.size} tool declarations parsed` : 'no declarations laid yet: load the plugin once')
process.exit(failed === 0 ? 0 : 1)