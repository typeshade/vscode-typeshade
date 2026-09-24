// === How an answer reads to a model ===
//
// Every tool answers in plain text, because the reader is a language model and the text is what
// it sees. The shapes are the ones compilers and editors already print: `path:line:column`, one
// diagnostic per line with its code, the offending line underneath with a caret. A model has read
// millions of those and acts on them without being told how.

import type { CheckDiagnostic, TsCompilerDiagnostic } from './compiler.js';
import { excerpt, linesOf } from './text.js';

/** A diagnostic from either source, reduced to what is printed. Lines and columns zero-based. */
export interface Problem {
  readonly severity: 'error' | 'warning' | 'information' | 'hint';
  readonly code: string;
  readonly source: 'typeshade' | 'typescript';
  readonly message: string;
  readonly line: number;
  readonly character: number;
  /** Columns to underline on the first line of the span. */
  readonly length: number;
}

/** A diagnostic of the compiler's check (`checkOpenDocument`) as a {@link Problem}. The check
 *  reports one-based lines and columns, the way `typeshade check` prints them. */
export function fromCheckDiagnostic(d: CheckDiagnostic): Problem {
  return {
    severity: d.severity === 'info' ? 'information' : d.severity,
    // Both families arrive as `TS` strings, TypeScript's `TS2304` as well as TypeShade's
    // `TS8004`. The source is printed beside the code because the two overlap from 8001 to 8039
    // (`docs/design.md` §3).
    code: d.code,
    source: d.source,
    message: d.message,
    line: d.line - 1,
    character: d.column - 1,
    length: d.endLine === d.line ? d.endColumn - d.column : Number.MAX_SAFE_INTEGER,
  };
}

/** A `compile()` diagnostic as a {@link Problem}. `compile()` reports one-based positions. */
export function fromCompilerDiagnostic(d: TsCompilerDiagnostic): Problem {
  return {
    severity: d.category === 'message' ? 'information' : d.category,
    code: d.code ?? 'TS8000',
    source: 'typeshade',
    message: d.message,
    line: d.line - 1,
    character: d.character - 1,
    length: d.endLine === d.line ? d.endCharacter - d.character : Number.MAX_SAFE_INTEGER,
  };
}

/** How many problems of each severity, as `2 errors, 1 warning`, or `no problems`. */
export function countProblems(problems: readonly Problem[]): string {
  const errors = problems.filter((p) => p.severity === 'error').length;
  const warnings = problems.filter((p) => p.severity === 'warning').length;
  const others = problems.length - errors - warnings;
  const parts = [
    errors > 0 ? plural(errors, 'error') : '',
    warnings > 0 ? plural(warnings, 'warning') : '',
    others > 0 ? plural(others, 'note') : '',
  ].filter((part) => part !== '');
  return parts.length === 0 ? 'no problems' : parts.join(', ');
}

/** The most problems one file prints in full; the rest are counted. Past this many, the first
 *  ones are what an agent should fix before asking again anyway. */
const PROBLEM_LIMIT = 40;

/**
 * Every problem in one file, each with its line underneath.
 *
 * @param display - the file as the agent should write it.
 * @param text - the file's text, for the excerpts.
 * @param problems - what to print, in document order.
 * @returns the report, starting with a summary line.
 */
export function formatProblems(
  display: string,
  text: string,
  problems: readonly Problem[],
): string {
  const lines = linesOf(text);
  const out = [`${display}: ${countProblems(problems)}`];
  for (const p of problems.slice(0, PROBLEM_LIMIT)) {
    out.push(
      '',
      `${p.severity} ${p.code} [${p.source}] ${display}:${p.line + 1}:${p.character + 1}`,
      `  ${p.message.replace(/\n/g, '\n  ')}`,
      excerpt(lines, p.line, p.character, p.length),
    );
  }
  if (problems.length > PROBLEM_LIMIT) {
    out.push('', `...and ${problems.length - PROBLEM_LIMIT} more.`);
  }
  return out.join('\n');
}

/** `count` and a noun, pluralized with a plain `s`. */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** A block of code in a Markdown fence, with a fence long enough for any backticks inside. */
export function fenced(language: string, text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${language}\n${text.replace(/\n$/, '')}\n${fence}`;
}
