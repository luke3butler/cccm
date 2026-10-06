# Claude Code codemode

Vibecoded [pi-style codemode](https://pi.dev/docs/latest/codemode) tool for Claude Code. The model writes a JavaScript script, which runs in a sandbox and calls Claude Code's tools, MCP tools included. Only the script's output reaches the model, so the model can run calls in parallel, chain them, and filter or aggregate large results without filling its context.

The plugin registers one tool, `mcp__codemode__run`, and two commands: `/codemode` runs a [saved script](#saved-scripts), and `/codemode-pane` opens a pane.

## Installing it

The repository is a marketplace, `cc-code-mode`, with one plugin, `codemode`. To install it from GitHub for every session:

```sh
claude plugin marketplace add luke3butler/cccm
claude plugin install codemode@cc-code-mode
```

To update it later:

```sh
claude plugin marketplace update cc-code-mode
claude plugin update codemode@cc-code-mode
```

### Working on it

To load a clone for one session, so a change shows after `/reload-plugins`:

```sh
claude --plugin-dir /path/to/cccm
```

An installed plugin is a copy, so a change reaches installs only once it is pushed with `version` bumped in both `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.

## Checking it

```sh
claude plugin validate .                            # the marketplace
claude plugin validate .claude-plugin/plugin.json   # the plugin, hooks included
claude plugin test .
bun scripts/smoke.ts
```

`bun scripts/smoke.ts` runs the runner against a fake host, outside Claude Code.

## What a script has

### Inputs

| Input | Default | What it does |
|---|---|---|
| `script` | one of `script` and `name` | Raw JavaScript, run as the body of an async function: top-level `await` and `return` work |
| `name` | | A [saved script](#saved-scripts) to run in place of `script` |
| `args` | `{}` | Values the script reads as the `args` global. Text it passes on (markdown, code, anything with quotes, backticks or backslashes) goes here rather than into the script as a string literal, so it needs no escaping. A saved script's are checked against its `meta` |
| `max_output_tokens` | 10000 | Output past it keeps its start and end, and the full text goes to a temp file. At most 12000: Claude Code saves a result past about 50,000 characters to a file and shows only a preview, so a higher value is lowered, and the result says so when it matters |
| `timeout_ms` | unset | A wall-clock deadline for the whole script, tool calls included |

A first line `// @options: {"max_output_tokens": 2000, "timeout_ms": 60000}` sets the same options from inside the script; a parameter of the same name wins.

### Globals

| Global | What it gives |
|---|---|
| `tools.<name>(args)` | Calls any tool Claude Code can call, MCP tools included, through the same permission checks and hooks as a direct call. Characters that aren't valid in an identifier become `_`. A hyphenated name written as is (`tools.mcp__tl-dv__list-meetings(...)`, which JavaScript reads as a subtraction) is joined back into the tool's name before the script runs |
| `ALL_TOOLS` | Every callable tool as `{ name, call, description }`, `call` being how a script writes it (`tools.mcp__tl_dv__list_meetings`) |
| `session` | `{ id, cwd, projectDir, repo, turns }`, read once per run. `repo` is `{ root, remote }`, or `null` outside a git repository; `turns` is how many prompts the person has sent |
| `session.usage({ breakdown?, columns? })` | `$.session.usage` as the engine answers it: `{ startedAt, context, rateLimits, cost }`. `breakdown: "full"` sends a token-count request per tool and memory file, as /context does; `"summary"` estimates locally |
| `session.messages({ agentId?, as? })` | `$.session.messages` as the engine answers it: the newest 4096 messages as `{ role, text, toolUses, toolResults? }`, or `{ role, content }` with `as: "api"`; with `agentId`, that agent's, or `{ deny }` |
| `models.complete({ prompt, model?, system?, maxTokens?, effort? })` | One completion through the session's own client, with no tools or history. Resolves `{ text, usage }`; rejects when no reply came |
| `models.classify(text, labels, { model? })` | The one of `labels` (two or more) a small, fast model picks, or `undefined`; one model call per text. For many items, one `complete` call labelling a batch as JSON is faster, cheaper and more consistent (`help("models")` has the recipe) |
| `text(value)`, `console.log(...)` | Add to the output: strings as they are, other values as JSON. A top-level `return` adds its value the same way |
| `image(value)` | Adds an image after the text, from a `data:` URL, an MCP or API image block, or what `tools.Read` resolves to for an image file |
| `sleep(ms)` | Resolves after `ms` milliseconds |
| `exit()` | Ends the script successfully |
| `store(key, value)`, `load(key)` | JSON values kept across runs in this session, a resumed one included: up to 256K characters each and 1M in all, so a small reply can be kept for a later script rather than fetched again (`writeFile` a larger one). Writes are kept only when the script succeeds, and only the keys it wrote, so scripts running side by side keep each other's; `undefined` deletes |
| `shape(value)` | The value's outline as a TypeScript-like type: `{ id: string; tags?: string[] }[]`. An array's items merge into one type, a key some lack marked `?` |
| `writeFile(path, value)`, `readFile(path)` | `writeFile` is a `tools.Write` call: a string as it is, any other value as JSON; a relative path is from the session's directory; resolves to the path. `readFile` resolves a file's text, up to 4 MiB, past Read's 256 KB limit. A file codemode saved (a long output, a failed script's reply) or Claude Code saved from this session's tool calls is read as it is; any other first goes through a `tools.Read` from past its end, which reads nothing, so Read's rules, hooks and dialog decide |
| `table(text, { split?, header? })` | Command output in columns (iostat, ps, df, CSV) as rows keyed by its header line, plain numbers as numbers |
| `ui`, `h()` | Panes beside the transcript; see [Panes](#panes) |
| `args` | The `args` parameter, `{}` when none; a saved script's are checked against its `meta` (see [Saved scripts](#saved-scripts)) |
| `help(topic?)` | The long form of the reference: `help()` lists the topics (`tools`, `output`, `models`, `panes`, `saved`), `help("panes")` returns one with worked examples |

The reference in the `script` parameter's description is in the model's context every turn, so it keeps the signatures and the rules that change how the model works (such as not waiting on the person) and points at a topic for the rest. A topic is read only when a script asks for it.

### What tool calls resolve to

| Call | Resolves to | On failure |
|---|---|---|
| Built-in tool | `{ text, result }`: `text` is what the model would read, `result` the tool's structured record (for Bash: `stdout`, `stderr`, ...; for Read, `file.content` is the raw text) | Rejects with the tool's error text, denied calls included |
| MCP tool | `{ content, structuredContent, text, json }`, `json` being `structuredContent` when the server sends one, else `text` parsed when all of it is one JSON object or array. Text that is JSON and more has no `json`, and the script reads `text` | Rejects with the server's error text, denied calls included; the error's `result` holds the whole reply |
| Long output | `text` (and Bash's `result.stdout`) hold the whole output, up to 4 MiB; `fullOutputPath` names the saved file. An MCP result Claude Code replaced with a notice naming its file is read back from that file, found by where it is (this session's `tool-results` folder), when it was written (during the call) and its size, not by the notice's wording | Rejects when the result looks like such a notice but its file can't be found or read, and logs a line saying so, so a script never takes the notice for data |
| Read of a file the conversation already holds | The file's text in Read's numbered-line format, not Claude Code's "file unchanged" stub | |

`Promise.allSettled()` keeps the calls that succeed. A rejection for arguments the tool refused (an MCP server's `-32602`, Claude Code's `InputValidationError`) adds where the tool's schema is: a ToolSearch call of the model's own.

### Tools' arguments

Codemode doesn't describe tools' arguments: the model learns them the way it does for a direct call. A tool in its tool list comes with its schema; one behind ToolSearch, as most MCP tools are, needs a ToolSearch call first (`select:<name>,<name>` loads several, keywords find them), made by the model itself, since a ToolSearch call from a script returns names to the script and loads nothing. That costs no prompt cache: the schema reaches the model as a reference in that call's result, and the tool list at the head of the prompt never changes.

Plugins can't read tools' schemas: `$.tool.list()` gives names and descriptions, and the declarations Claude Code lays in `.claude-plugin/types/` exist only for a plugin loaded from a folder of the person's own (`--plugin-dir`), never for an install.

### The result

- **Header:** "Script completed" or "Script failed", the run time, then the tool calls, model calls (with tokens, when reported) and images.
- **A failed script:** keeps its partial output and ends with "Script error:". A runtime error also names the line that ran last ("near line N"). Then come the calls the script made (the latest 20), each ok, failed or cancelled, so a retry knows what already took effect. Tool calls still running when the script failed get up to 5 s to end (not after a timeout or an interrupt, and not at all when none is running): one that ends in time shows how it ended, marked "(ended after the error)", and the rest are cancelled. Under each MCP call that succeeded is an outline of its reply (`json: { issues: { key: string }[]; total: number }`, or a note that the text isn't JSON), shown once per tool and outline, so a retry knows the reply's shape without calling the tool again to look. Each of those replies is also saved (its `json`, or its text), its path after the call, for the retry to read with `readFile()` rather than call again: some calls cost money or change things.
- **Saved outputs:** when Claude Code saved any of the script's tool outputs to files, the result ends with a list of them: the call's number in the script, the tool, its args and the file, so a later script can read one back with `readFile()`, or filter a larger one with `tools.Bash`, without calling the tool again. Past 10, the rest are counted and the whole list, with each call's full args, is saved to a file of one JSON object per line, named in the result.
- **Plain text:** colours and other escape sequences in the output are removed, and a line a carriage return rewrote (a progress bar) keeps what a terminal would show last. They cost the model tokens and say nothing to it, and Claude Code refuses to draw text that holds them, in the result and in a pane alike.

### Limits

| Limit | Value |
|---|---|
| CPU time | About 8 s of interpreter time; waiting on tools doesn't count |
| Deadline | `timeout_ms`, even in the middle of a tool call |
| Model calls | 4 at once (the rest queue), 200 per script |
| Images | 20 per script, 5 MB of base64 each; PNG, JPEG, GIF or WebP |
| Store | 262144 characters per value, 1048576 in all |
| Stuck promises | A script awaiting a promise nothing can settle fails at once |
| Calls still running at the end | Cancelled (after a failed script's 5 s wait); what they already did stands. Bash's `run_in_background` starts what should outlive the script |
| Nesting | A script can't start another codemode script |
| Environment | No Node APIs, file system, network or timers: everything goes through `tools` |

### The row in the transcript

The tool's row shows the script, folded to 8 lines with a button that shows all of it; a saved script run by name shows its name in the title, and args, inline or saved, show below as one line. Below it are the latest 8 nested calls, with live status (running, ok, failed, cancelled) and duration. A failed script's row has a red bullet and says "script failed" (Claude Code itself draws the call as a success, since a plugin's tool can't answer with an error).

The result under the row is codemode's too: the output without its header line (the row's title has the counts), the first 5 lines with a button that shows the rest, and a failed script's error and calls in full. A result with images, and a call Claude Code itself refused or interrupted, keep Claude Code's own result block.

Under the result are the file changes the script's Bash, Edit and Write calls made, drawn as Bash's own row draws them: the path with its counts, then the first 40 lines of each change (10 files at most, the rest counted). Claude Code reports these changes beside a call's result, never to the model, and the script's output doesn't carry them either. They're for display only, kept in the session's state, so a resumed session shows the result without them.

## Saved scripts

A script worth running again is saved as a file and run by name, by the model or by you:

- **Where:** `<name>.js` in `.claude/codemode/` under the project root (checked in with the project) or in `~/.claude/codemode/` (yours, in every project). The project's wins a name both have.
- **Shape:** an optional `export const meta = { description, args }` of plain literals comes first, then the script as the model would send it, with the same globals and permission checks. The script reads its args as `args`:

  ```js
  export const meta = {
    description: 'Ping a host and report the round trips',
    args: { host: { type: 'string', required: true }, count: { type: 'number', default: 4 } },
  }
  const out = await tools.Bash({ command: `ping -c ${args.count} ${args.host}` })
  return out.text
  ```

  Arg types are `string`, `number`, `boolean`, `object` and `array`. An arg `meta` doesn't declare is refused, a required one must be given, and defaults fill the rest. Without `meta.args`, `args` is whatever object was given.
- **The model** runs one with the tool's `name` and `args` in place of `script`. The `name` parameter's description lists the saved scripts with their args and descriptions, so the model runs one rather than writing it again. The listing is registered again at the next prompt after the folders change, and only then, so the tool list stays as the prompt cache has it. A run reads the file when it runs, so a script saved this turn runs at once.
- **You** run one with `/codemode <name> [args]`, with no model turn: `/codemode ping example.com count=2`. Words fill the args in `meta`'s order, `key=value` names one, quotes keep spaces, and a JSON object gives them all. The output shows as the command's, and the model reads it too. A pane it opens seats at any width, since you asked for it. `/codemode` alone lists the saved scripts and any that don't load.
- A pane a saved script opens keeps the code it opened with, so editing the file changes the next run, not an open pane.

## Panes

A script can open panes beside the transcript with the `ui` global. A pane outlives the script that opened it: it is a record in `$.state` that the plugin's `Pane` hook draws, the person's presses write to, and later scripts read and change by id, in later turns too.

Feedback is asynchronous by default. To ask the person something, the script opens a pane with an `ask` and a `push: "wake"` button, then returns, and the model ends its turn. The person answers when they are ready: the press queues a turn whose message holds the question, their values and what they did, with those events marked read. Nothing waits, so nothing times out. `ui.wait` remains for a quick confirmation within a turn, capped at 2 minutes.

A record holds four parts, each written by one side:

| Part | Written by | Holds |
|---|---|---|
| `view` | scripts (`ui.open`, `ui.update`), or the pane's `render` | A tree of plain-data elements from `h()`: Box, Text, Button, Input, Select, Markdown, Code, Link, Chart, Image |
| `values` | the person | What bound Inputs and Selects hold, and what a Button's `set` writes |
| `data` | scripts (`ui.set`, `ui.append`) | What bound Text, Code and Markdown draw (`bind: "data.log"`, `tail: 50`) |
| `inbox` | the person | Presses, Enters and picks of elements with `emit` or a `push`, and closing the pane, until a script reads them with `ui.take` or `ui.wait` |

- **Views are checked when set.** A view with an unknown element or prop, a missing key or a bad path fails the script, naming the place in the tree. Code and Markdown text is clipped to 10,000 characters. All text a pane draws is plain text, as a script's output is.
- **Writes coalesce.** Changes made while a write is in flight land together, so a script can call `ui.append` in a loop. The script's result waits for writes it did not await.
- **How a press reaches the model** is the element's `push`: `queue` (the default) keeps the event in the inbox, and every prompt the person sends carries a note naming panes with unread events. `wake` queues a turn carrying the answer as it stood at the press, its events marked read; further presses before that turn starts stay in the inbox, and the next prompt's note names them. `draft` fills the person's prompt box from a template (`prompt: "Fix {values.picked}"`) and sends nothing.
- **Waits spend no hook budget.** A hook has 10 s of its own time and `$.clock` waits count against it, so `ui.wait` and `sleep()` wait in short `sleep` processes instead (macOS and Linux only).
- **Streams.** `ui.stream(id, command, { to, max, status, timeout })` does the next item's two steps in one call: it starts the command through Bash with `run_in_background` (so the permission check applies) and follows its output file. The pane owns the command: `ui.unfollow`, `ui.remove` or a second stream to the same path stops it through `TaskStop`. Claude Code stops a background command at its timeout, 30 minutes unless given, so a stream asks for the most it allows, 2 hours (`timeout` in ms for less). After that, `status` reads `killed`, and running the script again restarts it. It records the output file itself, since the Bash hook's note of the file isn't always readable by the time the stream starts following.
- **`table(text)`** turns command output in columns into rows keyed by its header line, for scripts and `render`. A header is a line with no plain number in it; a later one replaces it, so title lines and repeated headers (iostat, vm_stat) are skipped. A line shorter than the header and mostly words is skipped too, for a title with a number in it (vm_stat repeats "page size of 16384 bytes"). Plain numbers become numbers, and extra cells join the last column (ps's `COMMAND`).
- **Live output from background commands.** The model runs a long command with Bash's `run_in_background`, then a script calls `ui.follow(id, outputFile, { to: "data.log", status: "data.state" })` with the output file the result names. The plugin runs `tail -f` on that file and appends each line to the pane as the task writes it, after the script and the turn have ended. A carriage-return progress line keeps its latest text. The task's notification ends the follow, and `status` then reads how it ended, such as `completed (exit code 0)`; `ui.unfollow(id)` stops it sooner. The command still runs through Bash and its permission check: a follow only reads, and only the output files that this session's background Bash commands reported (the plugin notes each one as the command starts, so `/clear` doesn't lose them). A reload follows on from where it had read to.
- **Charts and images.**
  - **`Chart`** (`spark`, `bars` or `line`) draws its values, inline or bound to a data path. On the terminal it uses cells: eighth blocks for bars and sparklines, braille dots for lines. On other surfaces it draws an SVG.
  - **`Image`** takes a PNG file path or data URL. It shows pixels where the terminal can (kitty, Ghostty) and its required `alt` elsewhere. On desktop, a data URL is drawn as an SVG.
  - The plugin checks a PNG's signature and header before drawing it, because the engine refuses a whole pane over a bad one.
  - The first drawn Image tells the plugin whether this terminal shows pixels: a blit of its own source is denied, naming the alt, where pixels don't show.
- **Code a pane carries.** `ui.open` takes three kinds of function, kept in the record as source text so they run after the script ends and survive a reload:
  - **`render({ id, values, data, surface, columns })`** returns the view, and runs each time the pane draws. It is synchronous, gets 250 ms, and has `h` and `table` as its only globals. `ui.open` and `ui.update` run it once, so a render that throws fails the script; one that throws later on new data draws its error in the pane, and `ui.get(id)` reports it as `renderError`.
  - **`on: { name: fn }`** handlers. A press, Enter or pick whose `emit` (else its key) names a handler runs it, and the event skips the inbox.
  - **`every: { ms, run }`** runs on a timer, at least a second apart, while the pane is open. A run still going skips the next period. It is for slow polling: each run is a script and a tool call, about 0.1 s before the command's own time.

  Live data streams instead: `ui.stream(id, "iostat -w 1", { to: "data.io" })` runs one command that prints a line per sample and follows it into the pane, and `render` parses the lines with `table()`. Measured with a CPU and memory pane, a 2-second `every` running `iostat` drew a sample about every 3 s; `iostat -w 1` followed drew one each second.

  Handlers and timer runs are scripts of their own, with the same globals and permission checks as any script, run on `session.start`'s `$` as follows are. They don't see the defining script's variables. A pane's runs share 30 tool calls a minute, and each run gets 60 s, with 2 s of interpreter time between awaits. A failure shows under the view and as `error` in the record; three timer failures in a row pause it until `every` is set again. The interpreter prints a method without its name or `async`, so the plugin restores `function` or `async function` by trying each parse.
- **Showing by state:** any element takes `when: { "values.tab": "logs" }`. The element draws only while each path equals the value, is one of a list, differs under `{ not }`, or is present under `{ exists: true }`. Tabs and error lines need no script.
- **Hover:** a Box with a `key` is a hover scope. `hover` props on it and on what's beneath it restyle as the pointer moves, and `display: "flex"` reveals a Box drawn `display: "none"`. A `position: "absolute"` Box placed with `top` and `left` makes a card that moves nothing. The engine applies all of it, so no hook runs.
- **Fallbacks:** `ui.open` resolves `fallbacks` for anything the session's surfaces won't draw as written, such as an Image on a terminal without pixels or an Input on mobile. That way the model doesn't assume the person saw it.
- **Placement:** a pane the model opens counts as unasked, so the terminal places it from 144 columns only (110 if it was opened before). The person can open it at any width with `/codemode-pane [id]`.
- **Limits:**
  - 20 panes per session, and 100 events per inbox (the oldest dropped).
  - 64 KiB of JSON per view and 512 KiB per record. A followed list past the record's limit drops its oldest half.
  - 10 follows at once.
  - A view nests at most 24 deep, and a string in it holds at most 10,000 characters.
  - A drawing holds about 90,000 characters of text, and bound text past that is cut. The engine refuses a tree past 100,000.
  - An Image's PNG decodes to at most 2 MiB.

Not built yet: records kept across `--resume` (`$.state` alone holds them), and feeds other than a background task's output file and what a pane's own timer fetches.

## Plugin APIs scripts can't reach

Parts of Claude Code's plugin API (`$`) that codemode doesn't pass to scripts.

| Area | Not available | API |
|---|---|---|
| Session | The session's model | `$.session.model` |
|  | Which surfaces the session draws on (terminal, desktop, ...) | `$.session.surfaces` |
|  | Claude Code's version | `$.session.version` |
|  | Compacting the conversation | `$.session.compact` |
|  | Appending a message to the transcript | `$.session.append` |
|  | Sending a message to a running agent | `$.session.send` |
|  | The session's API authorization | `$.session.authorize` |
| Turns and prompts | Aborting the turn | `$.turn.abort` |
|  | Reading, filling or submitting the prompt box | `$.prompt.read`, `$.prompt.fill`, `$.prompt.submit` |
|  | Suggesting a next prompt | `$.prompt.suggest` |
|  | Changing the system prompt | `$.prompt.compose` |
| Models | A model call that inherits the session's context | `$.model.fork` |
| Agents | Spawning, listing and registering subagents | `$.agent.spawn`, `$.agent.list`, `$.agent.register` |
| Tools | Asking whether a call would be allowed before making it | `$.tool.check` |
|  | Registering new tools | `$.tool.register` |
|  | Connecting an MCP server | `$.mcp.connect` |
| Commands | Listing and running slash commands | `$.command.list`, `$.command.run` |
|  | Registering slash commands | `$.command.register` |
| Settings | Reading settings | `$.settings.read` |
|  | Listing and changing config | `$.config.list`, `$.config.set` |
| Display | Toasts and status-line text | `$.ui.toast`, `$.ui.status` |
|  | Notes on a tool's row | `$.ui.notice` |
|  | Transcript and debug-log lines | `$.ui.log` |
|  | Asking the user a question | `$.ui.ask` |
|  | Drawing panes of their own (scripts open panes through `ui`, see [Panes](#panes)) | `$.ui.open`, `$.ui.close`, `$.ui.panes` |
|  | Focusing and scrolling | `$.ui.focus`, `$.ui.scroll` |
|  | Copying to the clipboard | `$.ui.copy` |
| Audio | Playing sounds and speaking text | `$.audio.play`, `$.audio.speak` |
| Time | Timers that run after or every N ms | `$.clock.after`, `$.clock.every` |
| State | Live values shared with the plugin's drawings | `$.state` |
|  | Values kept across sessions | `$.store` |
| Direct access | Files, processes, HTTP and environment variables, outside the tools' permission checks | `$.fs`, `$.process`, `$.http`, `$.env` |
|  | The plugin's own directory | `$.plugin.root` |
| Telemetry | Telemetry events and marks | `$.telemetry.log`, `$.telemetry.mark` |

## License

MIT; see [LICENSE](LICENSE). The vendored [Sval](https://github.com/Siubaak/sval) interpreter (`hooks/vendor/sval.js`) is MIT too, under its own license file.
