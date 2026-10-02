// Draws a script-opened pane from its record: the view's plain-data nodes become the surface's elements,
// bound props read the pane's values and data, and each control's closure reports what the person did.

import type {
  BoxProps,
  ButtonProps,
  CodeProps,
  ElementConstructor,
  ImageProps,
  ImageSource,
  InputProps,
  LinkProps,
  MarkdownProps,
  RasterProps,
  RenderElement,
  SelectProps,
  SvgProps,
  TextProps,
} from 'claude-code'

import type { CodemodeJson, CodemodeNode, CodemodePane } from '../types'

import { chartAlt, chartCells, chartSvg, chartValues, matchOf, parseColor, type ChartKind } from './charts'
import { MAX_ELEMENT_TEXT, boundText, getAt, isShown, pngOf } from './panes'
import { plainText } from './text'

/** Text a drawing may carry in all: the engine refuses a tree past 100,000 characters. */
const DRAW_BUDGET = 90_000
const DEFAULT_CHART_COLOR = 0x5fafd7

export type PaneElements = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  Input?: ElementConstructor<InputProps>
  Select?: ElementConstructor<SelectProps>
  Markdown: ElementConstructor<MarkdownProps>
  Code: ElementConstructor<CodeProps>
  Link: ElementConstructor<LinkProps>
  Raster?: ElementConstructor<RasterProps>
  Image?: ElementConstructor<ImageProps>
  Svg?: ElementConstructor<SvgProps>
}

/** Where the drawing goes: the surface decides how an Image and a Chart draw. */
export type PaneSurface = { surface: string; bodyColumns: number }

/** A terminal Image drawn: its key and source, which register.tsx blits to learn whether pixels show. */
export type DrawnImage = { key: string; source: ImageSource }

/** One drawing's running state: the text left to spend, the keys handed out, the images drawn. */
type Drawing = PaneSurface & { left: number; images: DrawnImage[]; charts: number }

/** What the controls a view draws do, in register.tsx. */
export type PaneHandlers = {
  press: (node: CodemodeNode) => unknown
  input: (node: CodemodeNode, value: string) => unknown
  submit: (node: CodemodeNode, value: string) => unknown
  select: (node: CodemodeNode, value: string) => unknown
}

/** The pane's body, or a note when its record is gone; `images` lists the terminal Images it drew. */
export function drawPane(
  elements: PaneElements,
  pane: CodemodePane | null,
  handlers: PaneHandlers,
  where: PaneSurface = { surface: 'terminal', bodyColumns: 60 },
): { tree: RenderElement; images: DrawnImage[] } {
  const { Text } = elements
  if (pane === null) return { tree: <Text dimColor>This pane's record is gone. A codemode script can open it again.</Text>, images: [] }
  const drawing: Drawing = { ...where, left: DRAW_BUDGET, images: [], charts: 0 }
  return { tree: drawNode(elements, pane, pane.view, handlers, drawing) ?? <Text> </Text>, images: drawing.images }
}

/** `text` as plain text (the engine refuses control characters), within what the drawing has left, the end kept when `keepEnd`. */
function spend(drawing: Drawing, given: string, keepEnd = false): string {
  const text = plainText(given)
  if (text.length <= drawing.left) {
    drawing.left -= text.length
    return text
  }
  const kept = Math.max(0, drawing.left - 1)
  drawing.left = 0
  return keepEnd ? `…${text.slice(-kept)}` : `${text.slice(0, kept)}…`
}

function drawNode(elements: PaneElements, pane: CodemodePane, node: CodemodeNode | string, handlers: PaneHandlers, drawing: Drawing): RenderElement | null {
  const { Box, Text, Button, Input, Select, Markdown, Code, Link } = elements
  if (typeof node === 'string') return <Text>{spend(drawing, node)}</Text>
  const { bind, tail, when, emit: _emit, data: _data, set: _set, close: _close, push: _push, prompt: _prompt, ...props } = node.props as Record<string, CodemodeJson>
  if (!isShown(pane, when)) return null
  const bound = typeof bind === 'string' ? getAt(pane, bind) : undefined
  const tailLines = typeof tail === 'number' ? tail : undefined
  const children = node.children
    .map(child => (typeof child === 'string' ? spend(drawing, child) : drawNode(elements, pane, child, handlers, drawing)))
    .filter(child => child !== null)
  switch (node.type) {
    case 'Box':
      return <Box {...(props as BoxProps)}>{children}</Box>
    case 'Text':
      return <Text {...(props as TextProps)}>{typeof bind === 'string' ? spend(drawing, clip(boundText(bound, tailLines), true), true) : children}</Text>
    case 'Button': {
      const label = typeof props.label === 'string' ? props.label : node.children.filter(child => typeof child === 'string').join('')
      const { plain, ...rest } = props
      return <Button {...(rest as unknown as ButtonProps)} {...(plain === true ? { plain: true } : {})} label={label} onPress={() => handlers.press(node)} />
    }
    case 'Input': {
      if (Input === undefined) return <Text dimColor>(a text field this surface cannot draw)</Text>
      const path = typeof bind === 'string' ? bind : `values.${String(props.key)}`
      const value = getAt(pane, path)
      return (
        <Input
          {...(props as unknown as InputProps)}
          value={typeof value === 'string' ? value : ''}
          onInput={text => handlers.input(node, text)}
          onSubmit={text => handlers.submit(node, text)}
        />
      )
    }
    case 'Select': {
      if (Select === undefined) return <Text dimColor>(a picker this surface cannot draw)</Text>
      const path = typeof bind === 'string' ? bind : `values.${String(props.key)}`
      const value = getAt(pane, path)
      const options = (props.options as (string | { value: string; label?: string })[]).map(option =>
        typeof option === 'string' ? { value: option } : option,
      )
      return (
        <Select
          {...(props as unknown as SelectProps)}
          options={options}
          {...(typeof value === 'string' ? { value } : {})}
          onSelect={picked => handlers.select(node, picked)}
        />
      )
    }
    case 'Markdown': {
      const text = typeof bind === 'string' ? boundText(bound, tailLines) : String(props.text ?? '')
      return <Markdown {...(props as unknown as MarkdownProps)} text={spend(drawing, clip(text, tailLines !== undefined), tailLines !== undefined)} />
    }
    case 'Code': {
      const source = typeof bind === 'string' ? boundText(bound, tailLines) : String(props.source ?? '')
      return <Code {...(props as unknown as CodeProps)} source={spend(drawing, clip(source, tailLines !== undefined), tailLines !== undefined) || ' '} />
    }
    case 'Link':
      return <Link {...(props as unknown as LinkProps)} />
    case 'Image':
      return drawImage(elements, props, typeof bind === 'string' ? bound : undefined, drawing)
    case 'Chart':
      return drawChart(elements, props, typeof bind === 'string' ? bound : props.values, drawing)
    default:
      return <Text dimColor>{`(no element ${node.type})`}</Text>
  }
}

/**
 * Text within what Code and Markdown take: terminal color codes and control characters other than tab
 * and newline removed (command output is full of them), then the end of a tailed one, else the start.
 */
function clip(text: string, keepEnd: boolean): string {
  const clean = plainText(text)
  if (clean.length <= MAX_ELEMENT_TEXT) return clean
  return keepEnd ? clean.slice(-MAX_ELEMENT_TEXT) : clean.slice(0, MAX_ELEMENT_TEXT)
}

/**
 * An Image: pixels on the terminal where it can (its alt elsewhere, which the terminal decides), an SVG
 * around a PNG on the other surfaces, else the alt as dim text.
 */
function drawImage(elements: PaneElements, props: Record<string, CodemodeJson>, bound: CodemodeJson | undefined, drawing: Drawing): RenderElement {
  const { Text, Image, Svg } = elements
  const alt = String(props.alt)
  const columns = Number(props.columns)
  const rows = Number(props.rows)
  const raw = bound !== undefined ? bound : (props.file ?? props.src)
  const png = typeof raw === 'string' ? pngOf(raw) : undefined
  const file = typeof raw === 'string' && raw.startsWith('/') && /\.png$/i.test(raw) ? raw : undefined
  const missing = <Text dimColor>{`[${alt}]`}</Text>
  if (png === undefined && file === undefined) return missing
  if (drawing.surface === 'terminal' && Image !== undefined) {
    const source: ImageSource = png !== undefined ? { png } : { file: file!, format: 'png' }
    const key = typeof props.key === 'string' ? props.key : `codemode-image-${drawing.images.length + 1}`
    drawing.images.push({ key, source })
    return <Image key={key} source={source} columns={columns} rows={rows} alt={alt} />
  }
  if (drawing.surface !== 'terminal' && Svg !== undefined && png !== undefined) {
    const width = columns * 8
    const height = rows * 16
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image href="data:image/png;base64,${png}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet"/></svg>`
    if (source.length <= 131_072) return <Svg source={source} alt={alt} width={width} height={height} />
  }
  return missing
}

/** A Chart: a Raster of cells on the terminal, an SVG elsewhere, its alt where neither draws. */
function drawChart(elements: PaneElements, props: Record<string, CodemodeJson>, data: CodemodeJson | undefined, drawing: Drawing): RenderElement {
  const { Text, Raster, Svg } = elements
  const kind = props.kind as ChartKind
  const values = chartValues(data, matchOf(props.match))
  const columns = typeof props.columns === 'number' ? props.columns : Math.max(8, Math.min(60, drawing.bodyColumns - 4))
  const rows = typeof props.rows === 'number' ? props.rows : kind === 'spark' ? 1 : 6
  const color = (typeof props.color === 'string' ? parseColor(props.color) : undefined) ?? DEFAULT_CHART_COLOR
  const spec = {
    kind,
    values,
    columns,
    rows,
    color,
    ...(typeof props.min === 'number' ? { min: props.min } : {}),
    ...(typeof props.max === 'number' ? { max: props.max } : {}),
  }
  const alt = typeof props.alt === 'string' ? props.alt : chartAlt(kind, values)
  drawing.charts += 1
  if (drawing.surface === 'terminal' && Raster !== undefined) {
    const cells = chartCells(spec)
    if (cells.length <= drawing.left) {
      drawing.left -= cells.length
      return <Raster key={`codemode-chart-${drawing.charts}`} columns={columns} rows={rows} cells={cells} />
    }
  } else if (drawing.surface !== 'terminal' && Svg !== undefined) {
    const source = chartSvg(spec)
    if (source.length <= drawing.left) {
      drawing.left -= source.length
      return <Svg source={source} alt={alt} width={columns * 8} height={rows * 16} />
    }
  }
  return <Text dimColor>{alt}</Text>
}
