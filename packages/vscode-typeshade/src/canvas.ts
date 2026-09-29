// === The Canvas tab's host half: what to compile, and the message the webview draws from ===
//
// `docs/playground-bridge.md` §3. The webview gets no compiler (it would be the 5 MB the runtime
// exists to avoid, `typeshade/runtime`, compiler change 0025): the extension host compiles the
// active shader's workspace here, packs each file into the manifest the runtime loads, plans what
// every binding gets (`canvas-plan.ts`) and posts the result. No `vscode` import, so vitest holds
// it over the real compiler.

import { compile, packModule, type Pack, type TsCompilerDiagnostic } from './compiler.js';
import { checkPasses, planProgram, type CanvasMessage, type CanvasProgram } from './canvas-plan.js';
import type { Manifest } from './workspace-link.js';

// ─── which files ─────────────────────────────────────────────────────────────────────────────

/** The files a Canvas draws: the passes in draw order, then the main file, as paths relative to
 *  the workspace folder. */
export interface CanvasWorkspace {
  readonly main: string;
  readonly passes: readonly { readonly name: string; readonly file: string }[];
}

/** A folder-relative path without `./` or backslashes, so two spellings of one file compare. */
const normalizePath = (path: string): string => path.replace(/\\/g, '/').replace(/^(\.\/)+/, '');

/**
 * The workspace the Canvas draws for the active file.
 *
 * With a `typeshade.json` whose main file or one of whose passes is the active file, it is the
 * manifest's: the passes, then the main file, whichever of them is open. Otherwise the active
 * file is the main file and there are no passes, since a manifest that does not name the file
 * says nothing about it.
 *
 * @param active - the active file's path relative to the workspace folder.
 * @param manifest - the folder's `typeshade.json`, when it has one.
 */
export function canvasWorkspace(active: string, manifest: Manifest | undefined): CanvasWorkspace {
  const file = normalizePath(active);
  if (
    manifest !== undefined &&
    (normalizePath(manifest.main) === file ||
      manifest.passes.some((pass) => normalizePath(pass.file) === file))
  )
    return {
      main: normalizePath(manifest.main),
      passes: manifest.passes.map((pass) => ({ name: pass.name, file: normalizePath(pass.file) })),
    };
  return { main: file, passes: [] };
}

// ─── the fullscreen vertex half ──────────────────────────────────────────────────────────────
// The site compiles a file that declares no `@vertex` entry behind the fullscreen triangle every
// Book of Shaders page draws on (typeshade.github.io `src/lib/live-shader-contract.ts`,
// `FRAGMENT_PRELUDE`, and `compose` in `src/scripts/playground.ts`), so a reader writes a
// fragment program alone and takes the `uv` the triangle hands it. The Canvas draws what the
// Playground draws, so it composes the same text. This is a copy: the prelude is host data, not
// something the compiler ships, and `canvas.test.ts` compiles it with a fragment-only shader.

/** The vertex half a fragment-only file is compiled behind: three vertices at (-1,-1), (3,-1) and
 *  (-1,3) cover the clip square, and `uv` is that position in 0 to 1 from the bottom left. */
export const FRAGMENT_PRELUDE = `class VsOut {
  @builtin("position") pos: vec4
  @location(0) uv: vec2
}

@vertex
export function fullscreen(@builtin("vertex_index") i: u32): VsOut {
  const x = i === 1 ? 3. : -1.
  const y = i === 2 ? 3. : -1.
  return { pos: vec4(x, y, 0., 1.), uv: vec2(x * 0.5 + 0.5, y * 0.5 + 0.5) }
}
`;

/** The directive line as the compiler wants it: first in the file (the site's `DIRECTIVE_LINE`). */
const DIRECTIVE_LINE = /^[\s﻿]*(['"])use typeshade\1[ \t]*;?[ \t]*\r?\n/;

/** The two top-level names the prelude brings: a file that declares one of its own keeps what it
 *  wrote and gets no prelude (the site's `PRELUDE_DECLARES`). */
const PRELUDE_DECLARES =
  /^[\t ]*(?:export[\t ]+)?(?:class|function|const|let|var|type|interface)[\t ]+(?:VsOut|fullscreen)\b/m;

/** The source with comments and string bodies blanked, for a test that reads code alone. */
const codeOnly = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/(['"`])(?:[^\\]|\\.)*?\1/g, '""');

/** What the compiler is given for a file, and where the prelude went in. */
export interface ComposedSource {
  readonly text: string;
  /** The zero-based line the prelude starts at, and how many lines it took; 0 when none. */
  readonly at: number;
  readonly lines: number;
}

/**
 * The text the compiler sees for a file: the file as written, or with the fullscreen vertex half
 * after its directive when it is a fragment program alone.
 *
 * @param source - the file's text.
 */
export function composeSource(source: string): ComposedSource {
  const directive = DIRECTIVE_LINE.exec(source);
  const code = codeOnly(source);
  if (
    directive === null ||
    /@vertex\b/.test(code) ||
    !/@fragment\b/.test(code) ||
    PRELUDE_DECLARES.test(code)
  )
    return { text: source, at: 0, lines: 0 };
  const head = source.slice(0, directive[0].length);
  const inserted = `\n${FRAGMENT_PRELUDE}\n`;
  return {
    text: head + inserted + source.slice(directive[0].length),
    at: head.split('\n').length - 1,
    lines: inserted.split('\n').length - 1,
  };
}

/** A one-based line of the composed text, as the file the reader wrote numbers it. */
function ownLine(composed: ComposedSource, line: number): number {
  if (composed.lines === 0 || line - 1 < composed.at) return line;
  return line - 1 >= composed.at + composed.lines ? line - composed.lines : composed.at;
}

// ─── building the message ────────────────────────────────────────────────────────────────────

/** A file of the workspace, with the text to draw: an open editor's, else the disk's. */
export interface CanvasFile {
  /** The file's uri, which is also the name the compiler resolves its imports against. */
  readonly uri: string;
  readonly text: string;
}

/** What {@link buildCanvas} needs. */
export interface CanvasInput {
  readonly main: CanvasFile;
  /** The passes in draw order. */
  readonly passes: readonly (CanvasFile & { readonly name: string })[];
  /** The reader of a shader file an import names, the extension's `shaderReader`. */
  readonly readDocument: (uri: string) => string | undefined;
}

/** The last path segment of a uri, for a sentence. */
const baseName = (uri: string): string => decodeURIComponent(uri.split(/[\\/]/).pop() ?? uri);

/** One file compiled, packed and planned, or the sentence that says why not. */
function buildProgram(
  name: string,
  file: CanvasFile,
  passNames: readonly string[],
  readDocument: (uri: string) => string | undefined,
): CanvasProgram | string {
  const composed = composeSource(file.text);
  const label = baseName(file.uri);
  const result = compile(composed.text, { fileName: file.uri, readDocument });
  const errors = result.diagnostics.filter((d: TsCompilerDiagnostic) => d.category === 'error');
  const first = errors[0];
  if (first !== undefined) {
    // A diagnostic can sit in a file the shader imports, whose lines the prelude never moved.
    const inThisFile = first.fileName === file.uri;
    const line = inThisFile ? ownLine(composed, first.line) : first.line;
    return `${errors.length === 1 ? '1 error' : `${errors.length} errors`} in ${label}, first at ${baseName(first.fileName)}:${line}: ${first.message}`;
  }
  let manifest: Pack;
  try {
    manifest = packModule(result.module);
  } catch (error) {
    return `${label} cannot be packed: ${error instanceof Error ? error.message : String(error)}`;
  }
  const plan = planProgram(manifest, passNames);
  if (!plan.ok) return `${label}: ${plan.error}`;
  return { name, file: label, manifest, fills: plan.fills };
}

/**
 * Compiles the workspace and builds the message the Canvas webview draws from.
 *
 * Every file of the graph is compiled and planned before anything is sent, so the webview gets
 * a graph it can draw or a sentence that says why it cannot, never half of one.
 *
 * @param input - the files, in draw order, and the reader for their imports.
 */
export function buildCanvas(input: CanvasInput): CanvasMessage {
  const names = input.passes.map((pass) => pass.name);
  const bad = checkPasses(names);
  if (bad !== undefined) return { type: 'canvas-error', message: bad };
  const passes: CanvasProgram[] = [];
  for (const pass of input.passes) {
    const built = buildProgram(pass.name, pass, names, input.readDocument);
    if (typeof built === 'string')
      return { type: 'canvas-error', message: `the pass ${pass.name}: ${built}` };
    passes.push(built);
  }
  const main = buildProgram('main', input.main, names, input.readDocument);
  if (typeof main === 'string') return { type: 'canvas-error', message: main };
  return { type: 'canvas', passes, main };
}
