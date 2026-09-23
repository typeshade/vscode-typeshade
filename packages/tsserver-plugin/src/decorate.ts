// === The decorated language service ===
//
// Two rules decide every method (`docs/design.md` §3). For a file without the directive, the
// project's own method is called and its result returned unchanged, with no mapping layer in
// the path at all. For a file with the directive, the answer comes from the TypeShade service
// and the two are never merged, because merging is how a false positive survives.
//
// The third rule is the one that was nearly missed: "everything else is passed through" leaks.
// A decoration that overrides a few members and forwards the rest forwards methods that answer
// from the project's program, which for a shader is the wrong program. So the remainder is two
// explicit lists rather than a sentence, and both are written out below.

import type ts from 'typescript';
import { createTypeshadeLanguageService, type TypeshadeLanguageService } from './compiler.js';
import { DocumentSync } from './documents.js';
import { isTypeshadeFile } from './directive.js';
import {
  toClassifications,
  toCompletionEntryDetails,
  toCompletionInfo,
  toDefinitionInfos,
  toNavigationBarItems,
  toNavigationTree,
  toQuickInfo,
  toReferenceEntries,
  toReferencedSymbols,
  toRenameLocations,
  toSignatureHelpItems,
  toTsDiagnostic,
  withoutSyntacticDuplicates,
  type ConvertContext,
} from './convert.js';

/** `getRegionSemanticDiagnostics` is called by tsserver (`typescript.js:190872`, behind a
 *  500-line threshold at 189923) and is NOT declared in `typescript.d.ts`. A decoration that
 *  only overrides declared members therefore leaks TypeScript's own errors back into any shader
 *  of 500 lines or more, and only into those, which is the worst possible size for a bug to
 *  appear at. This is the shape the cast asserts. */
interface UndeclaredMembers {
  getRegionSemanticDiagnostics?(
    fileName: string,
    ranges: readonly ts.TextRange[],
  ): { diagnostics: ts.Diagnostic[]; spans?: readonly ts.TextSpan[] } | undefined;
  /** `mapCode` is the other member tsserver calls that `typescript.d.ts` does not declare
   *  (`typescript.js:150931`, and `mapCode` appears in the declarations only as a private
   *  session method). It rewrites pasted code to fit its destination, which for a shader means
   *  the project's program writing TypeScript into a `"use typeshade"` file. */
  mapCode?(
    fileName: string,
    contents: readonly string[],
    focusLocations: readonly (readonly ts.TextSpan[])[] | undefined,
    formatOptions: ts.FormatCodeSettings,
    preferences: ts.UserPreferences,
  ): readonly ts.FileTextChanges[];
}

/** A `ts.TextRange` as the `ts.TextSpan` tsserver's event formatter expects. */
function toTextSpan(range: ts.TextRange): ts.TextSpan {
  return { start: range.pos, length: range.end - range.pos };
}

/** What the plugin writes to the tsserver log, so a failure is findable rather than silent. */
export type Log = (message: string) => void;

/**
 * Builds the language service tsserver uses in place of the project's own.
 *
 * @param info - what tsserver hands the plugin: the project's service, its host, and the
 *   project itself.
 * @param typescript - the host's own `typescript` module. Never one this package imports: a
 *   second instance would build nodes the host's `ts.is*` checks do not recognise.
 * @param log - where to report a failure.
 * @returns the decorated service.
 */
export function decorate(
  info: ts.server.PluginCreateInfo,
  typescript: typeof ts,
  log: Log,
): ts.LanguageService {
  const inner = info.languageService;

  // The service and the document sync refer to each other: the service asks for an imported
  // file through `readDocument`, and the sync answers from tsserver's snapshots. The indirection
  // is one closure rather than a setter, so `sync` is never observably half-built.
  let sync: DocumentSync | undefined;
  const shade: TypeshadeLanguageService = createTypeshadeLanguageService({
    readDocument: (uri) => sync?.readDocument(uri),
  });
  sync = new DocumentSync(typescript, info.languageServiceHost, shade);
  const ctx: ConvertContext = { typescript, shade };
  const documents = sync;

  /** Whether this request is about a TypeShade file, having brought the file into the TypeShade
   *  program (or taken it out, when its directive was just deleted). */
  function isShade(fileName: string): boolean {
    const directive = isTypeshadeFile(inner, fileName);
    const held = documents.sync(fileName, directive);
    return directive && held;
  }

  /** The service's own source file for a synced document, for the spans a conversion needs. */
  function sourceFileOf(fileName: string): ts.SourceFile | undefined {
    return inner.getProgram()?.getSourceFile(fileName);
  }

  /** The identifier CONTAINING `position`, as a name and a span.
   *
   *  Containing, not starting at: an earlier version sliced the text from the cursor, so a
   *  request in the middle of `tint` named the symbol `nt` and gave the bound span the last two
   *  characters. The token comes from the file tsserver already parsed, which is the same
   *  syntax the service sees. */
  function identifierAt(fileName: string, position: number): { name: string; span: ts.TextSpan } {
    const sourceFile = sourceFileOf(fileName);
    const empty = { name: '', span: { start: position, length: 0 } };
    if (!sourceFile) return empty;
    let found: ts.Node | undefined;
    const visit = (node: ts.Node): void => {
      if (node.getStart(sourceFile) > position || node.end < position) return;
      if (typescript.isIdentifier(node) || typescript.isStringLiteral(node)) found = node;
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
    if (!found) return empty;
    const start = found.getStart(sourceFile);
    return { name: found.getText(sourceFile), span: { start, length: found.end - start } };
  }

  /** The span a signature help popup stays open over: the argument list of the call the cursor
   *  is inside. The service reports no such span, and the syntax it needs is the same syntax
   *  tsserver already parsed, so this reads it from there rather than inventing one. */
  function argumentSpan(fileName: string, position: number): ts.TextSpan {
    const sourceFile = sourceFileOf(fileName);
    if (!sourceFile) return { start: position, length: 0 };
    let found: ts.CallExpression | undefined;
    const visit = (node: ts.Node): void => {
      if (node.getStart(sourceFile) > position || node.end < position) return;
      if (typescript.isCallExpression(node)) found = node;
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
    if (!found) return { start: position, length: 0 };
    const open = found.arguments.pos;
    return { start: open, length: Math.max(0, found.end - 1 - open) };
  }

  const proxy: ts.LanguageService = Object.create(null) as ts.LanguageService;
  for (const key of Object.keys(inner) as (keyof ts.LanguageService)[]) {
    // The forwarding default. Every override below replaces one of these entries, and anything
    // not named stays exactly what the project's service does, argument for argument.
    const member = inner[key];
    if (typeof member === 'function') {
      Object.defineProperty(proxy, key, {
        value: (...args: unknown[]) => (member as (...a: unknown[]) => unknown).apply(inner, args),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } else {
      Object.defineProperty(proxy, key, { value: member, writable: true, enumerable: true });
    }
  }

  /** Replaces one member of the proxy. Written once so every override below reads as a table. */
  function override<K extends keyof ts.LanguageService>(
    key: K,
    value: ts.LanguageService[K],
  ): void {
    Object.defineProperty(proxy, key, { value, writable: true, enumerable: true });
  }

  /** The file a request is about, for a method whose first argument is the file name. Most of
   *  them are, and the ones that are not are the reason this is a parameter at all: an earlier
   *  version tested `typeof args[0] === 'string'` and so silently forwarded every method that
   *  takes an options object first, which is how Fix All wrote a TypeScript function stub into
   *  a shader. */
  const firstArgument = (args: readonly unknown[]): string | undefined =>
    typeof args[0] === 'string' ? args[0] : undefined;

  /** The file name inside an options object, by property. `getCombinedCodeFix` and
   *  `organizeImports` carry `scope.fileName` / `args.fileName` (`CombinedCodeFixScope`), and
   *  `getPasteEdits` carries `args.targetFile`. */
  const namedProperty =
    (property: 'fileName' | 'targetFile') =>
    (args: readonly unknown[]): string | undefined => {
      const first = args[0];
      if (typeof first !== 'object' || first === null) return undefined;
      const value = (first as Record<string, unknown>)[property];
      return typeof value === 'string' ? value : undefined;
    };

  /** Answers nothing for a TypeShade file, and forwards otherwise. The list of methods that get
   *  this treatment is the second of the two explicit lists: each would otherwise answer from
   *  the project's program, where a shader's names do not resolve. */
  function nothingForShaders<K extends keyof ts.LanguageService>(
    key: K,
    empty: (
      ...args: Parameters<Extract<ts.LanguageService[K], (...a: never[]) => unknown>>
    ) => unknown,
    fileOf: (args: readonly unknown[]) => string | undefined = firstArgument,
  ): void {
    const member = inner[key] as unknown as (...a: unknown[]) => unknown;
    override(key, ((...args: unknown[]) => {
      const fileName = fileOf(args);
      if (fileName !== undefined && isShade(fileName)) {
        return (empty as (...a: unknown[]) => unknown)(...args);
      }
      return member.apply(inner, args);
    }) as unknown as ts.LanguageService[K]);
  }

  // ── diagnostics ──────────────────────────────────────────────────────────────────────────

  override('getSemanticDiagnostics', (fileName) => {
    if (!isShade(fileName)) return inner.getSemanticDiagnostics(fileName);
    const sourceFile = sourceFileOf(fileName);
    if (!sourceFile) return inner.getSemanticDiagnostics(fileName);
    // Deduplicated BEFORE conversion, while `source` still says which half a diagnostic came
    // from: the syntactic pass is passed through untouched, and the service's own answer carries
    // the TypeShade program's copy of the same parse errors.
    return withoutSyntacticDuplicates(
      shade.getDiagnostics(fileName),
      inner.getSyntacticDiagnostics(fileName),
    ).map((d) => toTsDiagnostic(ctx, sourceFile, d));
  });

  // Syntactic diagnostics are passed through untouched: a parse error does not depend on the
  // library or the ambient declarations, and the grammar errors that look syntactic are not
  // reported there (the probe measured TS1206 arriving as semantic with the syntactic pass
  // empty). Nothing to override.

  override('getSuggestionDiagnostics', (fileName) =>
    isShade(fileName) ? [] : inner.getSuggestionDiagnostics(fileName),
  );

  {
    // The two members tsserver calls that `typescript.d.ts` does not declare. Overridden through
    // one cast each, because the alternative is a 500-line shader quietly getting TypeScript's
    // errors back, and a paste into a shader quietly getting TypeScript's rewrite.
    const undeclared = inner as unknown as UndeclaredMembers;
    const proxied = proxy as unknown as UndeclaredMembers;
    if (typeof undeclared.getRegionSemanticDiagnostics === 'function') {
      const forward = undeclared.getRegionSemanticDiagnostics.bind(inner);
      proxied.getRegionSemanticDiagnostics = (fileName, ranges) =>
        // The requested ranges are echoed back as the answer's spans: tsserver publishes them
        // on the `regionSemanticDiag` event so a client knows which part of the file the empty
        // answer covers, and an answer with no spans is one a client cannot place.
        //
        // The conversion is not cosmetic. tsserver maps every span with `toProtocolTextSpan`
        // (`typescript.js:190895`), which reads `start` and `length`; echoing the ranges as they
        // arrive, which are `{ pos, end }`, threw inside the event send and cost the whole
        // `regionSemanticDiag` event, visible only as one `Exception on executing command`
        // line in the server log.
        isShade(fileName)
          ? { diagnostics: [], spans: ranges.map(toTextSpan) }
          : forward(fileName, ranges);
    }
    if (typeof undeclared.mapCode === 'function') {
      const forward = undeclared.mapCode.bind(inner);
      proxied.mapCode = (fileName, contents, focusLocations, formatOptions, preferences) =>
        isShade(fileName)
          ? []
          : forward(fileName, contents, focusLocations, formatOptions, preferences);
    }
  }

  // ── hover, completions, signature help ───────────────────────────────────────────────────

  override('getQuickInfoAtPosition', (fileName, position) => {
    if (!isShade(fileName)) return inner.getQuickInfoAtPosition(fileName, position);
    const hover = shade.getHover(fileName, shade.positionAt(fileName, position));
    return hover === undefined ? undefined : toQuickInfo(ctx, fileName, hover);
  });

  override('getCompletionsAtPosition', (fileName, position, options, formatting) => {
    if (!isShade(fileName)) {
      return inner.getCompletionsAtPosition(fileName, position, options, formatting);
    }
    const items = shade.getCompletions(fileName, shade.positionAt(fileName, position));
    return items.length === 0 ? undefined : toCompletionInfo(ctx, fileName, items);
  });

  override(
    'getCompletionEntryDetails',
    (fileName, position, entryName, formatting, source, preferences, data) => {
      if (!isShade(fileName)) {
        return inner.getCompletionEntryDetails(
          fileName,
          position,
          entryName,
          formatting,
          source,
          preferences,
          data,
        );
      }
      const items = shade.getCompletions(fileName, shade.positionAt(fileName, position));
      const item = items.find((candidate) => candidate.label === entryName);
      return item === undefined ? undefined : toCompletionEntryDetails(ctx, item);
    },
  );

  override('getSignatureHelpItems', (fileName, position, options) => {
    if (!isShade(fileName)) return inner.getSignatureHelpItems(fileName, position, options);
    const help = shade.getSignatureHelp(fileName, shade.positionAt(fileName, position));
    return help === undefined
      ? undefined
      : toSignatureHelpItems(help, argumentSpan(fileName, position));
  });

  // ── navigation ───────────────────────────────────────────────────────────────────────────

  override('getDefinitionAndBoundSpan', (fileName, position) => {
    if (!isShade(fileName)) return inner.getDefinitionAndBoundSpan(fileName, position);
    const identifier = identifierAt(fileName, position);
    const definitions = shade.getDefinition(fileName, shade.positionAt(fileName, position));
    if (definitions.length === 0) return undefined;
    return {
      definitions: toDefinitionInfos(ctx, definitions, identifier.name),
      textSpan: identifier.span,
    };
  });

  for (const key of [
    'getDefinitionAtPosition',
    'getTypeDefinitionAtPosition',
    'getImplementationAtPosition',
  ] as const) {
    const forward = inner[key].bind(inner);
    override(key, ((fileName: string, position: number) => {
      if (!isShade(fileName)) return forward(fileName, position);
      const definitions = shade.getDefinition(fileName, shade.positionAt(fileName, position));
      return definitions.length === 0
        ? undefined
        : toDefinitionInfos(ctx, definitions, identifierAt(fileName, position).name);
    }) as unknown as ts.LanguageService[typeof key]);
  }

  override('findReferences', (fileName, position) => {
    if (!isShade(fileName)) return inner.findReferences(fileName, position);
    const at = shade.positionAt(fileName, position);
    const references = shade.getReferences(fileName, at, { includeDeclaration: true });
    if (references.length === 0) return undefined;
    const declarations = shade.getDefinition(fileName, at);
    return toReferencedSymbols(
      ctx,
      references,
      declarations,
      identifierAt(fileName, position).name,
    );
  });

  override('getReferencesAtPosition', (fileName, position) => {
    if (!isShade(fileName)) return inner.getReferencesAtPosition(fileName, position);
    const at = shade.positionAt(fileName, position);
    const references = shade.getReferences(fileName, at, { includeDeclaration: true });
    if (references.length === 0) return undefined;
    return toReferenceEntries(ctx, references, shade.getDefinition(fileName, at));
  });

  override('getRenameInfo', (fileName, position, preferences) => {
    if (!isShade(fileName)) return inner.getRenameInfo(fileName, position, preferences);
    const prepared = shade.prepareRename(fileName, shade.positionAt(fileName, position));
    if (prepared === undefined) {
      return {
        canRename: false,
        localizedErrorMessage: 'This element cannot be renamed in a "use typeshade" file.',
      };
    }
    const span = {
      start: shade.offsetAt(fileName, prepared.range.start),
      length:
        shade.offsetAt(fileName, prepared.range.end) -
        shade.offsetAt(fileName, prepared.range.start),
    };
    return {
      canRename: true,
      displayName: prepared.placeholder,
      fullDisplayName: prepared.placeholder,
      kind: typescript.ScriptElementKind.unknown,
      kindModifiers: '',
      triggerSpan: span,
    };
  });

  // `findRenameLocations` is overloaded on its last parameter (a `UserPreferences` or the older
  // boolean), and an override sees the union, which matches neither overload. One cast, here,
  // rather than a branch that calls the same method twice to pick an overload.
  const forwardRename = inner.findRenameLocations.bind(inner) as (
    fileName: string,
    position: number,
    findInStrings: boolean,
    findInComments: boolean,
    preferences?: ts.UserPreferences | boolean,
  ) => readonly ts.RenameLocation[] | undefined;

  override('findRenameLocations', (fileName, position, findInStrings, findInComments, prefs) => {
    if (!isShade(fileName)) {
      return forwardRename(fileName, position, findInStrings, findInComments, prefs);
    }
    // The service refuses exactly what `prepareRename` refuses, so a placeholder name is all
    // this needs: the result is locations, and the editor writes the text.
    const edits = shade.rename(fileName, shade.positionAt(fileName, position), 'newName');
    const locations = toRenameLocations(ctx, edits);
    return locations.length === 0 ? undefined : locations;
  });

  override('getNavigationTree', (fileName) => {
    if (!isShade(fileName)) return inner.getNavigationTree(fileName);
    const symbols = shade.getDocumentSymbols(fileName);
    return toNavigationTree(
      ctx,
      fileName,
      symbols,
      fileName.split('/').pop() ?? fileName,
      sourceFileOf(fileName)?.text.length ?? 0,
    );
  });

  override('getNavigationBarItems', (fileName) => {
    if (!isShade(fileName)) return inner.getNavigationBarItems(fileName);
    return toNavigationBarItems(ctx, fileName, shade.getDocumentSymbols(fileName));
  });

  override('getEncodedSemanticClassifications', (fileName, span, format) => {
    if (!isShade(fileName)) return inner.getEncodedSemanticClassifications(fileName, span, format);
    // The conversion encodes the 2020 legend and nothing else, so a client asking for the
    // Original one would read those numbers against a different table. Dropping rather than
    // mislabelling is the same rule the token mapping follows.
    if (format !== typescript.SemanticClassificationFormat.TwentyTwenty) {
      return { spans: [], endOfLineState: typescript.EndOfLineState.None };
    }
    const range = {
      start: shade.positionAt(fileName, span.start),
      end: shade.positionAt(fileName, span.start + span.length),
    };
    return toClassifications(ctx, fileName, shade.getSemanticTokens(fileName, range));
  });

  // ── answered with nothing, because the project's program would answer from the wrong one ──

  override('getCodeFixesAtPosition', (fileName, start, end, codes, formatting, preferences) =>
    isShade(fileName)
      ? []
      : inner.getCodeFixesAtPosition(fileName, start, end, codes, formatting, preferences),
  );

  nothingForShaders('getCombinedCodeFix', () => ({ changes: [] }), namedProperty('fileName'));
  nothingForShaders('getDocumentHighlights', () => undefined);
  nothingForShaders('provideInlayHints', () => []);
  nothingForShaders('getApplicableRefactors', () => []);
  nothingForShaders('getEditsForRefactor', () => undefined);
  nothingForShaders('prepareCallHierarchy', () => undefined);
  nothingForShaders('provideCallHierarchyIncomingCalls', () => []);
  nothingForShaders('provideCallHierarchyOutgoingCalls', () => []);
  nothingForShaders('organizeImports', () => [], namedProperty('fileName'));
  nothingForShaders('getFileReferences', () => []);
  nothingForShaders('getDocCommentTemplateAtPosition', () => undefined);
  nothingForShaders('getJsxClosingTagAtPosition', () => undefined);
  nothingForShaders('getSupportedCodeFixes', () => []);
  nothingForShaders('getPasteEdits', () => ({ edits: [] }), namedProperty('targetFile'));

  // `getNavigateToItems` and `getEditsForFileRename` are project-wide rather than per-file, so
  // they cannot be filtered the way the list above is: their first argument is a search string
  // or an old path. A shader's symbols reaching a workspace symbol search from the project's
  // program is a cosmetic wrong answer rather than a wrong diagnostic, and filtering it needs
  // the service to answer workspace-wide, which it does not. Left forwarding, deliberately.

  log('[typeshade] language service decorated');
  return proxy;
}
