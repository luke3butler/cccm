// Runs the codemode runner outside Claude Code, against a fake host: `bun scripts/smoke.ts`.
// A check that does not need `claude plugin test`, which runs only while hooks modules are on.

import { runScript, toolResult, type Host } from '../hooks/runner'
import { loadSessionStore, saveSessionStore, type KeyValue } from '../hooks/store'

/** What the fake host's saveOutput wrote, by path. */
const savedFiles = new Map<string, string>()
const SAVED_FOLDER = '/tmp-smoke/claude-codemode'

let inFlight = 0
let maxInFlight = 0
/** The signal the latest mcp__slow__wait call was given. */
let waitSignal: AbortSignal | undefined
const host: Host = {
  listTools: async () => [
    { name: 'Bash', description: 'Run a shell command.', mcp: false },
    { name: 'Read', description: 'Read a file.', mcp: false },
    { name: 'Write', description: 'Write a file.', mcp: false },
    { name: 'mcp__big__dump', description: 'A large MCP output.', mcp: true },
    { name: 'mcp__slow__wait', description: 'Never answers.', mcp: true },
    { name: 'mcp__slow__late', description: 'Answers after 100 ms.', mcp: true },
    { name: 'mcp__big__overflow', description: 'An output Claude Code saved to a file.', mcp: true },
    { name: 'mcp__dev-radius__list-all-items', description: 'Lists items; hyphens in its server and tool names.', mcp: true },
  ],
  callTool: async (input, signal) =>
    input.tool === 'Read' && input.file_path === '/secret.md'
      ? { deny: 'Permission to read /secret.md has been denied.' }
      : input.tool === 'Write'
      ? (savedFiles.set(String(input.file_path), String(input.content)), { result: { type: 'create' }, text: `File created successfully at: ${input.file_path}` })
      : input.tool === 'Read'
      ? { result: { type: 'file_unchanged', file: { filePath: input.file_path } }, text: 'Wasted call — file unchanged since your last Read.' }
      : input.tool === 'mcp__big__overflow'
      ? { result: { content: [{ type: 'text', text: 'Too big; stored at /p/smoke/tool-results/mcp-big-overflow-1.txt.' }] }, text: 'Too big; stored at /p/smoke/tool-results/mcp-big-overflow-1.txt.' }
      : input.tool === 'mcp__dev-radius__list-all-items'
      ? { result: { content: [{ type: 'text', text: `items ${input.q}` }] }, text: `items ${input.q}` }
      : input.tool === 'mcp__slow__late'
      ? new Promise(resolve => setTimeout(() => resolve({ result: { content: [{ type: 'text', text: '{"done":true}' }] }, text: '{"done":true}' }), 100))
      : input.tool === 'mcp__slow__wait'
      ? ((waitSignal = signal), new Promise(() => {}))
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
  sessionFacts: async () => ({ id: 'smoke', cwd: '/work/sub', projectDir: '/work', repo: { root: '/work', remote: null }, turns: 3 }),
  sessionUsage: async args => ({ startedAt: 1, context: { window: 200000, percent: 12 }, rateLimits: [], cost: { usd: 0.5 }, args }),
  sessionMessages: async args => (args?.agentId === 'gone' ? { deny: 'no such agent' } : [{ role: 'user', text: 'hi', toolUses: [] }]),
  saveStore: async () => {},
  saveOutput: async (name, text) => {
    savedFiles.set(`${SAVED_FOLDER}/${name}.txt`, text)
    return `${SAVED_FOLDER}/${name}.txt`
  },
  savedFolder: async () => SAVED_FOLDER,
  readFile: async path => savedFiles.get(path) ?? (path === '/notes.md' ? 'one\ntwo\nthree\n' : path.includes('/tool-results/') ? `{"issues":[${'1,'.repeat(40)}1]}` : `full ${path}`),
  statFile: async path =>
    savedFiles.has(path)
      ? { size: savedFiles.get(path)!.length, mtimeMs: Date.now(), realPath: path }
      : path.includes('/smoke/tool-results/') || path === '/notes.md' || path === '/secret.md'
      ? { size: 83, mtimeMs: Date.now(), realPath: path }
      : undefined,
  now: () => Date.now(),
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
  ['session facts', 'return [session.id, session.cwd, session.projectDir, session.repo.root, session.turns].join(" ")', 'smoke /work/sub /work /work 3'],
  ['session.usage', 'const u = await session.usage({ breakdown: "summary" })\nreturn [u.context.percent, u.cost.usd, u.args.breakdown].join(" ")', '12 0.5 summary'],
  ['session.messages', 'const m = await session.messages()\nconst d = await session.messages({ agentId: "gone" })\nreturn m[0].text + " " + d.deny', 'hi no such agent'],
  ['MCP overflow recovered whatever the notice says', 'const r = await tools.mcp__big__overflow({})\nreturn JSON.parse(r.text).issues.length + " " + r.fullOutputPath', '41 /p/smoke/tool-results/mcp-big-overflow-1.txt'],
  ['saved outputs listed', 'await tools.mcp__big__overflow({})', 'Saved outputs (readFile(path) in a script reads one back, up to 4 MiB; tools.Bash with jq or rg filters a larger one):\n- #1 mcp__big__overflow → /p/smoke/tool-results/mcp-big-overflow-1.txt (94 chars)'],
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
const LIST = 'tools.mcp__dev-radius__list-all-items'
checks.push(
  ['a hyphenated call', `return (${LIST}({ q: 1 })).then(r => r.text)`, 'items 1'],
  ['a hyphenated call awaited, chained, in allSettled', `const a = await ${LIST}({ q: 2 })\nconst b = await ${LIST}({ q: 3 }).then(r => r.text)\nconst c = await Promise.allSettled([${LIST}({ q: 4 })])\nreturn [a.text, b, c[0].value.text].join(",")`, 'items 2,items 3,items 4'],
  ['a hyphenated tool as a value', `const f = ${LIST}\nreturn (await f({ q: 5 })).text`, 'items 5'],
  ['a subtraction that is not a tool name is left alone', `const n = 2\nreturn tools.Bash-n`, '\nnull'],
  ['what the rewrite cannot join gets the hint', `return ${LIST}({ q: 6 }) * 2`, 'A hyphen in a tool name reads as a subtraction; write it as an underscore: tools.mcp__dev_radius__list_all_items'],
  ['call in ALL_TOOLS', 'return ["Read", "mcp__dev-radius__list-all-items"].map(n => ALL_TOOLS.find(t => t.name === n).call).join(" ")', 'tools.Read tools.mcp__dev_radius__list_all_items'],
  ['a missing tool points at ALL_TOOLS and ToolSearch', 'return tools.Nope({})', 'No tool named Nope. ALL_TOOLS lists the tools a script can call; ToolSearch, called by you, finds and loads one.'],
)
checks.push(
  ['json on an MCP reply whose text is JSON', 'return (await tools.mcp__big__overflow({})).json.issues.length', '\n41'],
  ['no json when the text is not JSON', 'return "json" in (await tools.mcp__big__dump({}))', '\nfalse'],
  ['shape', 'return shape({ a: [{ b: 1 }, { b: "x", c: null }] })', '{ a: { b: number | string; c?: null }[] }'],
  ['readFile of another file passes a Read that reads nothing, then reads it whole', 'return await readFile("/notes.md")', '1 tool call\none\ntwo'],
    ['readFile refused as Read is', 'await readFile("/secret.md")', 'Script error: Error: Permission to read /secret.md has been denied. (near line 1)\nCalls the script made:\n  failed readFile  /secret.md'],
  ['readFile reads an overflow file of this session without a Read', 'const t = await readFile("/p/smoke/tool-results/mcp-big-overflow-1.txt")\nreturn JSON.parse(t).issues.length', '0 tool calls\n41'],
  ['readFile of a missing file', 'await readFile("/nowhere.txt")', 'readFile(): no file at /nowhere.txt.'],
  ['writeFile writes through Write, non-strings as JSON, from the working directory', 'const p = await writeFile("out/a.json", { a: [1] })\nreturn p + " " + await readFile(p)', '2 tool calls\n/work/sub/out/a.json {"a":[1]}'],
  ['writeFile round trip', 'const p = await writeFile("/w/b.txt", "plain")\nreturn [await readFile(p), await readFile(await writeFile("/w/c.json", [1, 2]))].join(" ")', '\nplain [1,2]'],
  ['a read of undefined names the property and the expression', 'const j = { json: {} }\nreturn j.json.data.issues', "TypeError: Cannot read properties of undefined (reading 'issues'): j.json.data is undefined (near line 2)"],
  ['a method call on undefined names the method and the expression', 'const r = { json: {} }\nreturn r.json.meetings.map(m => m.name)', "TypeError: Cannot read properties of undefined (reading 'map'): r.json.meetings is undefined (near line 2)"],
  ['an unnamed read of undefined loses the engine variable', 'for (const x of undefined) {}', 'TypeError: undefined is not an object (near line 1)'],
)
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

// A failed script outlines each MCP reply it got, once per tool and outline.
const outlined = await runScript(host, { script: 'await tools.mcp__big__overflow({})\nawait tools.mcp__big__overflow({})\nawait tools.mcp__big__dump({})\nawait tools.Bash({ command: "x" })\nthrow new Error("wrong guess")' }, ctx)
report(
  'a failed script outlines its MCP replies',
  outlined.text.includes('\n         json: { issues: number[] }') &&
    outlined.text.split('json: {').length === 2 &&
    outlined.text.includes('\n         text, not JSON (19 chars): "full /saved/mcp.txt"') &&
    !/Bash  x .*\n {9}/.test(outlined.text),
  outlined.text,
)
const replyPath = /mcp__big__overflow  \d+ ms  → (\S+)/.exec(outlined.text)?.[1]
report(
  'a failed script saves its MCP replies and says how to read them',
  replyPath === `${SAVED_FOLDER}/smoke-reply-1.txt` && outlined.text.includes('JSON.parse(await readFile(path))') && !/ok {5}Bash  x .*→/.test(outlined.text),
  outlined.text,
)
const reread = await runScript(host, { script: `const a = JSON.parse(await readFile(${JSON.stringify(replyPath)}))\nconst b = await readFile("${SAVED_FOLDER}/smoke-reply-3.txt")\nreturn [a.issues.length, b].join(" ")` }, ctx)
report('readFile gives a saved reply back: its json, else its text', reread.text.includes('\n41 full /saved/mcp.txt'), reread.text)

// max_output_tokens: at most 12000, the most Claude Code shows whole; the parameter wins over // @options.
const capped = await runScript(host, { script: '// @options: {"max_output_tokens": 2000}\nreturn "x".repeat(60000)', max_output_tokens: 14000 }, ctx)
report(
  'a max_output_tokens past 12000 is lowered, and says so',
  capped.text.length < 50_000 && capped.text.includes('characters omitted; full output in') && capped.text.includes('max_output_tokens 14000 was lowered to 12000, the most Claude Code shows whole'),
  capped.text.slice(0, 300),
)
const optioned = await runScript(host, { script: '// @options: {"max_output_tokens": 14000}\nreturn "x".repeat(60000)', max_output_tokens: 1000 }, ctx)
report('the parameter wins over // @options', optioned.text.length < 5000 && !optioned.text.includes('lowered'), optioned.text.slice(0, 300))
const fits = await runScript(host, { script: 'return "x".repeat(45000)', max_output_tokens: 14000 }, ctx)
report('output that fits says nothing of the cap', !fits.text.includes('omitted') && !fits.text.includes('lowered'), fits.text.slice(0, 300))

// A failed script's result waits for its tool calls still running, at most 5 s, and only when there are any.
const timed = async (script: string) => {
  const at = performance.now()
  const ran = await runScript(host, { script }, ctx)
  return { text: ran.text, ms: performance.now() - at }
}
const late = await timed('tools.mcp__slow__late({})\nthrow new Error("boom")')
report(
  'a tool call that ends soon after the error is reported as it ended, its reply saved',
  /ok {5}mcp__slow__late  \d+ ms  \(ended after the error\)  → \S+-reply-1\.txt\n {9}json: \{ done: boolean \}/.test(late.text) && late.ms < 1000,
  late.text,
)
const nothing = await timed('await tools.mcp__big__dump({})\nthrow new Error("boom")')
report('a failed script with nothing running does not wait', nothing.ms < 200 && !nothing.text.includes('ended after'), `${nothing.ms} ms\n${nothing.text}`)
const never = await timed('tools.mcp__slow__wait({})\nthrow new Error("boom")')
report(
  'a tool call still running after 5 s is cancelled',
  never.ms >= 4900 && never.ms < 6000 && waitSignal?.aborted === true && never.text.includes('cancelled mcp__slow__wait  (still running when the script ended; what it already did stands)'),
  `${never.ms} ms\n${never.text}`,
)
waitSignal = undefined
const unawaited = await timed('tools.mcp__slow__wait({})\nreturn "done"')
report('a successful script cancels the calls it left running', unawaited.ms < 200 && waitSignal?.aborted === true && unawaited.text.includes('done'), `${unawaited.ms} ms\n${unawaited.text}`)
const interrupt = new AbortController()
setTimeout(() => interrupt.abort(), 200)
const interruptedAt = performance.now()
const interrupted = await runScript(host, { script: 'tools.mcp__slow__wait({})\nthrow new Error("boom")' }, { ...ctx, signal: interrupt.signal })
const interruptedMs = performance.now() - interruptedAt
report('an interrupt ends the wait', interruptedMs < 600 && interrupted.text.includes('cancelled mcp__slow__wait'), `${interruptedMs} ms\n${interrupted.text}`)
const timedOut = await timed('// @options: {"timeout_ms": 100}\ntools.mcp__slow__wait({})\nawait sleep(1000)')
report('no wait after a timeout', timedOut.ms < 400 && timedOut.text.includes('Timed out after 100 ms'), `${timedOut.ms} ms\n${timedOut.text}`)

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
await saveSessionStore(kv, 'a', new Map([['cursor', 1]]))
await saveSessionStore(kv, 'b', new Map([['cursor', 2]]))
const loaded = [(await loadSessionStore(kv, 'a')).cursor, (await loadSessionStore(kv, 'b')).cursor, Object.keys(await loadSessionStore(kv, 'none')).length]
report('store per session', JSON.stringify(loaded) === '[1,2,0]', JSON.stringify(loaded))
for (let i = 0; i < 60; i++) {
  await saveSessionStore(kv, `s${i}`, new Map([['i', i]]))
  await Bun.sleep(1)
}
report('store keeps the 50 newest', map.size === 50 && map.has('session:s59') && !map.has('session:a'), `${map.size} ${[...map.keys()].slice(0, 3)}`)
await saveSessionStore(kv, 's59', new Map([['i', undefined]]))
report('store drops an emptied session', !map.has('session:s59'), [...map.keys()].join(' '))

// Two scripts saving at once, reads and writes slow enough that both would read before either writes.
const slow: KeyValue = {
  ...kv,
  get: async key => (await Bun.sleep(20), structuredClone(map.get(key))),
  set: async (key, value) => (await Bun.sleep(20), void map.set(key, structuredClone(value))),
}
await saveSessionStore(kv, 'pair', new Map([['kept', 1], ['dropped', 1]]))
await Promise.all([
  saveSessionStore(slow, 'pair', new Map([['first', 1], ['dropped', undefined]])),
  saveSessionStore(slow, 'pair', new Map([['second', 2]])),
])
const pair = await loadSessionStore(kv, 'pair')
report('scripts saving at once keep each other\'s keys', JSON.stringify(pair) === '{"kept":1,"first":1,"second":2}', JSON.stringify(pair))

process.exit(failed === 0 ? 0 : 1)