import type { PromptAutocompleteInput, PromptAutocompleteResult, ToolCallArgs, ToolInfo } from 'claude-code'
import { expect, test, type Engine } from 'claude-code/testing'

import { range } from '../hooks/charts'
import { sourceOf } from '../hooks/programs'
import { table } from '../hooks/table'

declare const setTimeout: (run: () => void, ms: number) => unknown

const TOOLS: ToolInfo[] = [{ name: 'Bash', description: 'Run a shell command.', mcp: false }]

type TestOn = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]

/** Raises prompt.autocomplete, which the test kit raises though its typed `$` leaves it out. */
function autocomplete($: Engine, text: string): Promise<PromptAutocompleteResult> {
  const start = text.search(/\S*$/)
  const input: PromptAutocompleteInput = { text, cursor: text.length, token: text.slice(start), start }
  return ($.prompt as unknown as { autocomplete: (e: PromptAutocompleteInput) => Promise<PromptAutocompleteResult> }).autocomplete(input)
}

/** A session with nothing stored, whose panes the surface places and lists. */
function stubEngine(on: TestOn, opened: { id: string; title?: string }[] = [], surfaces: ('terminal' | 'desktop' | 'mobile')[] = ['terminal']): void {
  on('tool.list', () => ({ value: TOOLS }))
  on('session.id', () => ({ value: 'test-session' }))
  on('store.get', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.root', () => ({ value: '/work' }))
  on('session.repo', () => ({ value: null }))
  on('session.turns', () => ({ value: 1 }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('ui.open', (_$, e) => {
    opened.push({ id: e.id, title: e.title })
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => ({ value: undefined }))
  // The waits sleep in short processes; answer each after a moment, as `sleep` would.
  on('process.run', async () => {
    await new Promise(resolve => setTimeout(() => resolve(undefined), 10))
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.panes', () => ({
    value: opened.map(pane => ({ id: pane.id, title: pane.title ?? pane.id, isShown: true, isFocused: false, isPlaced: true })),
  }))
}

async function run($: Engine, script: string): Promise<string> {
  const ran = await $.tool.call({ tool: 'mcp__codemode__run', script } as unknown as ToolCallArgs)
  return String(ran.result)
}

function mountPane<S extends 'terminal' | 'desktop' | 'mobile' = 'terminal'>($: Engine, id: string, surface: S = 'terminal' as S) {
  return $.ui.mount({
    plugin: 'codemode',
    surface,
    component: 'Pane',
    requestId: id,
    props: { title: id, isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
}

const TRIAGE = `await ui.open({
  id: "triage",
  title: "Failing tests",
  view: h("Box", { flexDirection: "column" },
    h("Text", { bold: true }, "Pick what to fix"),
    h("Text", { bind: "data.status" }),
    h("Input", { key: "note", label: "Note: " }),
    h("Button", { key: "fix", emit: "fix", data: { test: "auth" } }, "Fix auth"),
    h("Button", { key: "logs", set: { "values.tab": "logs" } }, "Logs"),
  ),
  data: { status: "3 failing" },
})`

test('a script opens a pane that draws its view and bound data', async ($, on) => {
  const opened: { id: string; title?: string }[] = []
  stubEngine(on, opened)

  const text = await run($, `${TRIAGE}\nreturn (await ui.panes()).map(p => p.id + ":" + p.isOpen + ":" + p.isPlaced)`)

  expect(text).toContain('Script completed')
  expect(text).toContain('triage:true:true')
  expect(opened).toEqual([{ id: 'triage', title: 'Failing tests' }])
  const pane = await mountPane($, 'triage')
  const texts = (await pane.findAll({ type: 'Text' })).map(found => found.text)
  expect(texts).toContain('Pick what to fix')
  expect(texts).toContain('3 failing')
  expect((await pane.find({ key: 'fix' }))?.text).toContain('Fix auth')
})

test('a pane draws command output with colors in it as plain text', async ($, on) => {
  stubEngine(on)
  const text = await run($, `await ui.open({ id: "colors", view: h("Box", {}, h("Text", {}, "\\x1b[1mbold\\x1b[0m"), h("Text", { bind: "data.log" })) })
await ui.set("colors", "data.log", "\\x1b[33mwarn\\x1b[0m 50%\\r100%")`)
  expect(text).toContain('Script completed')
  const pane = await mountPane($, 'colors')
  const texts = (await pane.findAll({ type: 'Text' })).map(found => found.text)
  expect(texts).toContain('bold')
  expect(texts.some(one => one.includes('100%') && !one.includes('50%'))).toBe(true)
  expect(texts.some(one => one.includes('\x1b'))).toBe(false)
})

test('typing /codemode-pane\'s id suggests the session\'s panes', async ($, on) => {
  stubEngine(on)
  on('prompt.autocomplete', () => ({ suggestions: [] }))
  await run($, TRIAGE)
  expect((await autocomplete($, '/codemode-pane tr')).suggestions).toEqual([{ text: 'triage', description: 'Failing tests' }])
  expect((await autocomplete($, '/codemode-pane x')).suggestions).toEqual([])
})

test('presses reach a later script through the inbox, and the next prompt says so', async ($, on) => {
  stubEngine(on)
  const prompts: { context?: readonly string[] }[] = []
  on('prompt.submit', (_$, e) => {
    prompts.push(e)
    return { text: e.text }
  })
  await run($, TRIAGE)
  const pane = await mountPane($, 'triage')

  await pane.input({ key: 'note', text: 'flaky on CI', kind: 'change' })
  await pane.press({ key: 'logs' })
  await pane.press({ key: 'fix' })

  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  expect(prompts[0]?.context?.some(note => note.includes('"triage" (Failing tests): 1 unread (fix)'))).toBe(true)

  const text = await run(
    $,
    `const events = await ui.take("triage")
     const pane = await ui.get("triage")
     return JSON.stringify({ events: events.map(e => [e.type, e.emit, e.data.test]), values: pane.values, again: (await ui.take("triage")).length })`,
  )
  expect(text).toContain('"events":[["press","fix","auth"]]')
  expect(text).toContain('"values":{"note":"flaky on CI","tab":"logs"}')
  expect(text).toContain('"again":0')
})

test('ui.wait resolves when the person acts while the script runs', async ($, on) => {
  stubEngine(on)
  await run($, TRIAGE)
  const pane = await mountPane($, 'triage')

  const waiting = run($, `const events = await ui.wait("triage", { timeoutMs: 5000 })\nreturn JSON.stringify(events.map(e => e.emit))`)
  await new Promise(resolve => setTimeout(() => resolve(undefined), 50))
  await pane.press({ key: 'fix' })

  expect(await waiting).toContain('["fix"]')
})

test('ui.wait resolves to no events at its timeout', async ($, on) => {
  stubEngine(on)
  await run($, TRIAGE)

  expect(await run($, `return (await ui.wait("triage", { timeoutMs: 200 })).length`)).toContain('\n0')
})

test('ui.append keeps the last max items, and a bound Code shows its tail', async ($, on) => {
  stubEngine(on)
  const text = await run(
    $,
    `await ui.open({ id: "log", view: h("Code", { bind: "data.lines", tail: 2 }) })
     for (let i = 1; i <= 50; i++) ui.append("log", "data.lines", "line " + i, { max: 5 })
     await ui.set("log", "data.count", 50)
     const pane = await ui.get("log")
     return JSON.stringify(pane.data)`,
  )

  expect(text).toContain('"lines":["line 46","line 47","line 48","line 49","line 50"]')
  expect(text).toContain('"count":50')
  const pane = await mountPane($, 'log')
  expect(JSON.stringify(await pane.drawn())).toContain('line 49\\nline 50')
  expect(JSON.stringify(await pane.drawn())).not.toContain('line 48')
})

test('a view that does not check fails the script with where and why', async ($, on) => {
  stubEngine(on)

  const unknownProp = await run($, `await ui.open({ id: "bad", view: h("Box", {}, h("Text", { size: 3 }, "x")) })`)
  const missingKey = await run($, `await ui.open({ id: "bad", view: h("Button", {}, "Go") })`)
  const badBind = await run($, `await ui.open({ id: "bad", view: h("Text", { bind: "secrets" }) })`)

  expect(unknownProp).toContain('Script failed')
  expect(unknownProp).toContain('view.children[0] (Text): Text takes no prop "size"')
  expect(missingKey).toContain('Button needs a "key" prop')
  expect(badBind).toContain('must be a path under values or data')
})

test('closing keeps the record, and ui.open brings it back with its data', async ($, on) => {
  const opened: { id: string; title?: string }[] = []
  stubEngine(on, opened)
  await run($, TRIAGE)

  const closed = await run($, `await ui.close("triage")\nreturn (await ui.panes())[0].isOpen`)
  const reopened = await run($, `await ui.open({ id: "triage" })\nconst p = await ui.get("triage")\nreturn JSON.stringify([p.isOpen, p.data.status])`)
  const removed = await run($, `await ui.remove("triage")\nreturn JSON.stringify([(await ui.panes()).length, await ui.get("triage")])`)

  expect(closed).toContain('false')
  expect(reopened).toContain('[true,"3 failing"]')
  expect(opened.map(pane => pane.id)).toEqual(['triage', 'triage'])
  expect(removed).toContain('[0,null]')
})

const ASK = `await ui.open({
  id: "pick",
  title: "Failing tests",
  ask: "Which failures should I fix?",
  view: h("Box", { flexDirection: "column" },
    h("Select", { key: "which", options: ["auth", "billing"] }),
    h("Input", { key: "note" }),
    h("Button", { key: "go", push: "wake" }, "Fix these"),
    h("Button", { key: "draft", push: "draft", prompt: "Fix {values.which}: {values.note}" }, "Draft it"),
  ),
})`

test('a wake press starts a turn whose message holds the question, the values and what the person did', async ($, on) => {
  stubEngine(on)
  const prompts: { text: string; origin: unknown }[] = []
  on('prompt.submit', (_$, e) => {
    prompts.push({ text: e.text, origin: e.origin })
    return { text: e.text }
  })
  await run($, ASK)
  const pane = await mountPane($, 'pick')

  await pane.select({ key: 'which', value: 'billing' })
  await pane.input({ key: 'note', text: 'only the flaky one', kind: 'change' })
  await pane.press({ key: 'go' })

  expect(prompts).toHaveLength(1)
  const text = prompts[0]!.text
  expect(text).toContain('The person answered in codemode pane "pick" (Failing tests).')
  expect(text).toContain('It asked: Which failures should I fix?')
  expect(text).toContain('Values: {"which":"billing","note":"only the flaky one"}')
  expect(text).toContain('- pressed go')
  // The answer marked its events read, so a later script and the next note find none.
  expect(await run($, `return (await ui.panes())[0].unread`)).toContain('\n0')
})

test('a draft press fills the prompt box from the pane, sending nothing', async ($, on) => {
  stubEngine(on)
  const fills: string[] = []
  const prompts: string[] = []
  on('prompt.fill', (_$, e) => {
    fills.push(e.text)
    return { isFilled: true }
  })
  on('prompt.submit', (_$, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  await run($, ASK)
  const pane = await mountPane($, 'pick')

  await pane.select({ key: 'which', value: 'auth' })
  await pane.input({ key: 'note', text: 'see CI', kind: 'change' })
  await pane.press({ key: 'draft' })

  expect(fills).toEqual(['Fix auth: see CI'])
  expect(prompts).toHaveLength(0)
})

test('ui.wait refuses a long timeout and points at a wake button', async ($, on) => {
  stubEngine(on)
  await run($, ASK)

  const text = await run($, `await ui.wait("pick", { timeoutMs: 600000 })`)
  expect(text).toContain('timeoutMs is at most 120000')
  expect(text).toContain('push: "wake"')
})

// Under the folder of the session the process began as, not the current one ('test-session'), as after /clear.
const TASK_FILE = '/tmp/claude/project/first-session/tasks/b1.output'
const FOLLOW_VIEW = `h("Box", { flexDirection: "column" }, h("Text", { bind: "data.state" }), h("Code", { bind: "data.log", tail: 10 }))`

/** A task's output file as `tail -f` streams it: the pieces, then (when `endAfterMs`) its end. */
function stubTask(on: TestOn, pieces: string[], spawned: (readonly string[])[] = [], endAfterMs = 200, bashCalls: unknown[] = []): void {
  on('tool.call', { tool: 'Bash' }, (_$, e) => (bashCalls.push(e), {
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' },
    text: `Command running in background with ID: b1. Output is being written to: ${TASK_FILE}. You will be notified when it completes.`,
  }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false } }))
  on('process.spawn', async function* (_$, e) {
    spawned.push(e.argv)
    for (const text of pieces) yield { stream: 'stdout' as const, text }
    await new Promise(resolve => setTimeout(() => resolve(undefined), endAfterMs))
    return { value: { code: 0, signal: null } }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
}

/** Starts the background command whose output the tests follow. */
const START_TASK = 'await tools.Bash({ command: "make", run_in_background: true })\n'

const later = (ms: number) => new Promise(resolve => setTimeout(() => resolve(undefined), ms))

test('ui.follow streams a task output file into the pane after the script ends, and the notification ends it', async ($, on) => {
  stubEngine(on)
  const spawned: (readonly string[])[] = []
  stubTask(on, ['one\ntw', 'o\nbuild 50%\rbuild 100%\n', 'last'], spawned, 600)
  const followed = await run(
    $,
    `${START_TASK}await ui.open({ id: "build", view: ${FOLLOW_VIEW} })
return JSON.stringify(await ui.follow("build", "${TASK_FILE}", { status: "data.state" }))`,
  )
  expect(followed).toContain('{"following":true}')
  expect(spawned[0]).toEqual(['tail', '-c', '+1', '-f', TASK_FILE])

  await later(100)
  const pane = await mountPane($, 'build')
  // A progress line keeps what follows its last carriage return.
  expect(String((await pane.find({ type: 'Code' }))?.props.source)).toMatch(/^one\ntwo\nbuild 100%(\nlast)?$/)
  expect((await pane.find({ type: 'Text' }))?.text).toBe('following')

  await $.prompt.submit({
    text: `<task-notification>\n<task-id>b1</task-id>\n<output-file>${TASK_FILE}</output-file>\n<status>completed</status>\n<summary>Background command "make" completed (exit code 0)</summary>\n</task-notification>`,
    wait: false,
    origin: { kind: 'task-notification' },
  })
  await later(900)
  // The line the task left without a newline arrives as the follow ends.
  expect(await run($, `return (await ui.get("build")).data.log.at(-1)`)).toContain('last')
  expect(await run($, `return (await ui.get("build")).data.state`)).toContain('completed (exit code 0)')
  expect(await run($, `return JSON.stringify((await ui.panes())[0].follows)`)).toContain('"state":"completed (exit code 0)"')
})

test('ui.unfollow stops a follow, and ui.follow reads only task output files', async ($, on) => {
  stubEngine(on)
  stubTask(on, ['a\n'], [], 2000)
  await run($, `${START_TASK}await ui.open({ id: "build", view: ${FOLLOW_VIEW} })\nawait ui.follow("build", "${TASK_FILE}", { status: "data.state" })`)
  await later(50)
  expect(await run($, `return await ui.unfollow("build")`)).toContain('1')
  expect(await run($, `return (await ui.get("build")).data.state`)).toContain('stopped')

  const refused = await run($, `await ui.follow("build", "/etc/passwd")`)
  expect(refused).toContain('Script failed')
  expect(refused).toContain('background Bash command this session started')
  // A task file no command of this session named, in the current session's own folder too.
  expect(await run($, `await ui.follow("build", "/tmp/claude/project/test-session/tasks/zz.output")`)).toContain('is not one')
})

test('when draws an element only while the values match, and a press switches it', async ($, on) => {
  stubEngine(on)
  const text = await run(
    $,
    `await ui.open({ id: "tabs", values: { tab: "a" }, data: { n: 3 }, view: h("Box", { flexDirection: "column" },
      h("Button", { key: "toB", set: { "values.tab": "b" } }, "B"),
      h("Text", { when: { "values.tab": "a" } }, "on a"),
      h("Text", { when: { "values.tab": ["b", "c"] } }, "on b or c"),
      h("Text", { when: { "values.tab": { not: "a" } } }, "not a"),
      h("Text", { when: { "data.n": { exists: true }, "data.gone": { exists: false } } }, "n is there")) })`,
  )
  expect(text).toContain('Script completed')
  const pane = await mountPane($, 'tabs')
  const texts = async () => (await pane.findAll({ type: 'Text' })).map(found => found.text)
  expect(await texts()).toEqual(expect.arrayContaining(['on a', 'n is there']))
  expect(await texts()).not.toContain('on b or c')
  await pane.press({ key: 'toB' })
  expect(await texts()).toEqual(expect.arrayContaining(['on b or c', 'not a']))
  expect(await texts()).not.toContain('on a')
})

test('hover and position reach the Box, and the checker names a hover prop it does not take', async ($, on) => {
  stubEngine(on)
  const ok = await run(
    $,
    `await ui.open({ id: "hov", view: h("Box", { key: "row", hover: { backgroundColor: "#334466" } },
      h("Text", { hover: { bold: true } }, "row"),
      h("Box", { position: "absolute", top: -1, left: 4, display: "none", hover: { display: "flex" } }, h("Text", {}, "card"))) })`,
  )
  expect(ok).toContain('Script completed')
  const pane = await mountPane($, 'hov')
  expect((await pane.findAll({ type: 'Text' })).map(found => found.text)).toEqual(expect.arrayContaining(['row', 'card']))
  const bad = await run($, `await ui.open({ id: "bad", view: h("Box", { hover: { width: 3 } }) })`)
  expect(bad).toContain('hover takes no "width"')
  const deep = await run($, `let v = h("Text", {}, "x"); for (let i = 0; i < 30; i++) v = h("Box", {}, v); await ui.open({ id: "deep", view: v })`)
  expect(deep).toContain('nests at most 24')
})

test('a Chart draws cells on the terminal and an SVG on the desktop, from bound data', async ($, on) => {
  stubEngine(on)
  const text = await run(
    $,
    `await ui.open({ id: "cpu", data: { cpu: [1, 5, 3, 8, 2] }, view: h("Box", { flexDirection: "column" },
      h("Chart", { kind: "bars", bind: "data.cpu", rows: 4, color: "green" }),
      h("Chart", { kind: "line", values: [1, 2, 3], columns: 10 }),
      h("Chart", { kind: "spark", bind: "data.cpu" })) })`,
  )
  expect(text).toContain('Script completed')
  const terminal = await mountPane($, 'cpu')
  const rasters = await terminal.findAll({ type: 'Raster' })
  expect(rasters.length).toBe(3)
  const desktop = await mountPane($, 'cpu', 'desktop')
  const svgs = await desktop.findAll({ type: 'Svg' })
  expect(svgs.length).toBe(3)
  const noData = await run($, `await ui.open({ id: "c2", view: h("Chart", { kind: "line" }) })`)
  expect(noData).toContain('Chart needs "values" or "bind"')
})

test('an Image draws pixels on the terminal, an SVG for a src elsewhere, and its alt for a file there', async ($, on) => {
  stubEngine(on, [], ['terminal', 'mobile'])
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
  const text = await run(
    $,
    `return await ui.open({ id: "pic", view: h("Box", { flexDirection: "column" },
      h("Image", { src: "${png}", alt: "a dot", columns: 4, rows: 2 }),
      h("Image", { file: "/work/shot.png", alt: "the shot", columns: 20, rows: 6 })) })`,
  )
  expect(text).toContain('Script completed')
  expect(text).toContain('Image \\"the shot\\": mobile draws a file source as its alt text')
  const terminal = await mountPane($, 'pic')
  expect((await terminal.findAll({ type: 'Image' })).length).toBe(2)
  const desktop = await mountPane($, 'pic', 'desktop')
  expect((await desktop.findAll({ type: 'Svg' })).length).toBe(1)
  expect((await desktop.findAll({ type: 'Text' })).map(found => found.text)).toContain('[the shot]')
  const twoSources = await run($, `await ui.open({ id: "p2", view: h("Image", { src: "${png}", file: "/a.png", alt: "x", columns: 1, rows: 1 }) })`)
  expect(twoSources).toContain('Image takes one of file, src or bind')
})

test('bound text past the engine\'s bound is cut to fit, so the pane still draws', async ($, on) => {
  stubEngine(on)
  const text = await run(
    $,
    `const big = "x".repeat(9500)
    await ui.open({ id: "big", data: Object.fromEntries(Array.from({ length: 14 }, (_, i) => ["c" + i, big])),
      view: h("Box", { flexDirection: "column" }, ...Array.from({ length: 14 }, (_, i) => h("Code", { bind: "data.c" + i }))) })`,
  )
  expect(text).toContain('Script completed')
  const pane = await mountPane($, 'big')
  const codes = await pane.findAll({ type: 'Code' })
  expect(codes.length).toBe(14)
})

test('a Chart reads numbers out of a followed log through match', async ($, on) => {
  stubEngine(on)
  const lines = ['PING google.com: 56 data bytes', '64 bytes: icmp_seq=0 time=47.3 ms', 'Request timeout', '64 bytes: icmp_seq=2 time=51.9 ms']
  const text = await run(
    $,
    `await ui.open({ id: "ping", data: { log: ${JSON.stringify(lines)}, plain: ["3", "x", "4.5"] }, view: h("Box", { flexDirection: "column" },
      h("Chart", { kind: "line", bind: "data.log", match: "time=([0-9.]+)" }),
      h("Chart", { kind: "spark", bind: "data.plain" })) })`,
  )
  expect(text).toContain('Script completed')
  const desktop = await mountPane($, 'ping', 'desktop')
  const alts = (await desktop.findAll({ type: 'Svg' })).map(found => String((found as { props?: { alt?: unknown } }).props?.alt))
  expect(alts).toEqual(['line chart of 2: min 47.3, max 51.9, last 51.9', 'spark chart of 2: min 3, max 4.5, last 4.5'])
  const bad = await run($, `await ui.open({ id: "p2", view: h("Chart", { kind: "line", values: [1], match: "(" }) })`)
  expect(bad).toContain('match must be a regular expression')
})

test('lines fit their values, bars start at 0, and min and max override', () => {
  const ping = [47.2, 48.1, 50.2]
  const line = range({ kind: 'line' }, ping)
  expect(line.lo).toBeGreaterThan(46)
  expect(line.lo).toBeLessThan(47.2)
  expect(line.hi).toBeGreaterThan(50.2)
  expect(line.hi).toBeLessThan(51)
  expect(range({ kind: 'bars' }, ping)).toEqual({ lo: 0, hi: 50.2 })
  expect(range({ kind: 'spark', min: 0, max: 100 }, ping)).toEqual({ lo: 0, hi: 100 })
  expect(range({ kind: 'line' }, [5, 5]).hi).toBeGreaterThan(5)
  expect(range({ kind: 'line' }, [])).toEqual({ lo: 0, hi: 1 })
})

/** Polls `read` until it passes `isDone`, as a handler's run finishes after the press that started it. */
async function until<T>(read: () => Promise<T>, isDone: (value: T) => boolean): Promise<T> {
  let value = await read()
  for (let i = 0; i < 400 && !isDone(value); i++) {
    await new Promise(resolve => setTimeout(() => resolve(undefined), 20))
    value = await read()
  }
  return value
}

test('a render draws the pane from its data on every change, and gets the width', async ($, on) => {
  stubEngine(on)
  const text = await run(
    $,
    `await ui.open({ id: "count", data: { n: 2 },
       render({ data, values, columns }) {
         const rows = []
         for (let i = 0; i < data.n; i++) rows.push(h("Text", {}, "row " + i))
         return h("Box", { flexDirection: "column" }, h("Text", { bold: true }, (values.who ?? "nobody") + " at " + columns), ...rows,
           h("Button", { key: "me", set: { "values.who": "me" } }, "Me"))
       } })
     await ui.set("count", "data.n", 3)
     return (await ui.get("count")).program.render.slice(0, 9)`,
  )
  expect(text).toContain('Script completed')
  expect(text).toContain('function ')
  const pane = await mountPane($, 'count')
  const texts = async () => (await pane.findAll({ type: 'Text' })).map(found => found.text)
  expect(await texts()).toEqual(expect.arrayContaining(['nobody at 60', 'row 0', 'row 1', 'row 2']))
  await pane.press({ key: 'me' })
  expect(await texts()).toContain('me at 60')
})

test('a render that fails fails ui.open, and one that fails later says so in the pane and in ui.get', async ($, on) => {
  stubEngine(on)
  const refused = await run($, `await ui.open({ id: "bad", render: ({ data }) => h("Text", {}, data.rows.length + " rows") })`)
  expect(refused).toContain('Script failed')
  expect(refused).toContain("render failed on the pane's values and data")
  const notView = await run($, `await ui.open({ id: "bad", render: () => h("Box", {}, h("Nope", {})) })`)
  expect(notView).toContain('no element Nope')

  await run($, `await ui.open({ id: "later", data: { rows: [] }, render: ({ data }) => h("Text", {}, data.rows.length + " rows") })`)
  const pane = await mountPane($, 'later')
  expect((await pane.findAll({ type: 'Text' })).map(found => found.text)).toContain('0 rows')
  await run($, `await ui.set("later", "data.rows", null)`)
  expect((await pane.findAll({ type: 'Text' })).map(found => found.text).join(' ')).toContain('render failed')
  const got = await run($, `return (await ui.get("later")).renderError`)
  expect(got).toContain('null')
})

test('a press runs the handler its emit names, which calls tools and sets data, instead of queueing', async ($, on) => {
  stubEngine(on)
  const commands: string[] = []
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    commands.push(String((e as unknown as { command: string }).command))
    return { result: { stdout: '42\n' }, text: '42' }
  })
  await run(
    $,
    `await ui.open({ id: "act", data: { answer: "?" },
       view: h("Box", {}, h("Text", { bind: "data.answer" }), h("Button", { key: "go", emit: "ask", data: { q: "life" } }, "Ask")),
       on: { ask: async ({ id, event }) => {
         const { text } = await tools.Bash({ command: "echo " + event.data.q })
         await ui.set(id, "data.answer", event.data.q + "=" + text)
       } } })`,
  )
  const pane = await mountPane($, 'act')
  await pane.press({ key: 'go' })
  const texts = await until(
    async () => (await pane.findAll({ type: 'Text' })).map(found => found.text),
    found => found.includes('life=42'),
  )
  expect(texts).toContain('life=42')
  expect(commands).toEqual(['echo life'])
  expect(await run($, `return (await ui.take("act")).length`)).toContain('0')
})

test('a failing handler shows its error under the view and in the record', async ($, on) => {
  stubEngine(on)
  await run($, `await ui.open({ id: "oops", view: h("Button", { key: "go" }, "Go"), on: { go: () => { throw new Error("no luck") } } })`)
  const pane = await mountPane($, 'oops')
  await pane.press({ key: 'go' })
  const texts = await until(
    async () => (await pane.findAll({ type: 'Text' })).map(found => found.text).join(' '),
    found => found.includes('no luck'),
  )
  expect(texts).toContain('on.go failed: no luck')
  expect(await run($, `return (await ui.get("oops")).error.in`)).toContain('on.go')
})

test('every runs on a timer while the pane is open, and pauses after failing three times in a row', async ($, on) => {
  stubEngine(on)
  await run(
    $,
    `await ui.open({ id: "tick", data: { n: 0 }, view: h("Text", { bind: "data.n" }),
       every: { ms: 1000, run: async ({ id, data }) => {
         await ui.set(id, "data.n", data.n + 1)
         throw new Error("enough")
       } } })`,
  )
  const pane = await mountPane($, 'tick')
  // The timer waits in real time, a second a period.
  const shown = () => until(async () => (await pane.findAll({ type: 'Text' })).map(found => found.text).join(' '), () => true)
  expect(await until(shown, text => text.includes('1'))).toContain('every failed: enough')
  await until(() => run($, `return String((await ui.get("tick")).error?.message)`), text => text.includes('paused'))
  const paused = await run($, `const p = await ui.get("tick"); return [p.data.n, p.program.every.paused, p.error.message]`)
  expect(paused).toContain('paused after 3 failures')
  expect(paused).toMatch(/^\s*3,$/m)

  const tooFast = await run($, `await ui.update("tick", { every: { ms: 10, run: () => {} } })`)
  expect(tooFast).toContain('ms at least 1000')
})

test('a method, an async method and an arrow keep source that compiles back to them', () => {
  // A method the interpreter made prints without its name or async.
  expect(sourceOf('({ data }) { return data * 2 }', 'render')).toBe('function ({ data }) { return data * 2 }')
  expect(sourceOf('() { await load() }', 'on.load')).toBe('async function () { await load() }')
  expect(sourceOf('({ data }) => data.n', 'render')).toBe('({ data }) => data.n')
  expect(() => sourceOf(Math.max, 'render')).toThrow('not a built-in one')
  expect(() => sourceOf('{ nope', 'render')).toThrow("not a function's source")
})

const IOSTAT = `              disk0       cpu    load average
    KB/t  tps  MB/s  us sy id   1m   5m   15m
   48.53  562 26.64  23 10 67  13.96 12.44 13.35
              disk0       cpu    load average
    KB/t  tps  MB/s  us sy id   1m   5m   15m
    9.41  990  9.09  37 18 46  14.20 12.51 13.37`

test('table reads columns under the header above them, skipping titles and repeated headers', () => {
  expect(table(IOSTAT)).toEqual([
    { 'KB/t': 48.53, tps: 562, 'MB/s': 26.64, us: 23, sy: 10, id: 67, '1m': 13.96, '5m': 12.44, '15m': 13.35 },
    { 'KB/t': 9.41, tps: 990, 'MB/s': 9.09, us: 37, sy: 18, id: 46, '1m': 14.2, '5m': 12.51, '15m': 13.37 },
  ])
  // Cells past the header's last join into it; a cell with a unit stays a string.
  const ps = table(['USER   PID  %CPU COMMAND', 'bl     123  12.5 /usr/bin/node server.js --port 3000', 'root   1    0.0  launchd'])
  expect(ps[0]).toEqual({ USER: 'bl', PID: 123, '%CPU': 12.5, COMMAND: '/usr/bin/node server.js --port 3000' })
  expect(table('free cmprssor\n 3007419K 41\n')).toEqual([{ free: '3007419K', cmprssor: 41 }])
  // Given names make every line a row, but one repeating them.
  expect(table('name,age\nbob,unknown\nann,30', { split: ',', header: ['name', 'age'] })).toEqual([
    { name: 'bob', age: 'unknown' },
    { name: 'ann', age: 30 },
  ])
  expect(table('a a b\n1 2 3')).toEqual([{ a: 1, a_2: 2, b: 3 }])
  // vm_stat repeats its title, which has a number in it, between samples.
  const vm = table([
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    '    free   active   specul inactive throttle    wired  prgable   faults     copy    0fill reactive   purged file-backed anonymous cmprssed cmprssor  dcomprs   comprs  pageins  pageout  swapins swapouts',
    '   11305  1724147     1924  1720352        0   665442     9455   154515    17209    60448        0        0     1156929   2289494  7712523  4189584     6043        0     2347        0        0        0 ',
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    '    free   active   specul inactive throttle    wired  prgable   faults     copy    0fill reactive   purged file-backed anonymous cmprssed cmprssor  dcomprs   comprs  pageins  pageout  swapins swapouts',
    '   15488  1726977      550  1724894        0   662420       25   179472    17004    68414       41     9545     1157895   2294526  7697105  4182425    18992     3207     6320        0        0        0 ',
  ])
  expect(vm.map(row => row.free)).toEqual([11305, 15488])
})

test('table is a global in scripts and in a render', async ($, on) => {
  stubEngine(on)
  const text = await run(
    $,
    `const rows = table("name,n\\nx,1\\ny,2", { split: /,/ })
     await ui.open({ id: "t", data: { lines: ["a b", "1 2", "3 4"] }, render: ({ data }) => h("Text", {}, table(data.lines).map(r => r.a + r.b).join(" ")) })
     return rows.map(r => r.name + r.n).join(" ")`,
  )
  expect(text).toContain('x1 y2')
  const pane = await mountPane($, 't')
  expect((await pane.find({ type: 'Text' }))?.text).toBe('3 7')
})

test('ui.stream runs a command in the background and follows it; unfollowing stops the command', async ($, on) => {
  stubEngine(on)
  const spawned: (readonly string[])[] = []
  const bashCalls: unknown[] = []
  stubTask(on, ['  us sy\n', '  10 5\n'], spawned, 2000, bashCalls)
  const stopped: unknown[] = []
  on('tool.call', { tool: 'TaskStop' }, (_$, e) => {
    stopped.push((e as unknown as { task_id: string }).task_id)
    return { result: { message: 'stopped', task_id: 'b1', task_type: 'local_bash' }, text: 'stopped' }
  })
  const text = await run(
    $,
    `await ui.open({ id: "cpu", render: ({ data }) => h("Text", {}, String(table(data.io ?? []).at(-1)?.us ?? "-")) })
     return JSON.stringify(await ui.stream("cpu", "iostat -w 1", { to: "data.io", max: 300, status: "data.state" }))`,
  )
  expect(text).toContain('"task":"b1"')
  expect(text).toContain(`"file":"${TASK_FILE}"`)
  // Claude Code's longest background limit, not its 30-minute default.
  expect(bashCalls[0]).toMatchObject({ command: 'iostat -w 1', run_in_background: true, timeout: 7_200_000 })
  expect(await run($, `await ui.stream("cpu", "iostat", { to: "data.x", timeout: 9e9 })`)).toContain('timeout is the command\'s limit in ms')
  expect(spawned[0]).toEqual(['tail', '-c', '+1', '-f', TASK_FILE])
  const pane = await mountPane($, 'cpu')
  expect(await until(async () => (await pane.find({ type: 'Text' }))?.text, found => found === '10')).toBe('10')
  expect(await run($, `return (await ui.get("cpu")).follows[0].task`)).toContain('b1')

  await run($, `await ui.unfollow("cpu")`)
  expect(stopped).toEqual(['b1'])
})

test('ui.follow right after the command starts finds its output file', async ($, on) => {
  stubEngine(on)
  stubTask(on, ['hello\n'], [], 200)
  const text = await run(
    $,
    `await ui.open({ id: "quick", view: ${FOLLOW_VIEW} })
     const started = await tools.Bash({ command: "make", run_in_background: true })
     return JSON.stringify(await ui.follow("quick", "${TASK_FILE}"))`,
  )
  expect(text).toContain('{"following":true}')
})
