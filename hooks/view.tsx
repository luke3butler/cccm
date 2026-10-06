// Draws a codemode call's row: the script, then the tool calls it made, as they run.
// The calls are not rows of their own because they never reach the model as tool calls.

import type { BoxProps, ButtonProps, CodeProps, ElementConstructor, RenderElement, RenderPropsOf, TextProps } from 'claude-code'

import type { CodemodeCall, CodemodeCalls, CodemodeDiffs, CodemodeFileDiff } from '../types'

import { diffSource } from './diffs'
import { plainText } from './text'

const SCRIPT_PREVIEW_LINES = 8
const RESULT_PREVIEW_LINES = 5
/** Lines of each file change the result shows. */
const DIFF_PREVIEW_LINES = 40

type Elements = { Box: ElementConstructor<BoxProps>; Text: ElementConstructor<TextProps>; Button: ElementConstructor<ButtonProps> }

/** Whether the row shows the whole script, and how to flip it. */
export type Expand = { isExpanded: boolean; onToggle: () => unknown }

const STATUS: Record<CodemodeCall['status'], { icon: string; color?: string }> = {
  running: { icon: '…', color: 'warning' },
  ok: { icon: '✓', color: 'success' },
  error: { icon: '✗', color: 'error' },
  left: { icon: '⊘' },
}

/** The row: a title line, the script (its first lines until expanded), and the latest calls with their status. */
export function drawToolUse(
  { Box, Text, Button }: Elements,
  props: RenderPropsOf['ToolUse'],
  calls: CodemodeCalls | undefined,
  expand: Expand,
): RenderElement {
  const input = props.input as { script?: unknown; name?: unknown; args?: unknown } | undefined
  const script = input?.script
  // A saved script run by name shows its name in the title and its args below; an inline script's args follow it.
  const saved = typeof input?.name === 'string' ? input.name : undefined
  const args = typeof input?.args === 'object' && input.args !== null && Object.keys(input.args).length > 0 ? JSON.stringify(input.args) : undefined
  const lines = typeof script === 'string' ? plainText(script).trimEnd().split('\n') : args !== undefined ? [plainText(args)] : []
  const hiddenLines = lines.length - SCRIPT_PREVIEW_LINES
  const shownLines = expand.isExpanded ? lines : lines.slice(0, SCRIPT_PREVIEW_LINES)
  const plural = hiddenLines === 1 ? '' : 's'
  const isFailed = isFailedScript(props.output)
  const bullet = props.isErrored || props.isInterrupted || isFailed ? 'error' : props.isRunning ? undefined : 'success'
  const earlier = calls === undefined ? 0 : calls.total - calls.recent.length

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={bullet} dimColor={bullet === undefined}>
          ⏺{' '}
        </Text>
        <Text bold>codemode</Text>
        {saved !== undefined ? <Text>{` ${saved}`}</Text> : null}
        {isFailed ? <Text color="error"> · script failed</Text> : null}
        {calls !== undefined && calls.total > 0 ? <Text dimColor>{` · ${summary(calls)}`}</Text> : null}
      </Text>
      <Box flexDirection="column" paddingLeft={2}>
        {shownLines.map(line => (
          <Text dimColor wrap="truncate-end">
            {line.length > 0 ? line : ' '}
          </Text>
        ))}
        {hiddenLines > 0 ? (
          <Button
            key="expand"
            plain
            dimColor
            label={expand.isExpanded ? 'Show less' : `… ${hiddenLines} more line${plural} (show all)`}
            onPress={expand.onToggle}
          />
        ) : null}
        {typeof script === 'string' && args !== undefined ? (
          <Text dimColor wrap="truncate-end">
            {`args ${plainText(args)}`}
          </Text>
        ) : null}
      </Box>
      {calls !== undefined && calls.recent.length > 0 ? (
        <Box flexDirection="column" paddingLeft={2}>
          {earlier > 0 ? <Text dimColor>{`… ${earlier} earlier call${earlier === 1 ? '' : 's'}`}</Text> : null}
          {calls.recent.map(call => drawCall(Text, call))}
        </Box>
      ) : (
        null
      )}
    </Box>
  )
}

function drawCall(Text: Elements['Text'], call: CodemodeCall): RenderElement {
  const status = STATUS[call.status]
  return (
    <Text wrap="truncate-end">
      <Text color={status.color} dimColor={status.color === undefined}>
        {status.icon}
      </Text>{' '}
      <Text bold>{shortName(call.tool)}</Text>
      {call.args.length > 0 ? <Text dimColor>{` ${plainText(call.args)}`}</Text> : null}
      {call.ms !== undefined ? <Text dimColor>{` ${duration(call.ms)}`}</Text> : null}
      {call.status === 'left' ? <Text dimColor> (cancelled when the script ended)</Text> : null}
    </Text>
  )
}

/**
 * The result under the row: the output without its header (the row's title has the counts), its first
 * lines until expanded. A failed script's is shown whole, as its error and calls are what matter.
 */
export function drawToolResult(
  { Box, Text, Button, Code }: Elements & { Code?: ElementConstructor<CodeProps> },
  props: RenderPropsOf['ToolResult'],
  expand: Expand,
  diffs?: CodemodeDiffs,
): RenderElement {
  // Colors and other escapes in a command's output: the engine refuses text that holds them.
  const [header, ...body] = plainText(resultText(props.output)).trimEnd().split('\n')
  const lines = header?.startsWith('Script ') ? body : [header ?? '', ...body]
  const isFailed = isFailedScript(props.output)
  const isWhole = expand.isExpanded || isFailed
  const hiddenLines = lines.length - RESULT_PREVIEW_LINES
  const shownLines = isWhole ? lines : lines.slice(0, RESULT_PREVIEW_LINES)
  const plural = hiddenLines === 1 ? '' : 's'

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {lines.length === 0 || (lines.length === 1 && lines[0] === '') ? (
        <Text dimColor>⎿  (no output)</Text>
      ) : (
        shownLines.map((line, i) => (
          <Text wrap={isWhole ? 'wrap' : 'truncate-end'} color={isFailed && line.startsWith('Script error:') ? 'error' : undefined}>
            <Text dimColor>{i === 0 ? '⎿  ' : '   '}</Text>
            {line.length > 0 ? line : ' '}
          </Text>
        ))
      )}
      {hiddenLines > 0 && !isFailed ? (
        <Box paddingLeft={3}>
          <Button
            key="expand-result"
            plain
            dimColor
            label={expand.isExpanded ? 'Show less' : `… ${hiddenLines} more line${plural} (show all)`}
            onPress={expand.onToggle}
          />
        </Box>
      ) : null}
      {diffs?.files.map(file => drawDiff({ Box, Text, Code }, file))}
      {diffs !== undefined && diffs.more > 0 ? (
        <Text dimColor>{`   … ${diffs.more} more file change${diffs.more === 1 ? '' : 's'}`}</Text>
      ) : null}
    </Box>
  )
}

/** One file change under the result, as Bash's row draws its own: the path and counts, then the hunks. */
function drawDiff(
  { Box, Text, Code }: { Box: Elements['Box']; Text: Elements['Text']; Code?: ElementConstructor<CodeProps> },
  file: CodemodeFileDiff,
): RenderElement {
  const verb = file.created ? 'Created' : file.deleted ? 'Deleted' : 'Updated'
  const { source, hidden } = diffSource(file, DIFF_PREVIEW_LINES)
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text dimColor>⎿  </Text>
        {`${verb} `}
        <Text bold>{file.filePath}</Text>
        <Text dimColor>{` (+${file.added} -${file.removed})`}</Text>
      </Text>
      {source.length > 0 && Code !== undefined ? (
        <Box paddingLeft={3}>
          <Code source={source} format="diff" path={file.filePath} />
        </Box>
      ) : null}
      {hidden > 0 ? <Text dimColor>{`   … ${hidden} more line${hidden === 1 ? '' : 's'}`}</Text> : null}
    </Box>
  )
}

/** The text of a stored result: the text itself, or the first block's when it carries images. */
function resultText(output: unknown): string {
  const first = Array.isArray(output) ? (output[0] as { text?: unknown } | undefined)?.text : output
  return typeof first === 'string' ? first : ''
}

/** Whether a stored result carries images, which Claude Code's own result block draws. */
export function hasImages(output: unknown): boolean {
  return Array.isArray(output) && output.some(block => (block as { type?: unknown })?.type === 'image')
}

/**
 * Whether the stored result is a failed script's. A plugin's tool can't answer with an error result
 * (a `tool.call` hook answers `{ result }` or `{ deny }`), so Claude Code draws the call as a success;
 * the result's own header says otherwise. The output is the text, or text and image blocks.
 */
function isFailedScript(output: unknown): boolean {
  return resultText(output).startsWith('Script failed')
}

function summary(calls: CodemodeCalls): string {
  const total = `${calls.total} call${calls.total === 1 ? '' : 's'}`
  return calls.failed > 0 ? `${total}, ${calls.failed} failed` : total
}

/** `mcp__tldv__list-meetings` as `tldv list-meetings`; a built-in tool's name as is. */
function shortName(tool: string): string {
  const match = /^mcp__(.+?)__(.+)$/.exec(tool)
  return match === null ? tool : `${match[1]} ${match[2]}`
}

function duration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}