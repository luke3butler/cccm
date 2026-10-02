// What a pane's Chart draws: on the terminal, a Raster's cells (eighth blocks for bars and sparklines,
// braille dots for a line); elsewhere, an SVG of the same marks. Nothing here calls the engine.

export type ChartKind = 'spark' | 'bars' | 'line'

export type ChartSpec = {
  kind: ChartKind
  values: number[]
  columns: number
  rows: number
  /** 0xRRGGBB. */
  color: number
  min?: number
  max?: number
}

/** The terminal's default color in a Raster cell. */
const DEFAULT_COLOR = 0x01000000
const EIGHTHS = [0x20, 0x2581, 0x2582, 0x2583, 0x2584, 0x2585, 0x2586, 0x2587, 0x2588]
/** Braille dot bits by row from the top, left and right columns of a cell. */
const LEFT_DOTS = [0x01, 0x02, 0x04, 0x40]
const RIGHT_DOTS = [0x08, 0x10, 0x20, 0x80]

const NAMED: Record<string, number> = {
  black: 0x000000,
  red: 0xd75f5f,
  green: 0x5faf5f,
  yellow: 0xd7af5f,
  blue: 0x5f87d7,
  magenta: 0xaf5fd7,
  cyan: 0x5fafd7,
  white: 0xd0d0d0,
  gray: 0x8a8a8a,
  grey: 0x8a8a8a,
}
export const CHART_COLORS = Object.keys(NAMED)

/** A color as "#rrggbb", "#rgb" or a name, as 0xRRGGBB; undefined when it is none of them. */
export function parseColor(color: string): number | undefined {
  const named = NAMED[color.toLowerCase()]
  if (named !== undefined) return named
  const long = /^#([0-9a-f]{6})$/i.exec(color)
  if (long) return parseInt(long[1]!, 16)
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color)
  if (short) return parseInt(short.slice(1).map(d => d + d).join(''), 16)
  return undefined
}

/**
 * The numbers a chart draws from a bound or inline value: numbers, objects with a numeric `value`, and
 * strings: with `match`, its first group (or the whole match) read as a number, so a followed log such as
 * ping's "time=12.3 ms" lines charts as it arrives; without, strings that are numbers. Others are skipped.
 */
export function chartValues(value: unknown, match?: RegExp): number[] {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
  const out: number[] = []
  for (const item of list) {
    let n: unknown = typeof item === 'object' && item !== null ? (item as { value?: unknown }).value : item
    if (typeof n === 'string') {
      const found = match === undefined ? undefined : match.exec(n)
      n = match === undefined ? (n.trim() === '' ? NaN : Number(n)) : found === null ? NaN : Number(found?.[1] ?? found?.[0])
    }
    if (typeof n === 'number' && Number.isFinite(n)) out.push(n)
  }
  return out
}

/** A Chart's `match` as a RegExp, or undefined when it is not one. */
export function matchOf(source: unknown): RegExp | undefined {
  if (typeof source !== 'string' || source.length === 0 || source.length > 200) return undefined
  try {
    return new RegExp(source)
  } catch {
    return undefined
  }
}

/** The values a chart of `columns` cells shows: the last that fit, as a log's tail would. */
function visible(spec: ChartSpec): number[] {
  const fit = spec.kind === 'line' ? spec.columns * 2 : spec.kind === 'spark' ? spec.columns : Math.max(1, Math.floor((spec.columns + 1) / 2))
  return spec.values.slice(-fit)
}

/**
 * The scale: `min` and `max` where given. Otherwise bars start at 0 (or their lowest value, when it is
 * negative), and lines and sparklines fit what they show, padded a tenth, so 47-50 ms isn't a flat line.
 */
export function range(spec: Pick<ChartSpec, 'kind' | 'min' | 'max'>, values: number[]): { lo: number; hi: number } {
  if (values.length === 0) return { lo: spec.min ?? 0, hi: spec.max ?? (spec.min ?? 0) + 1 }
  const least = Math.min(...values)
  const most = Math.max(...values)
  const pad = Math.max((most - least) * 0.1, Math.abs(most) * 0.01, 1e-6)
  const lo = spec.min ?? (spec.kind === 'bars' ? Math.min(0, least) : least - pad)
  const hi = spec.max ?? (spec.kind === 'bars' && most === lo ? lo + 1 : most + (spec.kind === 'bars' ? 0 : pad))
  return hi > lo ? { lo, hi } : { lo, hi: lo + 1 }
}

/** 0 to 1: where `v` sits between lo and hi, clamped. */
function fraction(v: number, lo: number, hi: number): number {
  return Math.max(0, Math.min(1, (v - lo) / (hi - lo)))
}

/** The Raster's `cells`: `columns * rows` little-endian u32 triplets [codePoint, fg, bg], base64. */
export function chartCells(spec: ChartSpec): string {
  const { columns, rows } = spec
  const words = new Uint32Array(columns * rows * 3)
  for (let i = 0; i < columns * rows; i++) {
    words[i * 3] = 0x20
    words[i * 3 + 1] = DEFAULT_COLOR
    words[i * 3 + 2] = DEFAULT_COLOR
  }
  const put = (x: number, y: number, codePoint: number) => {
    if (x < 0 || x >= columns || y < 0 || y >= rows) return
    const i = (y * columns + x) * 3
    words[i] = codePoint
    words[i + 1] = spec.color
  }
  const values = visible(spec)
  const { lo, hi } = range(spec, values)
  if (spec.kind === 'line') {
    const dotsHigh = rows * 4
    const bits = new Uint8Array(columns * rows)
    let last: number | undefined
    values.forEach((v, n) => {
      const level = Math.round(fraction(v, lo, hi) * (dotsHigh - 1))
      // Join each point to the last with a vertical run, so steep moves stay one line.
      const from = last ?? level
      for (let dot = Math.min(from, level); dot <= Math.max(from, level); dot++) {
        const y = dotsHigh - 1 - dot
        const cell = Math.floor(y / 4) * columns + (n >> 1)
        bits[cell]! |= (n & 1 ? RIGHT_DOTS : LEFT_DOTS)[y % 4]!
      }
      last = level
    })
    bits.forEach((b, cell) => b !== 0 && put(cell % columns, Math.floor(cell / columns), 0x2800 + b))
  } else {
    // spark: one column per value; bars: two (a bar and a gap).
    const step = spec.kind === 'spark' ? 1 : 2
    values.forEach((v, n) => {
      let eighths = Math.round(fraction(v, lo, hi) * rows * 8)
      if (eighths === 0 && v > lo) eighths = 1
      for (let r = 0; r < rows; r++) put(n * step, rows - 1 - r, EIGHTHS[Math.max(0, Math.min(8, eighths - r * 8))]!)
    })
  }
  return toBase64(new Uint8Array(words.buffer))
}

/** The same chart as SVG markup, for surfaces without a Raster: 8 by 16 CSS pixels a cell. */
export function chartSvg(spec: ChartSpec): string {
  const width = spec.columns * 8
  const height = spec.rows * 16
  const values = visible(spec)
  const { lo, hi } = range(spec, values)
  const color = `#${spec.color.toString(16).padStart(6, '0')}`
  const y = (v: number) => (height - fraction(v, lo, hi) * (height - 2) - 1).toFixed(1)
  let marks = ''
  if (spec.kind === 'line') {
    const dx = values.length > 1 ? width / (values.length - 1) : 0
    const points = values.map((v, n) => `${(n * dx).toFixed(1)},${y(v)}`).join(' ')
    marks = `<polyline fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" points="${points}"/>`
  } else {
    const slot = spec.kind === 'spark' ? 8 : 16
    const bar = spec.kind === 'spark' ? 7 : 10
    marks = values
      .map((v, n) => {
        const top = Number(y(v))
        return `<rect x="${n * slot}" y="${top.toFixed(1)}" width="${bar}" height="${(height - top).toFixed(1)}" rx="1" fill="${color}"/>`
      })
      .join('')
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${marks}</svg>`
}

/** A one-line summary of a chart's data: what its alt says. */
export function chartAlt(kind: ChartKind, values: number[]): string {
  if (values.length === 0) return `${kind} chart: no data`
  const round = (n: number) => String(Math.round(n * 100) / 100)
  return `${kind} chart of ${values.length}: min ${round(Math.min(...values))}, max ${round(Math.max(...values))}, last ${round(values[values.length - 1]!)}`
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard padded base64. */
export function toBase64(bytes: Uint8Array): string {
  const native = (bytes as unknown as { toBase64?: () => string }).toBase64
  if (typeof native === 'function') return native.call(bytes)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? B64[n & 63]! : '='
  }
  return out
}
