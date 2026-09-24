// === What the preview panel shows, with no `vscode` in it ===
//
// `docs/design.md` §4 decides that the extension runs its own `TypeshadeLanguageService` in the
// extension host, because VS Code gives an extension no supported request channel to a tsserver
// plugin. This is that service and the four tabs over it. It imports nothing from `vscode`, so
// §6's rule holds: the extension's logic is unit-tested with vitest, and a blocked electron run
// is a gap in integration coverage rather than in coverage.
//
// The two services cannot disagree. Both are pure functions of the text they hold, and both hold
// tsserver's text: the plugin gets it from tsserver's snapshots, this one from the editor's
// documents. What the duplication costs is measured in §4: 15.5 MB retained for the one-document
// case, almost all of it the service's fixed cost rather than per document.

import {
  compileTsSource,
  createTypeshadeLanguageService,
  reflect,
  type EntryInfo,
  type FuncDecl,
  type ModuleDecl,
  type TypeshadeDiagnostic,
  type TypeshadeLanguageService,
  type TypeshadeLanguageServiceHost,
} from './compiler.js';

/** The panel's four tabs. The first three are `getCompiledOutput` targets and the fourth is not,
 *  which is why `output` branches on it. */
export type PreviewTab = 'wgsl' | 'glsl-vertex' | 'glsl-fragment' | 'reflection';

/** Every tab, in the order the panel shows them. */
export const PREVIEW_TABS: readonly PreviewTab[] = [
  'wgsl',
  'glsl-vertex',
  'glsl-fragment',
  'reflection',
];

/** What the panel renders for one tab. */
export interface PreviewOutput {
  /** The tab this is for. */
  readonly tab: PreviewTab;
  /** The text to show, which is the previous good output when `stale`. */
  readonly text: string;
  /** True when the document does not compile right now and `text` is what it last produced.
   *  §4: a blank panel while you are mid-edit is worse than a stale one that says it is stale. */
  readonly stale: boolean;
  /** What stopped it, empty when nothing did. Not rendered as a list: diagnostics belong to the
   *  Problems view, and §4 keeps them out of the panel. These are for the one-line banner. */
  readonly diagnostics: readonly TypeshadeDiagnostic[];
}

/** One entry point, as the run and status-bar features need it. */
export interface Entry {
  /** The exported function's name. */
  readonly name: string;
  /** Its pipeline stage. */
  readonly stage: EntryInfo['stage'];
  /** Its parameters, in order, as the CPU oracle will want them. Taken from the declaration
   *  rather than from `EntryInfo.io.inputs`, which flattens a struct parameter into its fields
   *  and so does not line up with what the compiled function takes. */
  readonly params: FuncDecl['params'];
}

/** A document the model holds. */
interface Held {
  readonly text: string;
  readonly version: number;
}

/**
 * The extension host's own view of the open shaders.
 *
 * One instance per extension activation. Documents are pushed in by whoever watches the editor;
 * nothing here reads a file.
 */
export class PreviewModel {
  private readonly service: TypeshadeLanguageService;
  private readonly held = new Map<string, Held>();
  /** The last output that compiled, per document and tab, so an edit that breaks the file shows
   *  the previous text greyed out instead of nothing. */
  private readonly lastGood = new Map<string, string>();
  /** `reflect` is not a language service method, so its input has to be rebuilt from source.
   *  Cached per document version, because the panel asks on every keystroke behind the debounce
   *  and the status bar asks on every editor change. */
  private readonly modules = new Map<string, { version: number; module: ModuleDecl | undefined }>();

  constructor(host?: TypeshadeLanguageServiceHost) {
    this.service = createTypeshadeLanguageService(host);
  }

  /**
   * Adds a document, or replaces the text of one already held.
   *
   * @param uri - the document's uri, which is also what `getCompiledOutput` is asked about.
   * @param text - its whole current text.
   * @param version - the editor's version, which only has to move when the text does.
   */
  setDocument(uri: string, text: string, version: number): void {
    const previous = this.held.get(uri);
    if (previous?.version === version && previous.text === text) return;
    if (previous === undefined) this.service.openDocument(uri, text, version);
    else this.service.updateDocument(uri, text, version);
    this.held.set(uri, { text, version });
  }

  /**
   * Drops a document and everything remembered about it.
   *
   * @param uri - the document to drop.
   */
  closeDocument(uri: string): void {
    if (!this.held.delete(uri)) return;
    this.service.closeDocument(uri);
    this.modules.delete(uri);
    for (const tab of PREVIEW_TABS) this.lastGood.delete(key(uri, tab));
  }

  /** Whether the model holds `uri`. */
  has(uri: string): boolean {
    return this.held.has(uri);
  }

  /**
   * What the panel should render for one tab.
   *
   * @param uri - the document.
   * @param tab - which tab.
   * @returns the text and whether it is stale, or undefined when the document is not held.
   */
  output(uri: string, tab: PreviewTab): PreviewOutput | undefined {
    if (!this.held.has(uri)) return undefined;
    if (tab === 'reflection') {
      const module = this.moduleOf(uri);
      const diagnostics = this.service.getDiagnostics(uri);
      const text = module === undefined ? '' : `${JSON.stringify(reflect(module), null, 2)}\n`;
      return this.settle(uri, tab, text, diagnostics);
    }
    const compiled = this.service.getCompiledOutput(uri, tab);
    if (compiled === undefined) return undefined;
    return this.settle(uri, tab, compiled.text, compiled.diagnostics);
  }

  /**
   * The entry points of a document, for the run command's picker and the status bar's count.
   *
   * @param uri - the document.
   * @returns the entries, empty when the document does not compile or holds none.
   */
  entries(uri: string): readonly Entry[] {
    const module = this.moduleOf(uri);
    if (module === undefined) return [];
    const declared = new Map(module.funcs.map((fn) => [fn.name, fn]));
    return reflect(module)
      .entries.map((entry) => {
        const fn = declared.get(entry.name);
        return fn === undefined
          ? undefined
          : { name: entry.name, stage: entry.stage, params: fn.params };
      })
      .filter((entry): entry is Entry => entry !== undefined);
  }

  /**
   * The module declaration of a document, for a caller that runs an entry on the CPU.
   *
   * @param uri - the document.
   * @returns the module, or undefined when the document does not compile.
   */
  module(uri: string): ModuleDecl | undefined {
    return this.moduleOf(uri);
  }

  /** Records an output that compiled, or falls back to the last one that did. */
  private settle(
    uri: string,
    tab: PreviewTab,
    text: string,
    diagnostics: readonly TypeshadeDiagnostic[],
  ): PreviewOutput {
    if (!diagnostics.some((d) => d.severity === 'error')) {
      this.lastGood.set(key(uri, tab), text);
      return { tab, text, stale: false, diagnostics };
    }
    const previous = this.lastGood.get(key(uri, tab));
    return { tab, text: previous ?? '', stale: previous !== undefined, diagnostics };
  }

  /** The document's `ModuleDecl`, built once per version.
   *
   *  `emit: false` matches what the service does for its own analysis, so this pass reports the
   *  same diagnostics rather than a second opinion; the module is dropped when any of them is an
   *  error, because a module assembled from a file that did not compile is not one `reflect` or
   *  the oracle should be handed. */
  private moduleOf(uri: string): ModuleDecl | undefined {
    const document = this.held.get(uri);
    if (document === undefined) return undefined;
    const cached = this.modules.get(uri);
    if (cached?.version === document.version) return cached.module;
    const result = compileTsSource(document.text, { emit: false, fileName: uri });
    const failed = result.diagnostics.some((d) => d.category === 'error');
    const module = failed
      ? undefined
      : {
          consts: [...result.consts],
          structs: result.structs.map((struct) => struct.decl),
          bindings: [...result.bindings],
          funcs: [...result.funcs],
        };
    this.modules.set(uri, { version: document.version, module });
    return module;
  }
}

/** The key one document's one tab is remembered under. A newline cannot appear in either half. */
function key(uri: string, tab: PreviewTab): string {
  return `${uri}\n${tab}`;
}
