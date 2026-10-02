/** A JSON value a script keeps with `store(key, value)`. */
export type CodemodeJson = string | number | boolean | null | CodemodeJson[] | { [key: string]: CodemodeJson }

/** One tool call a script made, as its row draws it. `left` is a call still running when the script ended. */
export type CodemodeCall = { tool: string; args: string; status: 'running' | 'ok' | 'error' | 'left'; ms?: number }

/** A script's tool calls so far: counts, and the most recent calls. */
export type CodemodeCalls = { total: number; failed: number; recent: CodemodeCall[] }

/** One hunk of a file change, as Bash's bashEditDiff and Edit's structuredPatch report it. */
export type CodemodeHunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }

/** One file change a script's tool call made, its lines cut to a limit (`cutLines` the rest). */
export type CodemodeFileDiff = {
  filePath: string
  hunks: CodemodeHunk[]
  added: number
  removed: number
  cutLines?: number
  created?: true
  deleted?: true
}

/** The file changes a script's tool calls made: the first ones, and how many more. */
export type CodemodeDiffs = { files: CodemodeFileDiff[]; more: number }

/** One element of a pane's view, as a script's h() builds it: plain data, drawn by the Pane hook. */
export type CodemodeNode = { type: string; props: { [key: string]: CodemodeJson }; children: (CodemodeNode | string)[] }

/** Something the person did in a pane that no script has read yet. */
export type CodemodePaneEvent = {
  type: 'press' | 'submit' | 'select' | 'closed'
  /** The element's key; absent on `closed`. */
  element?: string
  /** The name the element's `emit` prop gave the event. */
  emit?: string
  /** A Button's `data` prop. */
  data?: CodemodeJson
  /** The text an Input held, or the value a Select picked. */
  value?: string
  at: number
}

/** A background task's output file a pane follows: its new lines are appended to `to` as they are written. */
export type CodemodeFollow = {
  /** The task's output file, in the session's tasks folder. */
  file: string
  /** The list under data or values the lines are appended to. */
  to: string
  /** Lines kept in `to`. */
  max: number
  /** Where the follow writes its state ("following", "completed (exit code 0)", ...), when given. */
  status?: string
  /** Bytes of the file appended so far; a reload follows on from here. */
  offset: number
  state: 'following' | 'ended' | 'stopped'
  /** How the task ended, from its notification. */
  ended?: string
  /** The background task ui.stream started for this follow: stopping the follow stops it. */
  task?: string
}

/**
 * The code a pane carries, each function as its source: `render` draws the view from the pane's values
 * and data; each of `on` runs when a press, Enter or pick names it; `every.run` runs on a timer.
 */
export type CodemodeProgram = {
  render?: string
  on?: { [name: string]: string }
  /** `paused` once it failed too often in a row; setting `every` again starts it. */
  every?: { ms: number; run: string; paused?: true }
}

/** A pane a script opened: its view, the person's values, the scripts' data, and what happened in it since it was last read. */
export type CodemodePane = {
  id: string
  title: string
  /** What the pane asks the person, carried in the message their answer starts a turn with. */
  ask?: string
  /** What the pane draws; a `program.render` draws in its place. */
  view: CodemodeNode
  /** Written by the person: bound inputs and selects, a Button's `set`. */
  values: { [key: string]: CodemodeJson }
  /** Written by scripts: what bound Text, Code and Markdown show. */
  data: { [key: string]: CodemodeJson }
  inbox: CodemodePaneEvent[]
  /** Code the pane runs: a render, handlers, a timer. */
  program?: CodemodeProgram
  /** The latest failure of a handler or the timer (`in` names which), until that one next succeeds. */
  error?: { in: string; message: string; at: number }
  /** The task output files the pane follows, one per `to` path. */
  follows?: CodemodeFollow[]
  /** False once closed; the record stays, so a later script can read it or open it again. */
  isOpen: boolean
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    codemode: {
      calls: StateFamily<CodemodeCalls>
      isExpanded: StateFamily<boolean>
      isResultExpanded: StateFamily<boolean>
      /** The file changes each codemode call's tool calls made, by its tool_use_id. */
      diffs: StateFamily<CodemodeDiffs>
      /** Each script-opened pane's record, by pane id; null once removed. */
      pane: StateFamily<CodemodePane | null>
      /** The ids of the pane records this session holds, in creation order. */
      paneIds: string[]
      /** The output files of the background Bash commands this session started, newest last: what ui.follow may read. */
      taskFiles: string[]
      /** Whether this session's terminal shows an Image's pixels; null until a drawn Image tells. */
      pixels: boolean | null
    }
  }
}
