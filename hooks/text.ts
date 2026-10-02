// Command output made plain text: what the engine draws (it refuses a tree whose text holds a control
// character) and what the model reads (colors and cursor moves are noise to it). Nothing here calls the engine.

/** CSI (colors, cursor moves), OSC (titles, links) and two-character escapes. */
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]|\x9b[0-?]*[ -/]*[@-~]/g
/** Control characters but tab and newline. */
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g

/**
 * `text` without escape sequences or control characters, tab and newline kept. A line a carriage return
 * rewrote (a progress bar) keeps what a terminal would show last: the text after its last \r.
 */
export function plainText(text: string): string {
  if (!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text)) return text
  return text
    .replace(ESCAPES, '')
    .replace(/\r+\n/g, '\n')
    .replace(/[^\n]*\r(?=[^\n])/g, '')
    .replace(CONTROLS, '')
}
