// table(): command output in columns (iostat, vm_stat, ps, df, CSV) as rows of named cells, for scripts
// and a pane's render. Nothing here calls the engine.

/** A cell that is a plain number, which becomes one; "1m", "16384K" and "0:01.2" stay strings. */
const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/
/** Lines one call reads. */
const MAX_LINES = 20_000

export type TableOptions = {
  /** Column names, in place of a header line the output has. */
  header?: unknown
  /** What splits a line into cells: a string or RegExp (default runs of whitespace). */
  split?: unknown
}

/**
 * Rows of `text` (a string, or a list of lines as a follow keeps them) as objects keyed by the header.
 * A header is a line with two or more cells and no number among them; a later one replaces it, so a
 * header that repeats or a title line above it is fine. Other lines are rows, read with the header above
 * them, but for a line shorter than the header that is mostly words (a title with a number in it); rows
 * before any header are skipped. Cells past the header's last join into it (ps's COMMAND).
 * A plain number becomes a number. With `header`, every line is a row but one that repeats the header.
 */
export function table(text: unknown, options: TableOptions = {}): Record<string, string | number>[] {
  const lines = (Array.isArray(text) ? text.map(line => String(line)) : typeof text === 'string' ? text.split('\n') : undefined)
  if (lines === undefined) throw new TypeError('table() takes a string or a list of lines.')
  const split = options.split ?? /\s+/
  if (typeof split !== 'string' && !(split instanceof RegExp)) throw new TypeError('table(): split is a string or a RegExp.')
  const given = options.header
  if (given !== undefined && (!Array.isArray(given) || given.length === 0 || !given.every(name => typeof name === 'string'))) {
    throw new TypeError('table(): header is a list of column names.')
  }
  const cellsOf = (line: string) => {
    const trimmed = split instanceof RegExp && split.source === '\\s+' ? line.trim() : line.replace(/\r$/, '')
    return trimmed === '' ? [] : trimmed.split(split).map(cell => cell.trim())
  }
  let header: string[] | undefined = given === undefined ? undefined : unique(given as string[])
  const rows: Record<string, string | number>[] = []
  for (const line of lines.slice(-MAX_LINES)) {
    const cells = cellsOf(line)
    if (cells.length === 0) continue
    if (given !== undefined) {
      // The output's own header line, when it has one, is not a row.
      if (cells.join('\n') === (given as string[]).join('\n')) continue
    } else if (!cells.some(cell => NUMBER.test(cell))) {
      if (cells.length >= 2) header = unique(cells)
      continue
    }
    if (header === undefined) continue
    // A title with a number in it (vm_stat's "page size of 16384 bytes", which it repeats) is mostly words
    // and shorter than the header; a row is mostly numbers, or as long as the header (ps's text columns).
    if (given === undefined && cells.length < header.length && cells.filter(cell => NUMBER.test(cell)).length * 2 < cells.length) continue
    const row: Record<string, string | number> = {}
    header.forEach((name, i) => {
      const cell = i === header!.length - 1 && cells.length > header!.length ? cells.slice(i).join(' ') : cells[i]
      if (cell !== undefined) row[name] = NUMBER.test(cell) ? Number(cell) : cell
    })
    rows.push(row)
  }
  return rows
}

/** Names made unique: a second "id" is "id_2". */
function unique(names: string[]): string[] {
  const seen = new Map<string, number>()
  return names.map(name => {
    const count = (seen.get(name) ?? 0) + 1
    seen.set(name, count)
    return count === 1 ? name : `${name}_${count}`
  })
}
