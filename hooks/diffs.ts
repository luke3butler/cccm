// The file changes a script's tool calls made, for its result row: what Bash (bashEditDiff), Edit and
// Write (structuredPatch) report beside their results, which Claude Code draws under their own rows
// and never shows the model. A script's calls are not rows of their own, so the codemode row draws them.

import type { CodemodeDiffs, CodemodeFileDiff, CodemodeHunk } from '../types'

/** Changes kept per script; past this the row says how many more. */
export const MAX_DIFF_FILES = 10
/** Lines kept per change; past this the row says how many more. */
export const MAX_DIFF_LINES = 200
/** Characters drawn of one diff line, so a row's hunks stay inside what the Code element takes. */
const MAX_LINE_CHARS = 200

/** The changes one tool call reports, empty when it reports none. */
export function fileDiffsOf(tool: string, result: unknown): CodemodeFileDiff[] {
  if (typeof result !== 'object' || result === null) return []
  const record = result as Record<string, unknown>
  if (tool === 'Bash') {
    const diff = record.bashEditDiff as { files?: unknown } | undefined
    if (!Array.isArray(diff?.files)) return []
    return diff.files.flatMap(file => {
      const { filePath, hunks, created, deleted } = (file ?? {}) as Record<string, unknown>
      if (typeof filePath !== 'string') return []
      return [fileDiff(filePath, hunksOf(hunks), created === true, deleted === true)]
    })
  }
  if (tool === 'Edit' || tool === 'Write') {
    const filePath = record.filePath
    if (typeof filePath !== 'string') return []
    // A Write that made the file reports no patch: its content is the change.
    if (tool === 'Write' && record.type === 'create' && typeof record.content === 'string') {
      const lines = record.content.replace(/\n$/, '').split('\n')
      return [fileDiff(filePath, [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map(line => `+${line}`) }], true, false)]
    }
    const hunks = hunksOf(record.structuredPatch)
    return hunks.length === 0 ? [] : [fileDiff(filePath, hunks, false, false)]
  }
  return []
}

function hunksOf(value: unknown): CodemodeHunk[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(hunk => {
    const { oldStart, oldLines, newStart, newLines, lines } = (hunk ?? {}) as Record<string, unknown>
    if (![oldStart, oldLines, newStart, newLines].every(n => typeof n === 'number') || !Array.isArray(lines)) return []
    return [{ oldStart, oldLines, newStart, newLines, lines: lines.filter(line => typeof line === 'string') } as CodemodeHunk]
  })
}

/** A change with its lines cut to MAX_DIFF_LINES, so a long one keeps the row's state small. */
function fileDiff(filePath: string, hunks: CodemodeHunk[], created: boolean, deleted: boolean): CodemodeFileDiff {
  let room = MAX_DIFF_LINES
  let cut = 0
  const kept: CodemodeHunk[] = []
  for (const hunk of hunks) {
    if (room <= 0) {
      cut += hunk.lines.length
      continue
    }
    kept.push(hunk.lines.length <= room ? hunk : { ...hunk, lines: hunk.lines.slice(0, room) })
    cut += Math.max(0, hunk.lines.length - room)
    room -= hunk.lines.length
  }
  const counts = countLines(hunks)
  return {
    filePath,
    hunks: kept,
    added: counts.added,
    removed: counts.removed,
    ...(cut > 0 ? { cutLines: cut } : {}),
    ...(created ? { created: true as const } : {}),
    ...(deleted ? { deleted: true as const } : {}),
  }
}

function countLines(hunks: readonly CodemodeHunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) removed += 1
    }
  }
  return { added, removed }
}

/** The script's changes with these added: the first MAX_DIFF_FILES kept, the rest counted. */
export function addDiffs(diffs: CodemodeDiffs, added: readonly CodemodeFileDiff[]): CodemodeDiffs {
  const room = Math.max(0, MAX_DIFF_FILES - diffs.files.length)
  return { files: [...diffs.files, ...added.slice(0, room)], more: diffs.more + Math.max(0, added.length - room) }
}

/** A change as unified-diff hunks, what the Code element draws under `format: 'diff'`. */
export function diffSource(file: CodemodeFileDiff, maxLines: number): { source: string; hidden: number } {
  const out: string[] = []
  let shown = 0
  let hidden = file.cutLines ?? 0
  for (const hunk of file.hunks) {
    if (shown >= maxLines) {
      hidden += hunk.lines.length
      continue
    }
    // Code takes tab and newline as its only control characters, and 10,000 characters in all.
    const lines = hunk.lines.slice(0, maxLines - shown).map(line => line.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, MAX_LINE_CHARS))
    hidden += hunk.lines.length - lines.length
    shown += lines.length
    // A cut hunk's header counts only the lines drawn, so the hunk still parses.
    const oldLines = lines.filter(line => !line.startsWith('+')).length
    const newLines = lines.filter(line => !line.startsWith('-')).length
    out.push(`@@ -${hunk.oldStart},${lines.length === hunk.lines.length ? hunk.oldLines : oldLines} +${hunk.newStart},${lines.length === hunk.lines.length ? hunk.newLines : newLines} @@`, ...lines)
  }
  return { source: out.join('\n'), hidden }
}
