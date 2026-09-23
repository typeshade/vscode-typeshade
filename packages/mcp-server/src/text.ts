// === Lines, columns and the symbol an agent names ===
//
// The language service speaks zero-based lines and UTF-16 columns (`docs/language-service-api.md`
// §2). An agent speaks the numbers its file viewer printed, which are one-based, and it is far
// better at naming the identifier it means than at counting columns. So a position arrives as a
// one-based line plus either a one-based column or the symbol's own text, and leaves as the
// service's position. Every number this server prints is one-based for the same reason.

import { ToolError } from './errors.js';
import type { TypeshadePosition } from './compiler.js';

/** The line terminators TypeScript's own line map recognises (`computeLineStarts`), so a line
 *  number here and one in a diagnostic always name the same line. */
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;

/** The text's lines, without their terminators. */
export function linesOf(text: string): string[] {
  return text.split(LINE_BREAK);
}

/** What an agent passes to point at something. */
export interface PositionInput {
  /** One-based line. */
  readonly line: number;
  /** One-based column, in UTF-16 code units. */
  readonly column?: number;
  /** The identifier to point at, found on `line`. Used when `column` is absent. */
  readonly symbol?: string;
}

/**
 * Converts an agent's position into the service's.
 *
 * @param text - the document's text.
 * @param input - the one-based line, and a column or a symbol on it.
 * @returns the zero-based position, and the line's text for echoing back.
 * @throws ToolError when the line does not exist, the column is past its end, or the symbol does
 *   not occur on it. The message quotes the line, so the next attempt can be right.
 */
export function toPosition(
  text: string,
  input: PositionInput,
): { position: TypeshadePosition; lineText: string } {
  const lines = linesOf(text);
  if (!Number.isInteger(input.line) || input.line < 1 || input.line > lines.length) {
    throw new ToolError(`Line ${input.line} does not exist; the file has ${lines.length} lines.`);
  }
  const lineText = lines[input.line - 1];
  if (input.column !== undefined) {
    if (!Number.isInteger(input.column) || input.column < 1 || input.column > lineText.length + 1) {
      throw new ToolError(
        `Column ${input.column} is outside line ${input.line}, which is ${lineText.length} ` +
          `characters long: ${JSON.stringify(lineText)}`,
      );
    }
    return { position: { line: input.line - 1, character: input.column - 1 }, lineText };
  }
  if (input.symbol === undefined || input.symbol === '') {
    throw new ToolError('Give either `column` or `symbol` to say where on the line to look.');
  }
  const character = findSymbol(lineText, input.symbol);
  if (character === undefined) {
    throw new ToolError(
      `${JSON.stringify(input.symbol)} does not occur on line ${input.line}: ` +
        JSON.stringify(lineText),
    );
  }
  return { position: { line: input.line - 1, character }, lineText };
}

/** The first occurrence of `symbol` on a line, as a whole word when it is an identifier, so
 *  `x` finds the parameter `x` rather than the `x` inside `vec4x`. */
function findSymbol(lineText: string, symbol: string): number | undefined {
  const isWord = /^[A-Za-z_$][\w$]*$/.test(symbol);
  let from = 0;
  for (;;) {
    const at = lineText.indexOf(symbol, from);
    if (at < 0) return undefined;
    if (!isWord) return at;
    const before = at === 0 ? '' : lineText[at - 1];
    const after = lineText[at + symbol.length] ?? '';
    if (!/[\w$]/.test(before) && !/[\w$]/.test(after)) return at;
    from = at + 1;
  }
}

/**
 * A line of source with a caret under a span, the way a compiler prints an error.
 *
 * @param lines - the document's lines.
 * @param line - zero-based line of the span's start.
 * @param start - zero-based column of the span's start.
 * @param length - how many columns to underline; clipped to the end of the line.
 * @returns two lines of text, indented to sit under a message.
 */
export function excerpt(
  lines: readonly string[],
  line: number,
  start: number,
  length: number,
): string {
  const text = lines[line];
  if (text === undefined) return '';
  const number = String(line + 1);
  const gutter = ' '.repeat(number.length);
  const width = Math.max(1, Math.min(length, text.length - start));
  // A tab in the source would shift a caret made of spaces, so the padding copies the line's own
  // whitespace characters up to the column.
  const pad = text.slice(0, start).replace(/[^\t]/g, ' ');
  return `    ${number} | ${text}\n    ${gutter} | ${pad}${'^'.repeat(width)}`;
}
