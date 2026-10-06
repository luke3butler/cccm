import type { ToolCallArgs, ToolInfo } from 'claude-code'
import { expect, test, type Engine } from 'claude-code/testing'
import { argsOf, commandArgs, listSaved, parseSaved, savedListing, savedPlaces, type SavedFs } from '../hooks/saved'

const TOOLS: ToolInfo[] = [
  { name: 'Bash', description: 'Run a shell command.', mcp: false },
  { name: 'mcp__codemode__run', description: 'This tool.', mcp: false },
]

type TestOn = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]

const PING = `// @options: {"timeout_ms": 30000}
export const meta = {
  description: "Ping a host",
  args: {
    host: { type: "string", required: true, description: "host name" },
    count: { type: "number", default: 4 },
    quiet: "boolean",
  },
}
return { host: args.host, count: args.count, quiet: args.quiet ?? false, about: meta.description }`

/** A session at /work with HOME /home/me, and `files` as the saved-script folders' contents. */
function stubSaved(on: TestOn, files: Record<string, string>): void {
  on('tool.list', () => ({ value: TOOLS }))
  on('session.id', () => ({ value: 'test-session' }))
  on('store.get', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.root', () => ({ value: '/work' }))
  on('session.repo', () => ({ value: null }))
  on('session.turns', () => ({ value: 1 }))
  on('env.get', (_$, e) => ({ value: (e as { name?: string }).name === 'HOME' ? '/home/me' : undefined }))
  const dirOf = (path: string) => path.replace(/\/$/, '')
  on('fs.exists', (_$, e) => {
    const path = dirOf((e as { path: string }).path)
    return { value: Object.keys(files).some(file => file === path || file.startsWith(`${path}/`)) }
  })
  on('fs.list', (_$, e) => {
    const dir = dirOf((e as { path: string }).path)
    const names = Object.keys(files)
      .filter(file => file.startsWith(`${dir}/`) && !file.slice(dir.length + 1).includes('/'))
      .map(file => ({ name: file.slice(dir.length + 1), kind: 'file' as const, size: files[file]!.length, mtimeMs: 1, isLink: false }))
    return { value: names }
  })
  on('fs.read', (_$, e) => {
    const text = files[(e as { path: string }).path]
    if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return { value: text }
  })
}

async function run($: Engine, input: Record<string, unknown>): Promise<string> {
  const ran = await $.tool.call({ tool: 'mcp__codemode__run', ...input } as unknown as ToolCallArgs)
  return String(ran.result)
}

test('parseSaved reads the meta and keeps it in the script as const meta, lines in place', () => {
  const { meta, script } = parseSaved(PING, 'ping')
  expect(meta.description).toBe('Ping a host')
  expect(meta.args?.host).toEqual({ type: 'string', required: true, description: 'host name' })
  expect(meta.args?.quiet).toEqual({ type: 'boolean' })
  expect(script.split('\n')[1]).toBe('       const meta = {')
  expect(script.split('\n').length).toBe(PING.split('\n').length)

  expect(parseSaved('return 1', 'plain')).toEqual({ meta: {}, script: 'return 1' })
  expect(() => parseSaved('export const meta = { description: `a ${1}` }', 'x')).toThrow('not a plain literal')
  expect(() => parseSaved('export const meta = { args: { n: "date" } }', 'x')).toThrow("type is one of")
  expect(() => parseSaved('export const meta = { args: { n: { type: "number", default: "4" } } }', 'x')).toThrow('default is not a number')
  expect(() => parseSaved('export const meta = { nope: 1 }', 'x')).toThrow('not nope')
  expect(() => parseSaved('const a = 1\nexport const meta = {}', 'x')).toThrow('only export')
})

test('argsOf checks args against the meta and fills the defaults', () => {
  const { meta } = parseSaved(PING, 'ping')
  expect(argsOf(meta, { host: 'a' }, 'ping')).toEqual({ host: 'a', count: 4 })
  expect(() => argsOf(meta, {}, 'ping')).toThrow('ping needs the arg "host" (string: host name)')
  expect(() => argsOf(meta, { host: 'a', count: '2' }, 'ping')).toThrow('arg "count" is a number')
  expect(() => argsOf(meta, { host: 'a', port: 1 }, 'ping')).toThrow('has no arg "port"; its args are host, count, quiet')
  expect(() => argsOf({ args: {} }, { a: 1 }, 'none')).toThrow('none takes no args')
  expect(argsOf({}, { anything: [1] }, 'free')).toEqual({ anything: [1] })
})

test('commandArgs reads words in order, key=value, quotes and JSON', () => {
  const { meta } = parseSaved(PING, 'ping')
  expect(commandArgs(meta, 'example.com 2 yes', 'ping')).toEqual({ host: 'example.com', count: 2, quiet: true })
  expect(commandArgs(meta, 'count=3 example.com', 'ping')).toEqual({ count: 3, host: 'example.com' })
  expect(commandArgs(meta, '"a host" quiet=no', 'ping')).toEqual({ host: 'a host', quiet: false })
  expect(commandArgs(meta, "host='b c'", 'ping')).toEqual({ host: 'b c' })
  expect(commandArgs(meta, '{"host": "b", "count": 1}', 'ping')).toEqual({ host: 'b', count: 1 })
  expect(() => commandArgs(meta, 'a 1 yes extra', 'ping')).toThrow('takes 3 args (host, count, quiet); "extra" is one more')
  // A count that isn't a number stays text, so argsOf names the problem.
  expect(() => argsOf(meta, commandArgs(meta, 'a many', 'ping'), 'ping')).toThrow('arg "count" is a number')
  expect(commandArgs({}, 'n=2 tags=["x"] name=bob', 'free')).toEqual({ n: 2, tags: ['x'], name: 'bob' })
})

test("a project's script hides the person's of the same name, and one that doesn't load is listed with why", async () => {
  const files: Record<string, string> = {
    '/work/.claude/codemode/ping.js': PING,
    '/work/.claude/codemode/broken.js': 'export const meta = { args: 3 }',
    '/home/me/.claude/codemode/ping.js': 'export const meta = { description: "mine" }\nreturn 1',
    '/home/me/.claude/codemode/ports.js': 'export const meta = { description: "Listening ports" }\nreturn 2',
    '/home/me/.claude/codemode/notes.txt': 'not a script',
  }
  const fs: SavedFs = {
    list: async dir => Object.keys(files).filter(file => file.startsWith(`${dir}/`)).map(file => file.slice(dir.length + 1)),
    read: async path => files[path]!,
  }
  const entries = await listSaved(fs, savedPlaces('/work', '/home/me'))
  expect(entries.map(entry => `${entry.name}:${entry.scope}`)).toEqual(['broken:project', 'ping:project', 'ports:personal'])
  expect(entries[0]!.error).toContain('meta.args is an object')
  const listing = savedListing(entries)
  expect(listing).toContain('- ping(host: string, count?: number, quiet?: boolean): Ping a host')
  expect(listing).toContain('- ports: Listening ports')
  expect(listing).not.toContain('broken')
})

test('the tool runs a saved script by name with its args checked', async ($, on) => {
  stubSaved(on, { '/work/.claude/codemode/ping.js': PING })
  const ran = await run($, { name: 'ping', args: { host: 'example.com' } })
  expect(ran).toContain('Script completed')
  expect(JSON.parse(ran.slice(ran.indexOf('{')))).toEqual({ host: 'example.com', count: 4, quiet: false, about: 'Ping a host' })

  expect(await run($, { name: 'ping' })).toContain('Script failed: ping needs the arg "host"')
  expect(await run($, { name: 'pong' })).toContain('Script failed: no saved script "pong". Saved: ping.')
  expect(await run($, { name: 'ping', script: 'return 1' })).toContain('not both')
  expect(await run($, { script: 'return 1', args: [1] })).toContain('Script failed: args is an object')
})

test('/codemode runs a saved script from the words typed, and alone lists them', async ($, on) => {
  stubSaved(on, {
    '/work/.claude/codemode/ping.js': PING,
    '/home/me/.claude/codemode/hello.js': 'return "hello " + (args.who ?? "you")',
  })
  const command = (args: string) => $.command.run({ command: 'codemode', args, origin: { kind: 'composer' } } as never)

  const ran = await command('ping example.com count=2')
  expect(ran.text).toContain('Script completed')
  expect(ran.text).toContain('"count": 2')
  expect((await command('hello who=Sam')).text).toContain('hello Sam')
  expect((await command('ping')).text).toContain('codemode: ping needs the arg "host"')

  const listed = (await command('')).text
  expect(listed).toContain('hello (personal)')
  expect(listed).toContain('ping (project) — Ping a host')
})
