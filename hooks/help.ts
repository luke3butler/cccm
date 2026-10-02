// What a script's help() returns: the long form of the script reference, by topic. The reference in the
// tool's schema is in the model's context every turn, so it keeps the signatures and rules; the detail and
// worked examples are here, read only when a script asks.

import { DEFAULT_APPEND_MAX, DEFAULT_WAIT_MS, MAX_FOLLOWS, MAX_PANES, MAX_STREAM_MS, MAX_WAIT_MS } from './panes'
import { MIN_EVERY_MS, RENDER_MS } from './programs'

/** The runner's limits the topics quote. */
export type HelpLimits = {
  defaultModel: string
  maxConcurrentModelCalls: number
  maxModelCalls: number
  maxImages: number
  defaultMaxOutputTokens: number
}

type Topic = { summary: string; text: (limits: HelpLimits) => string }

const TOPICS: Record<string, Topic> = {
  tools: {
    summary: 'result records, finding tools, commands too long to wait on',
    text: () => `# tools

Records beyond { text, result }:
- Bash: result.stdout, result.stderr, result.interrupted.
- Read: text has line numbers, result.file.content does not. Pass an image file's result to image().
- MCP: prefer structuredContent when the server sends it, else parse text; look at text.slice(0, 300) before parsing an unfamiliar tool's reply. A rejected MCP call's error.result holds the whole reply.
- fullOutputPath: the file Claude Code saved a long output to.
- Grep and Glob are not in every session; Bash with rg or find always is.

Keep the calls that succeed:
  const settled = await Promise.allSettled(files.map(f => tools.Read({ file_path: f })))
  const read = settled.filter(r => r.status === "fulfilled").map(r => r.value.result.file.content)

Finding tools: searchTools("calendar events", { limit: 5, namespace: "google" }), describeNamespace("tldv"), and describeTool(name).declaration before calling an MCP tool whose arguments you have not seen.

A command longer than a script should wait on (a build, a dev server): run it with Bash run_in_background and end your turn. Its notification starts your next one, and a pane can show its output live (help("panes")).`,
  },
  output: {
    summary: 'images, the output limit, calls left running',
    text: limits => `# output

- A top-level return of an object shows as pretty JSON.
- image(value) takes a data: URL, an image block ({ type: "image", data, mimeType }) or what tools.Read resolves to for an image file: PNG, JPEG, GIF or WebP, 5 MB of base64 each, ${limits.maxImages} per script. Never text() image data.
- Output past max_output_tokens (default ${limits.defaultMaxOutputTokens}) keeps its start and end; the result names the file holding all of it.
- Calls still running when the script ends finish, but their results are lost. A script awaiting a promise nothing can settle fails at once. timeout_ms ends a script mid-call.`,
  },
  models: {
    summary: 'defaults, limits and a worked example of models.complete and models.classify',
    text: limits => `# models

complete: no tools or history; model defaults to "${limits.defaultModel}", maxTokens to 1024; rejects when no reply came. classify: 2 or more labels; undefined when the model named none. At most ${limits.maxConcurrentModelCalls} calls run at once (the rest queue), ${limits.maxModelCalls} per script.

Return only what matters from many items:
  const labels = await Promise.all(issues.map(i => models.classify(i.title + "\\n" + i.body, ["bug", "feature", "question"])))
  return issues.filter((_, n) => labels[n] === "bug").map(i => i.title)`,
  },
  panes: {
    summary: 'elements, charts, images, hover, showing by state, binding, code a pane runs (render, on, every), asking the person, following background tasks, layout',
    text: () => `# panes

A pane is a record the plugin draws and keeps for the session; scripts in later turns change it by id. Its parts:
- view: elements from h(), set by ui.open and ui.update.
- values: written by the person (bound Inputs and Selects, a Button's set).
- data: written by scripts (ui.set, ui.append, ui.follow); bound elements draw it.
- inbox: the person's presses, Enters, picks and closing the pane, until ui.take reads them or a wake answer marks them read.

## Elements

h(type, props, ...children); children are strings or nodes. A bad element, prop, key or path fails the script, naming the place.
- Box: flexDirection, gap, columnGap, rowGap, padding*, margin*, width/height/minWidth/minHeight (number or "50%"), alignItems, justifyContent, flexGrow, flexWrap, borderStyle ("round", "single"), borderColor, backgroundColor, display; key, hover, position, top/left/right/bottom (see Hover).
- Text: strings and Text children, each string at most 10,000 characters. color, backgroundColor, bold, italic, underline, dimColor, inverse, wrap ("truncate-end"), hover.
- Button: key (required), label, variant ("primary" | "secondary"), plain, dimColor, hotkey; on press: emit, data, set: { "values.x": v }, close, push, prompt.
- Input: key (required), label, placeholder, submitLabel; bound to values.<key> unless bind: "values.x"; emit, push and prompt act on Enter.
- Select: key and options (required): ["a", "b"] or [{ value, label }]; bound like Input; a pick acts.
- Markdown: text, dimColor.
- Code: source, language, path, startLine, format: "diff", wrap.
- Link: href (https:, http: or file:), label.
- Chart: kind ("spark" | "bars" | "line"), values: [numbers] or bind (a list of numbers, { value } or number strings), match (a regex whose first group is each string's number: bind a followed log, match: "time=([0-9.]+)"), columns, rows (spark 1, else 6), color ("#rrggbb" or a name), min, max (lines and sparklines fit their values, bars start at 0, unless given), alt. Cells on the terminal, an SVG elsewhere; bound, it redraws as data arrives.
- Image: one of file (an absolute .png path), src (a data:image/png;base64, URL) or bind; alt, columns and rows (1-255 cells) required. Pixels where the terminal shows them (kitty, Ghostty), else the alt; on desktop a src draws, a file shows its alt.

Every element takes when: drawn only while the pane matches. Each path must equal the value, be one of a list, differ under { not: v }, or be present under { exists: true }:
  h("Button", { key: "logs", set: { "values.tab": "logs" } }, "Logs"),
  h("Code", { bind: "data.log", tail: 20, when: { "values.tab": "logs" } }),
  h("Text", { color: "red", when: { "data.error": { exists: true } }, bind: "data.error" })

## Binding

Text, Markdown and Code take bind: "data.log" in place of their content: a string as is, a list one item per line, anything else as JSON; tail: 30 keeps the last lines. Code and Markdown show at most 10,000 characters, colour codes removed. Paths are dotted ("data.rows.0.name"). ui.set(id, path, value) and ui.append(id, path, items, { max: ${DEFAULT_APPEND_MAX} }) coalesce, so call them in a loop.

## Hover

A Box with a key is a hover scope: while the pointer is over it, the hover props of it and of what's beneath apply. No hook runs and nothing reaches the inbox. Box hover: backgroundColor, borderColor, borderStyle, borderDimColor, display: "flex" (reveals a Box drawn display: "none"), top/left/right/bottom (move a position: "absolute" Box), scope (one name lights every member). Text hover: color, backgroundColor, bold, dimColor, inverse, underline. A card shown on hover, placed so it moves nothing:
  h("Box", { key: "row1", hover: { backgroundColor: "#334466" } },
    h("Text", {}, "auth.test.ts failed"),
    h("Box", { position: "absolute", top: -3, left: 24, display: "none", hover: { display: "flex" }, borderStyle: "round" }, h("Text", {}, "expected 200, got 401")))

## Code in a pane

ui.open takes functions the record keeps as source, so they run after the script ends and through a reload:
- render({ id, values, data, surface, columns }): returns the view (h() elements, a string, or a list), drawn in place of view each time values or data change. Synchronous, ${RENDER_MS} ms at most, h and table its only globals. ui.open runs it once and fails the script if it throws.
- on: { name: async ({ id, event, values, data }) => ... }: a press, Enter or pick whose emit (else its key) is a name runs that handler instead of queueing the event.
- every: { ms, run: async ({ id, values, data }) => ... }: runs every ms (at least ${MIN_EVERY_MS}) while the pane is open, skipping a period while the last run is still going. For slow polling (an API, a build status); each run is a script and a tool call, about 0.1 s before the command's own time.
Live data (CPU, memory, logs, pings, anything once a second) streams instead: ui.stream(id, "iostat -w 1", { to: "data.io" }) runs one command that prints a line per sample, and render parses the lines with table(). Each line reaches the pane as it is printed, with no tool call or script per sample.
Handlers and every.run are scripts of their own: tools, ui, h, models, sleep, store as here, but none of this script's variables; put what they need in data. Together they make at most 30 tool calls a minute, each run at most 60 s. A failure shows under the view and as error in ui.get(id); three in a row pause every (set it again to restart). ui.update changes render, on or every (null removes one); a ui.open with a view or any of them replaces all three.

  await ui.open({ id: "disk", data: { free: [] },
    render: ({ data, columns }) => h("Box", { flexDirection: "column" },
      h("Text", { bold: true }, "Free GB: " + (data.free.at(-1) ?? "…")),
      h("Chart", { kind: "line", values: data.free, columns: columns - 4 }),
      h("Button", { key: "clear" }, "Clear")),
    on: { clear: ({ id }) => ui.set(id, "data.free", []) },
    every: { ms: 10000, run: async ({ id }) => {
      const { text } = await tools.Bash({ command: "df -g / | tail -1 | awk '{print $4}'" })
      await ui.append(id, "data.free", [Number(text)], { max: 120 })
    } } })

Render is for what view, bind and when can't say: computed text, sorting, filtering, totals, a table from rows, numbers parsed out of followed lines:
  await ui.open({ id: "cpu", data: { io: [] }, render: ({ data, columns }) => {
    const cpu = table(data.io).slice(1).map(r => r.us + r.sy)   // iostat's first row is since boot
    return h("Chart", { kind: "line", values: cpu, min: 0, max: 100, columns: columns - 4 })
  } })
  await ui.stream("cpu", "iostat -w 1", { to: "data.io", max: 300 })

table(text or lines, { split?, header? }) gives rows of command output as objects keyed by its header line: { us: 37, sy: 18, ... }. A header is a line with no plain number in it, and a later one replaces it, so titles and repeated headers are skipped, as is a line shorter than the header that is mostly words (vm_stat's "page size of 16384 bytes" title). Plain numbers become numbers ("16384K" and "1m" stay strings), and extra cells join the last column (ps's COMMAND). split: "," or /\\t/ for other separators; header: ["a", "b"] names the columns of output that has no header line. It is a global in scripts and in render.

## Asking the person

push on a Button, Input or Select:
- "queue" (default): the event waits in the inbox; the person's next prompt notes it.
- "wake": queues a turn for you holding the ask, the values and what they did. Presses before that turn starts wait in the inbox.
- "draft": puts prompt ("Fix {values.picked}", filled from the pane) in the person's prompt box, sending nothing.

  await ui.open({
    id: "pick", title: "Failing tests", ask: "Which failures should I fix?",
    view: h("Box", { flexDirection: "column", gap: 1, padding: 1 },
      h("Select", { key: "which", options: failing }),
      h("Input", { key: "note", placeholder: "Anything else?" }),
      h("Box", { gap: 2 },
        h("Button", { key: "go", label: "Fix it", variant: "primary", push: "wake" }),
        h("Button", { key: "edit", label: "Let me write it", push: "draft", prompt: "Fix {values.which}: {values.note}" }))),
  })

ui.wait(id, { timeoutMs }) is for a quick confirmation within your turn: the events, or [] after timeoutMs (default ${DEFAULT_WAIT_MS}, at most ${MAX_WAIT_MS}).

## Following a background task

ui.stream(id, command, { to, max, status, description, timeout }) runs the command in the background through Bash (with its permission check) and follows its output into the pane: it resolves { following, task, file }. The pane owns the command: ui.unfollow(id, to), ui.remove(id) or another stream at the same path stops it (TaskStop). Claude Code stops a background command at its timeout: ${MAX_STREAM_MS / 3_600_000} hours, the default and the most it allows (timeout in ms for less). status then reads "killed"; run the script again to restart it.

  await ui.open({ id: "dev", title: "Dev server", view: h("Box", { flexDirection: "column", padding: 1 },
    h("Text", {}, h("Text", { bold: true }, "vite "), h("Text", { bind: "data.state", dimColor: true })),
    h("Link", { href: "http://localhost:5173/", label: "localhost:5173" }),
    h("Code", { bind: "data.log", tail: 30 })) })
  await ui.stream("dev", "npm run dev", { to: "data.log", max: 1000, status: "data.state" })

For a command already running (one you started with Bash run_in_background), ui.follow(id, outputFile, options) follows the output file its result names, and stopping the follow leaves the task running.

Lines arrive after your turn ends too; a progress line rewritten with carriage returns keeps its latest text. The task's notification ends the follow, and status reads how ("completed (exit code 0)", "killed"). ui.unfollow(id) stops the follow (and a streamed command). from: "start" (default) empties the list and reads the output so far; "end" reads only what comes next. Only the output files of background Bash commands this session started can be followed; pass the path as the result names it. Most tools, dev servers included, write plain lines when their output is a file; one that redraws by moving the cursor shows each redraw as new lines.

One follow per path: give each task its own, up to ${MAX_FOLLOWS} at once. A follow into a followed path replaces it; ui.unfollow(id, to) stops one. Two in one pane, side by side (stack them on a narrow terminal), or a pane each:

  h("Box", { gap: 2 },
    h("Box", { flexDirection: "column", width: "50%" }, h("Text", { bold: true }, "vite"), h("Code", { bind: "data.vite", tail: 20 })),
    h("Box", { flexDirection: "column", width: "50%" }, h("Text", { bold: true }, "tests"), h("Code", { bind: "data.tests", tail: 20 })))

## Layout and the rest

Panes are narrow: stack with flexDirection: "column", and put logs in a Code with tail.
- ui.open resolves { isPlaced, reason?, fallbacks? }; an open id is replaced, a closed one reopens (view optional then). A narrow terminal holds back a pane you open: when isPlaced is false, tell the person to run /codemode-pane <id>. fallbacks lists what won't draw as written on the session's surfaces (an Image without pixels, a field on mobile): say so rather than assume the person saw it.
- A drawing holds about 90,000 characters of text; bound text past that is cut. Views nest at most 24 deep.
- ui.update merges values and data. ui.get(id) resolves the whole record. ui.take(id) empties the inbox.
- ui.close(id) keeps the record; ui.remove(id) drops it and stops its follows. A session holds ${MAX_PANES} panes.`,
  },
  saved: {
    summary: 'saving a script to run again by name, with args',
    text: () => `# saved

A saved script is a file, <name>.js, in .claude/codemode under the project root (the project's, checked in with it) or in ~/.claude/codemode (the person's, in every project). The project's wins a name both have. Save one with Write when a script is worth running again; run it with the tool's name and args in place of script. The person runs it with /codemode <name> [args], with no turn of yours.

  // @options: {"timeout_ms": 30000}
  export const meta = {
    description: "Ping a host and report the round trips",
    args: {
      host: { type: "string", required: true, description: "host name or address" },
      count: { type: "number", default: 4 },
      quiet: "boolean",
    },
  }
  const out = await tools.Bash({ command: \`ping -c \${args.count} \${args.host}\` })
  return args.quiet ? out.text.split("\\n").slice(-3).join("\\n") : out.text

- meta is optional, and plain literals, before any other statement (the // @options: line and comments may come first). The script reads it as meta. Arg types: string, number, boolean, object, array; "boolean" alone is short for { type: "boolean" }.
- args holds what was given, checked: an arg meta doesn't declare is refused, a required one must be given, defaults fill the rest. Without meta.args, args is whatever object was given.
- The rest is a script like any other: the same globals and the same permission checks.
- Make one reusable through its args, not by editing it: ids, paths, hosts and limits as args with defaults.
- The person types /codemode ping example.com count=2: words fill the args in meta's order, key=value names one, quotes keep spaces, and a JSON object gives them all. Its output shows as the command's, and you read it too. /codemode alone lists the saved scripts and any that don't load.
- The name parameter's listing follows the folders at the next prompt. A run by name reads the file then, so one saved this turn runs at once.
- A pane a saved script opens keeps the code it opened with: render, on and every are copied into the pane, so editing the file changes the next run, not an open pane.`,
  },
}

/** help(): the topics and what each covers; help(topic): the topic's text. */
export function helpText(topic: unknown, limits: HelpLimits): string {
  const list = Object.entries(TOPICS)
    .map(([name, entry]) => `- help("${name}"): ${entry.summary}`)
    .join('\n')
  if (topic === undefined) return `Topics:\n${list}`
  const entry = TOPICS[String(topic).toLowerCase()]
  return entry === undefined ? `No help topic "${String(topic)}". Topics:\n${list}` : entry.text(limits)
}

export const HELP_TOPICS = Object.keys(TOPICS)
