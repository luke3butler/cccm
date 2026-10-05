import type { ToolCallArgs, ToolInfo } from 'claude-code'
import { expect, test, type Engine } from 'claude-code/testing'

const TOOLS: ToolInfo[] = [
  { name: 'Read', description: 'Read a file from the local filesystem.', mcp: false },
  { name: 'Bash', description: 'Run a shell command.', mcp: false },
  { name: 'mcp__dev-radius__search', description: 'Search the radius index for documents.', mcp: true },
  { name: 'mcp__dev-radius__fetch', description: 'Fetch one document by id.', mcp: true },
  { name: 'mcp__codemode__run', description: 'This tool.', mcp: false },
]

type TestOn = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]

/** The engine calls every run makes: the tool list, and a session with nothing stored. */
function stubEngine(on: TestOn): void {
  on('tool.list', () => ({ value: TOOLS }))
  on('session.id', () => ({ value: 'test-session' }))
  on('store.get', () => ({ value: undefined }))
  stubPlace(on)
}

/** Where the session runs: its directory, project root and repository. */
function stubPlace(on: TestOn): void {
  on('session.cwd', () => ({ value: '/work/sub' }))
  on('session.root', () => ({ value: '/work' }))
  on('session.repo', () => ({ value: { root: '/work', remote: 'git@example.com:me/work.git', internal: false, name: null } }))
  on('session.turns', () => ({ value: 3 }))
}

async function run($: Engine, script: string, extra: Record<string, unknown> = {}): Promise<string> {
  const ran = await $.tool.call({ tool: 'mcp__codemode__run', script, ...extra } as unknown as ToolCallArgs)
  return String(ran.result)
}

test('runs tool calls in parallel and returns only the script output', async ($, on) => {
  stubEngine(on)
  on('tool.call', { tool: 'Read' }, (_$, e) => ({ result: { path: e.file_path }, text: `text of ${e.file_path}` }))

  const text = await run(
    $,
    `const files = await Promise.all(["a.md", "b.md"].map(p => tools.Read({ file_path: p })))
     return files.map(f => f.text)`,
  )

  expect(text).toContain('Script completed')
  expect(text).toContain('2 tool calls')
  expect(text).toContain('text of a.md')
  expect(text).toContain('text of b.md')
})

test('MCP tools resolve to their result, with names made identifiers', async ($, on) => {
  stubEngine(on)
  // A RegExp matcher: the server is made up, so its name is not among the session's typed MCP tools.
  on('tool.call', { tool: /^mcp__dev-radius__search$/ }, (_$, e) => {
    const query = (e as unknown as { query?: string }).query
    return { result: { content: [{ type: 'text', text: `hits for ${query}` }] }, text: `hits for ${query}` }
  })

  const text = await run(
    $,
    `const r = await tools.mcp__dev_radius__search({ query: "fox" })
     text("isError" in r)
     text(r.content[0].text)`,
  )

  expect(text).toContain('Script completed')
  expect(text).toContain('false')
  expect(text).toContain('hits for fox')
})

test('an MCP call the server marks as an error rejects, with the reply on the error', async ($, on) => {
  stubEngine(on)
  on('tool.call', { tool: /^mcp__dev-radius__search$/ }, (_$, e) => {
    const query = (e as unknown as { query?: string }).query
    return query === 'bad'
      ? { isError: true, result: { content: [{ type: 'text', text: 'MCP error -32602: Invalid arguments' }] }, text: 'MCP error -32602: Invalid arguments' }
      : { result: { content: [{ type: 'text', text: 'hits' }] }, text: 'hits' }
  })

  const text = await run(
    $,
    `const results = await Promise.allSettled(["fox", "bad"].map(query => tools.mcp__dev_radius__search({ query })))
     return results.map(r => r.status === "fulfilled" ? r.value.text : r.reason.message + " | " + r.reason.result.content[0].text)`,
  )

  expect(text).toContain('"hits"')
  expect(text).toContain('MCP error -32602: Invalid arguments | MCP error -32602: Invalid arguments')
})

test('searchTools ranks by relevance and ALL_TOOLS leaves codemode out', async ($, on) => {
  stubEngine(on)

  const text = await run(
    $,
    `const hits = await searchTools("search documents")
     text(hits[0].name)
     text(ALL_TOOLS.some(t => t.name === "mcp__codemode__run"))
     const ns = await describeNamespace("dev-radius")
     text(ns.tools.length)`,
  )

  expect(text).toContain('mcp__dev-radius__search')
  expect(text).toContain('false')
  expect(text).toContain('\n2')
})

test('a failed tool call rejects, and allSettled keeps the rest', async ($, on) => {
  stubEngine(on)
  on('tool.call', { tool: 'Read' }, (_$, e) =>
    e.file_path === 'missing.md'
      ? { isError: true, result: 'File does not exist.', text: 'File does not exist.' }
      : { result: {}, text: 'ok' },
  )

  const text = await run(
    $,
    `const results = await Promise.allSettled([tools.Read({ file_path: "a.md" }), tools.Read({ file_path: "missing.md" })])
     return results.map(r => r.status === "fulfilled" ? r.value.text : String(r.reason.message))`,
  )

  expect(text).toContain('"ok"')
  expect(text).toContain('File does not exist.')
})

test('a failed script lists the calls it made', async ($, on) => {
  stubEngine(on)
  on('tool.call', { tool: 'Read' }, (_$, e) =>
    e.file_path === 'missing.md'
      ? { isError: true, result: 'File does not exist.', text: 'File does not exist.' }
      : { result: {}, text: 'ok' },
  )

  const text = await run(
    $,
    `await tools.Read({ file_path: "a.md" })
     await tools.Read({ file_path: "missing.md" }).catch(() => {})
     JSON.parse("not json")`,
  )

  expect(text).toContain('Script failed')
  expect(text).toMatch(/Calls the script made:\n {2}ok {5}Read {2}a\.md {2}\d+ ms\n {2}failed Read {2}missing\.md {2}\d+ ms$/)
})

test('a failing script keeps its partial output', async ($, on) => {
  stubEngine(on)

  const text = await run($, `console.log("before")\nnull.boom`)

  expect(text).toContain('Script failed')
  expect(text).toContain('before')
  expect(text).toContain('Script error: TypeError')
})

test('unknown tools and syntax errors fail with a useful message', async ($, on) => {
  stubEngine(on)

  expect(await run($, `await tools.Nope({})`)).toContain('No tool named Nope')
  expect(await run($, `return (`)).toContain('Script error: SyntaxError')
  expect(await run($, `await tools.mcp__codemode__run({ script: "1" })`)).toContain('cannot start another codemode script')
})

test('a busy loop stops at timeout_ms', async ($, on) => {
  stubEngine(on)

  const text = await run($, `// @options: {"timeout_ms": 100}\nwhile (true) {}`)

  expect(text).toContain('Script failed')
  expect(text).toContain('Timed out after 100 ms')
})

test('exit() ends the script successfully', async ($, on) => {
  stubEngine(on)

  const text = await run($, `text("one")\nexit()\ntext("two")`)

  expect(text).toContain('Script completed')
  expect(text).toContain('one')
  expect(text).not.toContain('two')
})

test('store() writes only when the script succeeds, under the session id', async ($, on) => {
  const writes: [string, unknown][] = []
  on('tool.list', () => ({ value: TOOLS }))
  on('session.id', () => ({ value: 's1' }))
  stubPlace(on)
  on('store.get', (_$, e) => ({ value: e.key === 'session:s1' ? { savedAt: 1, values: { cursor: 3 } } : undefined }))
  on('store.set', (_$, e) => {
    writes.push([e.key, (e.value as { values: unknown }).values])
    return { value: undefined }
  })
  on('store.keys', () => ({ value: ['session:s1'] }))

  const ok = await run($, `store("cursor", load("cursor") + 1)\nreturn load("cursor")`)
  expect(ok).toContain('4')
  expect(writes).toEqual([['session:s1', { cursor: 4 }]])

  await run($, `store("cursor", 99)\nthrow new Error("no")`)
  expect(writes).toEqual([['session:s1', { cursor: 4 }]])
})

test('a script awaiting a promise that never settles fails at once', async ($, on) => {
  stubEngine(on)
  on('clock.sleep', () => ({ value: undefined }))

  const text = await run($, 'text("before")\nawait sleep(5)\nawait new Promise(() => {})')

  expect(text).toContain('Script failed')
  expect(text).toContain('before')
  expect(text).toContain('never settles')
})

test('long output keeps its start and end', async ($, on) => {
  stubEngine(on)
  on('env.get', () => ({ value: '/tmp' }))
  on('fs.write', () => ({ value: undefined }))

  const text = await run($, `text("START" + "x".repeat(5000) + "END")`, { max_output_tokens: 100 })

  expect(text).toContain('START')
  expect(text).toContain('END')
  expect(text).toContain('characters omitted')
  expect(text).toContain('/tmp/claude-codemode/')
})

test('template literals evaluate their escapes', async ($, on) => {
  stubEngine(on)

  const text = await run($, 'return [`a\\nb`.length, `t\\t${1}`.length, String.raw`a\\n`.length]')

  expect(text).toContain('[\n  3,\n  3,\n  3\n]')
})

test('a long output Claude Code saved to a file reaches the script whole', async ($, on) => {
  stubEngine(on)
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: 'preview', stderr: '', interrupted: false, persistedOutputPath: '/saved/out.txt' },
    text: '<persisted-output>\nOutput too large. Full output saved to: /saved/out.txt\n\nPreview',
  }))
  on('fs.read', () => ({ value: 'the whole output' }))

  const text = await run($, 'const b = await tools.Bash({ command: "seq 1 40000" })\nreturn [b.result.stdout, b.text, b.fullOutputPath]')

  expect(text).toContain('"the whole output",\n  "the whole output",\n  "/saved/out.txt"')
})

test('a script reads the session facts', async ($, on) => {
  stubEngine(on)

  const text = await run($, 'return session')

  expect(text).toContain('"id": "test-session"')
  expect(text).toContain('"cwd": "/work/sub"')
  expect(text).toContain('"projectDir": "/work"')
  expect(text).toContain('"remote": "git@example.com:me/work.git"')
  expect(text).toContain('"turns": 3')
  expect(text).not.toContain('internal')
})

test('a script reads session.usage() and session.messages() as the engine answers them', async ($, on) => {
  stubEngine(on)
  const asked: unknown[] = []
  on('session.usage', (_$, e) => {
    asked.push(e)
    return { value: { startedAt: 1, context: { tokens: 24000, window: 200000, percent: 12 }, rateLimits: [{ kind: 'five_hour', percentUsed: 7 }], cost: { usd: 0.5 } } }
  })
  on('session.messages', () => ({ value: [{ role: 'user', text: 'hello', toolUses: [] }] }))

  const text = await run($, 'const u = await session.usage({ breakdown: "summary" })\nconst m = await session.messages()\nreturn [u.context.percent, u.rateLimits[0].kind, u.cost.usd, m[0].text]')

  expect(text).toContain('Script completed')
  expect(text).toContain('12')
  expect(text).toContain('five_hour')
  expect(text).toContain('hello')
  expect(JSON.stringify(asked)).toContain('summary')
})

test('a Read Claude Code answers as unchanged is read again for the script', async ($, on) => {
  stubEngine(on)
  on('tool.call', { tool: 'Read' }, (_$, e) => ({
    result: { type: 'file_unchanged', file: { filePath: e.file_path } },
    text: 'Wasted call — file unchanged since your last Read.',
  }))
  on('fs.read', () => ({ value: 'one\ntwo\nthree' }))

  const text = await run($, 'return (await tools.Read({ file_path: "/notes.md" })).text')

  expect(text).toContain('1\tone\n2\ttwo\n3\tthree')
})

test('a runtime error names the line that ran last', async ($, on) => {
  stubEngine(on)

  const text = await run($, 'const a = 1\n\nmissingVariable.boom')

  expect(text).toContain('Script error: ReferenceError')
  expect(text).toContain('(near line 3)')
})

test('image() adds an image block after the text', async ($, on) => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAbklEQVR4nO3PwQkAMRADse2/qnSWKyIsxodg3saaO7Pa8vzdngcAAAAAAAAAAAAAAAAAAAAAAAAAAAD4I2BOefkHAOXlHwCUl38AUF7+AUB5+QcA5eUfAJSXfwBQXv4BQHn5BwDl5R8AlJd/8NYH1J34xNmXXPwAAAAASUVORK5CYII='
  stubEngine(on)
  on('tool.call', { tool: 'Read' }, () => ({ result: { type: 'image', file: { base64: png, type: 'image/png', originalSize: 1 } }, text: '[image]' }))

  const ran = await $.tool.call({ tool: 'mcp__codemode__run', script: 'image(await tools.Read({ file_path: "a.png" }))' } as unknown as ToolCallArgs)
  const blocks = ran.result as { type: string; text?: string; source?: { media_type: string; data: string } }[]

  expect(blocks[0]?.text).toContain('1 tool call, 1 image')
  expect(blocks[1]?.source?.media_type).toBe('image/png')
  expect(blocks[1]?.source?.data).toBe(png)
})

test('the row shows the script and the tool calls it made', async ($, on) => {
  stubEngine(on)
  on('tool.call', { tool: 'Read' }, (_$, e) =>
    e.file_path === 'missing.md' ? { isError: true, result: 'File does not exist.', text: 'File does not exist.' } : { result: {}, text: 'ok' },
  )
  const script = 'const a = await tools.Read({ file_path: "a.md" })\nawait tools.Read({ file_path: "missing.md" }).catch(() => {})\nreturn a.text'
  await $.tool.call({ tool: 'mcp__codemode__run', tool_use_id: 'toolu_row', script } as unknown as ToolCallArgs)

  const row = await $.ui.mount({
    plugin: 'codemode',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'toolu_row',
    props: { tool_use_id: 'toolu_row', tool: 'mcp__codemode__run', input: { script }, isRunning: false, isErrored: false, isInterrupted: false },
  })
  const texts = (await row.findAll({ type: 'Text' })).map(found => found.text)

  expect(texts.some(text => text.includes('codemode · 2 calls, 1 failed'))).toBe(true)
  expect(texts.some(text => text.includes('const a = await tools.Read'))).toBe(true)
  expect(texts.some(text => text.includes('✓ Read a.md'))).toBe(true)
  expect(texts.some(text => text.includes('✗ Read missing.md'))).toBe(true)
})

test('the row marks a failed script, which Claude Code draws as a success', async ($, on) => {
  stubEngine(on)
  const script = 'throw new Error("boom")'
  const ran = await $.tool.call({ tool: 'mcp__codemode__run', tool_use_id: 'toolu_failed', script } as unknown as ToolCallArgs)
  const mount = (requestId: string, output: unknown) =>
    $.ui.mount({
      plugin: 'codemode',
      surface: 'terminal',
      component: 'ToolUse',
      requestId,
      props: { tool_use_id: requestId, tool: 'mcp__codemode__run', input: { script }, isRunning: false, isErrored: false, isInterrupted: false, output },
    })

  const failed = await mount('toolu_failed', ran.result)
  const fine = await mount('toolu_fine', 'Script completed in 0.0s, 0 tool calls')

  expect(await failed.find({ type: 'Text', text: ' · script failed' })).toBeDefined()
  expect(await fine.find({ type: 'Text', text: ' · script failed' })).toBeUndefined()
})

/** Mounts a codemode result under its row, as the transcript draws it. */
function mountResult($: Engine, requestId: string, output: unknown) {
  return $.ui.mount({
    plugin: 'codemode',
    surface: 'terminal',
    component: 'ToolResult',
    requestId,
    props: { tool_use_id: requestId, tool: 'mcp__codemode__run', output, isErrored: false },
  })
}

const LONG_RESULT = ['Script completed in 0.1s, 1 tool call', ...Array.from({ length: 8 }, (_, i) => `out ${i + 1}`)].join('\n')

test('the result drops the header, folds long output, and its button shows all of it', async ($, on) => {
  stubEngine(on)
  const result = await mountResult($, 'toolu_result', LONG_RESULT)
  const texts = async () => (await result.findAll({ type: 'Text' })).map(found => found.text)

  expect((await texts()).some(text => text.includes('Script completed'))).toBe(false)
  expect((await texts()).some(text => text.includes('out 5'))).toBe(true)
  expect((await texts()).some(text => text.includes('out 6'))).toBe(false)
  expect((await result.find({ key: 'expand-result' }))?.text).toContain('3 more lines (show all)')

  await result.press({ key: 'expand-result' })
  expect((await texts()).some(text => text.includes('out 8'))).toBe(true)
  expect((await result.find({ key: 'expand-result' }))?.text).toContain('Show less')
})

test('colors and progress rewrites in output are plain text, for the model and the drawn result', async ($, on) => {
  stubEngine(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: {}, text: '\x1b[32m✓ passed\x1b[0m 3\r\nloading 10%\rloading 100%\n\x1b]8;;http://x\x07link\x1b]8;;\x07 done' }))
  const ran = await run($, 'return (await tools.Bash({ command: "npm test" })).text')
  expect(ran).toContain('✓ passed 3\nloading 100%\nlink done')
  expect(/[\x00-\x08\x0b-\x1f\x7f]/.test(ran)).toBe(false)

  // A result stored before the fix still draws, cleaned, rather than being refused.
  const result = await mountResult($, 'toolu_result_colors', 'Script completed in 0.1s, 1 tool call\n\x1b[31mred\x1b[0m\rover')
  const texts = (await result.findAll({ type: 'Text' })).map(found => found.text)
  expect(texts.some(text => text.includes('over'))).toBe(true)
  expect(texts.some(text => text.includes('\x1b'))).toBe(false)
})

test('the result shows a failed script whole', async ($, on) => {
  stubEngine(on)
  const ran = await $.tool.call({ tool: 'mcp__codemode__run', script: Array.from({ length: 7 }, (_, i) => `text("line ${i}")`).join('\n') + '\nthrow new Error("boom")' } as unknown as ToolCallArgs)
  const result = await mountResult($, 'toolu_result_failed', ran.result)
  const texts = (await result.findAll({ type: 'Text' })).map(found => found.text)

  expect(texts.some(text => text.includes('line 6'))).toBe(true)
  expect(texts.some(text => text.includes('Script error: Error: boom'))).toBe(true)
  expect(await result.find({ key: 'expand-result' })).toBeUndefined()
})

test('the row folds a long script, and its button shows all of it', async ($, on) => {
  stubEngine(on)
  const script = Array.from({ length: 12 }, (_, i) => `text("line ${i + 1}")`).join('\n')
  const row = await $.ui.mount({
    plugin: 'codemode',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'toolu_long',
    props: { tool_use_id: 'toolu_long', tool: 'mcp__codemode__run', input: { script }, isRunning: false, isErrored: false, isInterrupted: false },
  })

  expect(await row.find({ type: 'Text', text: 'text("line 8")' })).toBeDefined()
  expect(await row.find({ type: 'Text', text: 'text("line 9")' })).toBeUndefined()
  expect((await row.find({ key: 'expand' }))?.text).toContain('4 more lines (show all)')

  await row.press({ key: 'expand' })
  expect(await row.find({ type: 'Text', text: 'text("line 12")' })).toBeDefined()
  expect((await row.find({ key: 'expand' }))?.text).toBe('Show less')

  await row.press({ key: 'expand' })
  expect(await row.find({ type: 'Text', text: 'text("line 12")' })).toBeUndefined()
})
test('models.complete and models.classify run through the session client', async ($, on) => {
  stubEngine(on)
  const asked: unknown[] = []
  on('model.complete', (_$, e) => {
    asked.push(e)
    return { value: { isAnswered: true, text: 'a summary', usage: { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }
  })
  on('model.classify', () => ({ value: 'bug' }))

  const text = await run($, 'const s = await models.complete({ prompt: "Summarise this", effort: "low" })\nreturn [s.text, await models.classify("it crashes", ["bug", "feature"])]')

  expect(text).toContain('0 tool calls, 2 model calls (1.5k tokens)')
  expect(text).toContain('"a summary",\n  "bug"')
  expect(asked).toEqual([expect.objectContaining({ model: 'haiku', prompt: 'Summarise this', effort: 'low' })])
})
test('the result shows the file changes the script\'s calls made, as Bash\'s row does', async ($, on) => {
  stubEngine(on)
  on('tool.call', { tool: 'Bash' }, () => ({
    text: '',
    result: {
      stdout: '',
      stderr: '',
      interrupted: false,
      bashEditDiff: {
        files: [{ filePath: '/work/a.txt', hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' keep', '-old', '+new'] }] }],
        moreFiles: 0,
      },
    },
  }))
  on('tool.call', { tool: 'Read' }, () => ({ text: 'ok', result: {} }))
  const ran = await $.tool.call({
    tool: 'mcp__codemode__run',
    tool_use_id: 'toolu_diff',
    script: 'await tools.Bash({ command: "sed -i s/old/new/ a.txt" })\nawait tools.Read({ file_path: "a.txt" })\nreturn "done"',
  } as unknown as ToolCallArgs)

  const result = await mountResult($, 'toolu_diff', ran.result)
  const texts = (await result.findAll({ type: 'Text' })).map(found => found.text)
  expect(texts.some(text => text.includes('Updated /work/a.txt (+1 -1)'))).toBe(true)
  expect(JSON.stringify(await result.drawn())).toContain('@@ -1,2 +1,2 @@\\n keep\\n-old\\n+new')
  // The model reads the script's output alone.
  expect(String(ran.result)).not.toContain('Updated')
})

test('help() lists the topics, and help(topic) holds the detail the reference leaves out', async ($, on) => {
  stubEngine(on)
  const topics = await run($, 'return help()')
  for (const topic of ['tools', 'output', 'models', 'panes', 'saved']) expect(topics).toContain(`help("${topic}")`)
  const panes = await run($, 'return help("panes")')
  expect(panes).toContain('ui.stream("dev", "npm run dev"')
  expect(panes).toContain('One follow per path')
  expect(panes).not.toContain('${')
  expect(await run($, 'return help("Models")')).toContain('# models')
  expect(await run($, 'return help("nope")')).toContain('No help topic "nope". Topics:')
})
