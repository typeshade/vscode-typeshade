// === What each tool does, apart from the protocol ===
//
// The server (`server.ts`) is the adapter: it declares the tools, validates their arguments and
// turns an answer into an MCP result. Everything an answer says is decided here, and every
// answer is text, so this module can be tested by calling it, with no transport in the way.
//
// The layering is the compiler's (`docs/language-service-api.md` §1): the service and the
// compiler decide, and this module converts. Diagnostics, hover, definitions, references and
// symbols come from the same `TypeshadeLanguageService` the editor plugin answers from, so an
// agent and a person looking at one file see one set of errors. Compiled output and CPU runs
// come from `compile()`, which is the authority on what TypeShade accepts.

import typescript from 'typescript';
import { textHasDirective } from '../../tsserver-plugin/src/directive.js';
import {
  checkOpenDocument,
  compile,
  reflect,
  stageOf,
  type TypeshadeLocation,
} from './compiler.js';
import { DiskDocuments, type OpenedFile } from './documents.js';
import { ToolError } from './errors.js';
import {
  fenced,
  formatProblems,
  fromCheckDiagnostic,
  fromCompilerDiagnostic,
  plural,
  type Problem,
} from './format.js';
import { runOnCpu, type RunRequest } from './run.js';
import { linesOf, toPosition, type PositionInput } from './text.js';
import { Vocabulary } from './vocabulary.js';
import { toUri, type Workspace } from './workspace.js';

/** A file on disk or source text, for the tools that accept either. */
export interface SourceInput {
  /** A path, absolute or relative to the first root. */
  readonly file?: string;
  /** Shader text to use instead of a file. */
  readonly source?: string;
}

/** A place in a file, for the navigation tools. */
export interface LocationInput extends PositionInput {
  readonly file: string;
}

/** What `compile` can print. */
export type OutputKind = 'wgsl' | 'glsl' | 'reflection' | 'determinism';

/** The most shader files one `check` of a directory reports on. */
const CHECK_FILE_LIMIT = 200;

/**
 * The tools, over one workspace.
 */
export class TypeshadeTools {
  private readonly documents: DiskDocuments;
  private vocabulary: Vocabulary | undefined;

  constructor(private readonly workspace: Workspace) {
    this.documents = new DiskDocuments(workspace);
  }

  /**
   * Diagnostics for shader files, as the editor shows them, plus any target the emitters refuse.
   *
   * @param input - one `file` (a file or a directory of them), several `files`, or `source`.
   * @returns a report per file; a clean file is listed, not detailed.
   */
  check(input: { file?: string; files?: readonly string[]; source?: string }): string {
    this.documents.beginRequest();
    const given = [input.file, input.files, input.source].filter((x) => x !== undefined).length;
    if (given !== 1) {
      throw new ToolError('Pass exactly one of `file`, `files` or `source`.');
    }
    if (input.source !== undefined) {
      const source = input.source;
      return this.documents.withInline(source, (f) => {
        if (!f.isShader) return notAShader('The source');
        return formatProblems('<source>', source, this.problemsOf(f));
      });
    }

    const reports: string[] = [];
    const clean: string[] = [];
    let checked = 0;
    let truncated = false;
    for (const requested of input.files ?? [input.file ?? '']) {
      const path = this.workspace.resolve(requested);
      if (this.workspace.isDirectory(path)) {
        const shaders = this.shadersUnder(path);
        truncated ||= shaders.truncated;
        if (shaders.paths.length === 0) {
          reports.push(`${this.workspace.display(path)}: no "use typeshade" files under it.`);
        }
        for (const shader of shaders.paths) {
          if (checked >= CHECK_FILE_LIMIT) {
            truncated = true;
            break;
          }
          checked++;
          this.reportOn(this.documents.open(shader), reports, clean);
        }
      } else {
        checked++;
        const f = this.documents.open(path);
        if (!f.isShader) reports.push(notAShader(this.workspace.display(path)));
        else this.reportOn(f, reports, clean);
      }
    }
    const out: string[] = [];
    if (checked > 1) {
      out.push(`Checked ${plural(checked, 'shader file')}: ${reports.length} with problems.`);
    }
    out.push(...reports);
    if (clean.length > 0) out.push(`No problems: ${clean.join(', ')}`);
    if (truncated) {
      out.push(`Stopped at ${CHECK_FILE_LIMIT} files; name a smaller directory to see the rest.`);
    }
    return out.join('\n\n');
  }

  /**
   * The compiler's output for one shader: WGSL, GLSL ES 3.00, the reflection, and the
   * determinism report, whichever are asked for.
   *
   * @param input - the shader, and which outputs to print (WGSL alone by default).
   * @returns the diagnostics, then each output in a fenced block.
   */
  compile(input: SourceInput & { targets?: readonly OutputKind[] }): string {
    this.documents.beginRequest();
    const { display, fileName, text } = this.sourceOf(input);
    const result = compile(text, { fileName });
    const out: string[] = [];
    if (result.diagnostics.length > 0) {
      out.push(formatProblems(display, text, result.diagnostics.map(fromCompilerDiagnostic)));
    }
    if (result.wgsl === undefined) {
      out.push(
        'Nothing was emitted: the shader did not compile. Fix the errors above; `check` also ' +
          "reports TypeScript's own type errors for the file.",
      );
      return out.join('\n\n');
    }
    for (const target of unique(input.targets ?? ['wgsl'])) {
      if (target === 'wgsl') {
        out.push(`WGSL:\n${fenced('wgsl', result.wgsl)}`);
      } else if (target === 'glsl') {
        if (result.glsl === undefined) {
          const renders = result.module.funcs.some((f) => {
            const stage = stageOf(f);
            return stage === 'vertex' || stage === 'fragment';
          });
          out.push(
            renders
              ? 'No GLSL: the GLSL ES 3.00 emitter refused this module; the warning above says why.'
              : 'No GLSL: the module has no vertex or fragment entry, and GLSL ES 3.00 has no compute stage.',
          );
        } else {
          out.push(
            `GLSL ES 3.00, vertex stage:\n${fenced('glsl', result.glsl.vertex)}`,
            `GLSL ES 3.00, fragment stage:\n${fenced('glsl', result.glsl.fragment)}`,
          );
        }
      } else if (target === 'reflection') {
        out.push(`Reflection:\n${fenced('json', JSON.stringify(reflect(result.module), null, 2))}`);
      } else {
        out.push(describeDeterminism(result.determinism));
      }
    }
    return out.join('\n\n');
  }

  /**
   * The compiler's type and documentation for the name at a position.
   */
  hover(input: LocationInput): string {
    const at = this.locate(input);
    const hover = this.documents.shade.getHover(at.file.uri, at.position);
    if (hover === undefined) {
      return `Nothing to show at ${at.where}: ${JSON.stringify(at.lineText.trim())}`;
    }
    return `${at.where}\n\n${hover.contents}`;
  }

  /**
   * Where the name at a position is declared.
   */
  definition(input: LocationInput): string {
    const at = this.locate(input);
    const locations = this.documents.shade.getDefinition(at.file.uri, at.position);
    if (locations.length === 0) {
      const name = identifierAt(at.lineText, at.position.character);
      return name !== undefined && this.vocab().has(name)
        ? `${name} is part of TypeShade itself, with no declaration in your files. ` +
            `\`docs\` with name "${name}" describes it.`
        : `No declaration found for the name at ${at.where}.`;
    }
    return this.listLocations('Declared at', locations);
  }

  /**
   * Every use of the name at a position, across the workspace's shader files.
   */
  references(input: LocationInput): string {
    const at = this.locate(input);
    // The service answers from the documents it holds, so every shader in the workspace is
    // brought in first; otherwise a use in a file the agent never checked would be missed.
    for (const root of this.workspace.roots) {
      for (const shader of this.shadersUnder(root).paths) this.documents.open(shader);
    }
    const locations = this.documents.shade.getReferences(at.file.uri, at.position, {
      includeDeclaration: true,
    });
    if (locations.length === 0) return `No references to the name at ${at.where}.`;
    return this.listLocations(`${plural(locations.length, 'reference')}`, locations);
  }

  /**
   * The declarations of one shader file, with the compiler's type for each.
   */
  outline(input: { file: string }): string {
    this.documents.beginRequest();
    const path = this.workspace.resolve(input.file);
    const display = this.workspace.display(path);
    const f = this.documents.open(path);
    if (!f.isShader) return notAShader(display);
    const symbols = this.documents.shade.getDocumentSymbols(f.uri);
    if (symbols.length === 0) return `${display}: no declarations.`;
    const out = [`${display}:`];
    for (const symbol of symbols) {
      const { code, note } = this.signatureAt(f.uri, symbol.selectionRange.start);
      const first = symbol.range.start.line + 1;
      const last = symbol.range.end.line + 1;
      const lines = first === last ? `line ${first}` : `lines ${first}-${last}`;
      const stage = symbol.kind === 'entry' && symbol.detail ? `, ${symbol.detail} entry` : '';
      out.push(
        `${symbol.kind} ${code ?? symbol.name}  (${lines}${stage})${note ? `  ${note}` : ''}`,
      );
      if (symbol.kind === 'struct') {
        for (const field of symbol.children ?? []) {
          const sig = this.signatureAt(f.uri, field.selectionRange.start).code;
          out.push(`  ${sig ?? field.name}`);
        }
      }
    }
    return out.join('\n');
  }

  /**
   * The vocabulary, or what one name in it means.
   */
  docs(input: { name?: string }): string {
    return input.name === undefined || input.name.trim() === ''
      ? this.vocab().index()
      : this.vocab().lookup(input.name);
  }

  /**
   * Runs a function of a shader on the CPU.
   */
  run(input: SourceInput & RunRequest): string {
    this.documents.beginRequest();
    const { display, fileName, text } = this.sourceOf(input);
    const result = compile(text, { fileName });
    if (result.diagnostics.some((d) => d.category === 'error')) {
      throw new ToolError(
        `${display} does not compile, so nothing can run.\n\n` +
          formatProblems(display, text, result.diagnostics.map(fromCompilerDiagnostic)),
      );
    }
    return runOnCpu(result.module, input);
  }

  /** The problems in one open shader, as the compiler's own check finds them
   *  (`checkOpenDocument`, the one `typeshade check` runs): the editor's diagnostics, then
   *  whatever the emitters refuse, which the editor's front-end analysis never runs into. One
   *  check, so this tool, the command and the editor cannot give two answers about one file. */
  private problemsOf(f: OpenedFile): Problem[] {
    return checkOpenDocument(this.documents.shade, {
      path: f.uri,
      uri: f.uri,
      text: f.text,
    }).map(fromCheckDiagnostic);
  }

  /** Adds one file's report to the lists `check` prints. */
  private reportOn(f: OpenedFile, reports: string[], clean: string[]): void {
    const display = this.workspace.display(f.uri);
    const problems = this.problemsOf(f);
    if (problems.length === 0) clean.push(display);
    else reports.push(formatProblems(display, f.text, problems));
  }

  /** The `"use typeshade"` files under a directory. */
  private shadersUnder(directory: string): { paths: string[]; truncated: boolean } {
    const { files, truncated } = this.workspace.listTypeScriptFiles(directory);
    const paths = files.filter((file) => {
      const text = this.workspace.read(file);
      // The substring test is only a filter in front of the real rule, which is a parse.
      return (
        text !== undefined &&
        text.includes('use typeshade') &&
        textHasDirective(typescript, file, text)
      );
    });
    return { paths, truncated };
  }

  /** A file or source text, read. */
  private sourceOf(input: SourceInput): { display: string; fileName: string; text: string } {
    if (input.file !== undefined && input.source !== undefined) {
      throw new ToolError('Pass `file` or `source`, not both.');
    }
    if (input.source !== undefined) {
      return { display: '<source>', fileName: 'source.shade.ts', text: input.source };
    }
    if (input.file === undefined) {
      throw new ToolError(
        'Pass `file`, the path of a "use typeshade" file, or `source`, its text.',
      );
    }
    const path = this.workspace.resolve(input.file);
    const display = this.workspace.display(path);
    if (this.workspace.isDirectory(path))
      throw new ToolError(`${display} is a directory; name one file.`);
    const text = this.workspace.read(path);
    if (text === undefined) throw new ToolError(`${display} could not be read.`);
    return { display, fileName: toUri(path), text };
  }

  /** A navigation request's file, opened, and its position, converted. */
  private locate(input: LocationInput): {
    file: OpenedFile;
    position: { line: number; character: number };
    lineText: string;
    where: string;
  } {
    this.documents.beginRequest();
    const path = this.workspace.resolve(input.file);
    const display = this.workspace.display(path);
    if (this.workspace.isDirectory(path))
      throw new ToolError(`${display} is a directory; name one file.`);
    const file = this.documents.open(path);
    if (!file.isShader) throw new ToolError(notAShader(display));
    const { position, lineText } = toPosition(file.text, input);
    const where = `${display}:${position.line + 1}:${position.character + 1}`;
    return { file, position, lineText, where };
  }

  /** Locations as `path:line:column` with the line's text, one per line. */
  private listLocations(heading: string, locations: readonly TypeshadeLocation[]): string {
    const texts = new Map<string, string[]>();
    const out = [`${heading}:`];
    for (const { uri, range } of locations) {
      if (!texts.has(uri)) texts.set(uri, linesOf(this.workspace.read(uri) ?? ''));
      const line = texts.get(uri)?.[range.start.line]?.trim() ?? '';
      out.push(
        `${this.workspace.display(uri)}:${range.start.line + 1}:${range.start.character + 1}  ${line}`,
      );
    }
    return out.join('\n');
  }

  /** The first line of the hover's code block, without the keyword TypeScript puts in front,
   *  and the sentence after the block when there is one (a resource's binding slot). */
  private signatureAt(
    uri: string,
    position: { line: number; character: number },
  ): { code?: string; note?: string } {
    const contents = this.documents.shade.getHover(uri, position)?.contents;
    if (contents === undefined) return {};
    const block = /```ts\n([^\n]*)\n```/.exec(contents);
    const code = block?.[1]
      .replace(/^\((property|parameter)\) (\w+\.)?/, '')
      .replace(/^(class|function|const|let|var|interface|type) /, '');
    const after = block ? contents.slice(block.index + block[0].length).trim() : '';
    const note = after.split('\n')[0] || undefined;
    return { code, note };
  }

  /** The vocabulary, parsed on first use: it reads the whole ambient lib, which a server that is
   *  only ever asked to check files does not need. */
  private vocab(): Vocabulary {
    this.vocabulary ??= new Vocabulary();
    return this.vocabulary;
  }
}

/** The answer for a file that is ordinary TypeScript. */
function notAShader(display: string): string {
  return (
    `${display} has no "use typeshade" directive, so it is ordinary TypeScript and TypeShade ` +
    'does not compile it. A shader file starts with the line "use typeshade".'
  );
}

/** The determinism report in words. */
function describeDeterminism(
  entries: readonly {
    op: string;
    elem: string;
    accuracy: string;
    count: number;
    where: readonly string[];
    note?: string;
  }[],
): string {
  if (entries.length === 0) {
    return 'Determinism: every operation has one answer, so a GPU result and the CPU run can differ only by rounding.';
  }
  const lines = entries.map(
    (e) =>
      `- ${e.op} (${e.elem}): ${e.accuracy}; ${plural(e.count, 'use')} in ${e.where.join(', ')}` +
      (e.note ? `. ${e.note}` : ''),
  );
  return `Determinism: these operations may give different results on different GPUs:\n${lines.join('\n')}`;
}

/** The identifier around a column, for naming what a definition request pointed at. */
function identifierAt(lineText: string, character: number): string | undefined {
  const match = [...lineText.matchAll(/[A-Za-z_$][\w$]*/g)].find(
    (m) => m.index <= character && character <= m.index + m[0].length,
  );
  return match?.[0];
}

/** A list without repeats, in first-seen order. */
function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}
