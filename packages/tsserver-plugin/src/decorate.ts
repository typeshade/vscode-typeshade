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

import type ts from 'typescript'
import { createTypeshadeLanguageService, type TypeshadeLanguageService } from './compiler.js'
import { DocumentSync } from './documents.js'
import { isTypeshadeFile } from './directive.js'
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
} from './convert.js'

/** `getRegionSemanticDiagnostics` is called by tsserver (`typescript.js:190872`, behind a
 *  500-line threshold at 189923) and is NOT declared in `typescript.d.ts`. A decoration that
 *  only overrides declared members therefore leaks TypeScript's own errors back into any shader
 *  of 500 lines or more, and only into those, which is the worst possible size for a bug to
 *  appear at. This is the shape the cast asserts. */
interface RegionDiagnosticsService {
  getRegionSemanticDiagnostics?(
    fileName: string,
    ranges: readonly ts.TextRange[],
  ): { diagnostics: ts.Diagnostic[]; spans?: readonly ts.TextSpan[] } | undefined
}

/** What the plugin writes to the tsserver log, so a failure is findable rather than silent. */
export type Log = (message: string) => void

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
  const inner = info.languageService

  // The service and the document sync refer to each other: the service asks for an imported
  // file through `readDocument`, and the sync answers from tsserver's snapshots. The indirection
  // is one closure rather than a setter, so `sync` is never observably half-built.
  let sync: DocumentSync | undefined
  const shade: TypeshadeLanguageService = createTypeshadeLanguageService({
    readDocument: (uri) => sync?.readDocument(uri),
  })
  sync = new DocumentSync(typescript, info.languageServiceHost, shade)
  const ctx: ConvertContext = { typescript, shade }
  const documents = sync

  /** Whether this request is about a TypeShade file, having brought the file into the TypeShade
   *  program (or taken it out, when its directive was just deleted). */
  function isShade(fileName: string): boolean {
    const directive = isTypeshadeFile(inner, fileName)
    const held = documents.sync(fileName, directive)
    return directive && held
  }

  /** The service's own source file for a synced document, for the spans a conversion needs. */
  function sourceFileOf(fileName: string): ts.SourceFile | undefined {
    return inner.getProgram()?.getSourceFile(fileName)
  }

  /** The identifier text at `position`, for the name a definition or reference carries. */
  function nameAt(fileName: string, position: number): string {
    const sourceFile = sourceFileOf(fileName)
    if (!sourceFile) return ''
    const match = /[A-Za-z_$][\w$]*/.exec(sourceFile.text.slice(position).split(/\W/)[0] ?? '')
    if (match) return match[0]
    const before = /[A-Za-z_$][\w$]*$/.exec(sourceFile.text.slice(0, position))
    return before ? before[0] : ''
  }

  /** The span a signature help popup stays open over: the argument list of the call the cursor
   *  is inside. The service reports no such span, and the syntax it needs is the same syntax
   *  tsserver already parsed, so this reads it from there rather than inventing one. */
  function argumentSpan(fileName: string, position: number): ts.TextSpan {
    const sourceFile = sourceFileOf(fileName)
    if (!sourceFile) return { start: position, length: 0 }
    let found: ts.CallExpression | undefined
    const visit = (node: ts.Node): void => {
      if (node.getStart(sourceFile) > position || node.end < position) return
      if (typescript.isCallExpression(node)) found = node
      node.forEachChild(visit)
    }
    sourceFile.forEachChild(visit)
    if (!found) return { start: position, length: 0 }
    const open = found.arguments.pos
    return { start: open, length: Math.max(0, found.end - 1 - open) }
  }

  const proxy: ts.LanguageService = Object.create(null) as ts.LanguageService
  for (const key of Object.keys(inner) as (keyof ts.LanguageService)[]) {
    // The forwarding default. Every override below replaces one of these entries, and anything
    // not named stays exactly what the project's service does, argument for argument.
    const member = inner[key]
    if (typeof member === 'function') {
      Object.defineProperty(proxy, key, {
        value: (...args: unknown[]) => (member as (...a: unknown[]) => unknown).apply(inner, args),
        writable: true,
        enumerable: true,
        configurable: true,
      })
    } else {
      Object.defineProperty(proxy, key, { value: member, writable: true, enumerable: true })
    }
  }

  /** Replaces one member of the proxy. Written once so every override below reads as a table. */
  function override<K extends keyof ts.LanguageService>(
    key: K,
    value: ts.LanguageService[K],
  ): void {
    Object.defineProperty(proxy, key, { value, writable: true, enumerable: true })
  }

  /** Answers nothing for a TypeShade file, and forwards otherwise. The list of methods that get
   *  this treatment is the second of the two explicit lists: each would otherwise answer from
   *  the project's program, where a shader's names do not resolve. */
  function nothingForShaders<K extends keyof ts.LanguageService>(
    key: K,
    empty: (
      ...args: Parameters<Extract<ts.LanguageService[K], (...a: never[]) => unknown>>
    ) => unknown,
  ): void {
    const member = inner[key] as unknown as (...a: unknown[]) => unknown
    override(key, ((...args: unknown[]) => {
      const fileName = args[0]
      if (typeof fileName === 'string' && isShade(fileName)) {
        return (empty as (...a: unknown[]) => unknown)(...args)
      }
      return member.apply(inner, args)
    }) as unknown as ts.LanguageService[K])
  }

  // ── diagnostics ──────────────────────────────────────────────────────────────────────────

  override('getSemanticDiagnostics', (fileName) => {
    if (!isShade(fileName)) return inner.getSemanticDiagnostics(fileName)
    const sourceFile = sourceFileOf(fileName)
    if (!sourceFile) return inner.getSemanticDiagnostics(fileName)
    const diagnostics = shade
      .getDiagnostics(fileName)
      .map((d) => toTsDiagnostic(ctx, sourceFile, d))
    return withoutSyntacticDuplicates(diagnostics, inner.getSyntacticDiagnostics(fileName))
  })

  // Syntactic diagnostics are passed through untouched: a parse error does not depend on the
  // library or the ambient declarations, and the grammar errors that look syntactic are not
  // reported there (the probe measured TS1206 arriving as semantic with the syntactic pass
  // empty). Nothing to override.

  override('getSuggestionDiagnostics', (fileName) =>
    isShade(fileName) ? [] : inner.getSuggestionDiagnostics(fileName),
  )

  {
    // The undeclared region method. Overridden through one cast, because the alternative is a
    // 500-line shader quietly getting TypeScript's errors back.
    const region = inner as unknown as RegionDiagnosticsService
    if (typeof region.getRegionSemanticDiagnostics === 'function') {
      const forward = region.getRegionSemanticDiagnostics.bind(inner)
      ;(proxy as unknown as RegionDiagnosticsService).getRegionSemanticDiagnostics = (
        fileName,
        ranges,
      ) => (isShade(fileName) ? { diagnostics: [] } : forward(fileName, ranges))
    }
  }

  // ── hover, completions, signature help ───────────────────────────────────────────────────

  override('getQuickInfoAtPosition', (fileName, position) => {
    if (!isShade(fileName)) return inner.getQuickInfoAtPosition(fileName, position)
    const hover = shade.getHover(fileName, shade.positionAt(fileName, position))
    return hover === undefined ? undefined : toQuickInfo(ctx, fileName, hover)
  })

  override('getCompletionsAtPosition', (fileName, position, options, formatting) => {
    if (!isShade(fileName)) {
      return inner.getCompletionsAtPosition(fileName, position, options, formatting)
    }
    const items = shade.getCompletions(fileName, shade.positionAt(fileName, position))
    return items.length === 0 ? undefined : toCompletionInfo(ctx, fileName, items)
  })

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
        )
      }
      const items = shade.getCompletions(fileName, shade.positionAt(fileName, position))
      const item = items.find((candidate) => candidate.label === entryName)
      return item === undefined ? undefined : toCompletionEntryDetails(ctx, item)
    },
  )

  override('getSignatureHelpItems', (fileName, position, options) => {
    if (!isShade(fileName)) return inner.getSignatureHelpItems(fileName, position, options)
    const help = shade.getSignatureHelp(fileName, shade.positionAt(fileName, position))
    return help === undefined
      ? undefined
      : toSignatureHelpItems(help, argumentSpan(fileName, position))
  })

  // ── navigation ───────────────────────────────────────────────────────────────────────────

  override('getDefinitionAndBoundSpan', (fileName, position) => {
    if (!isShade(fileName)) return inner.getDefinitionAndBoundSpan(fileName, position)
    const name = nameAt(fileName, position)
    const definitions = shade.getDefinition(fileName, shade.positionAt(fileName, position))
    if (definitions.length === 0) return undefined
    return {
      definitions: toDefinitionInfos(ctx, definitions, name),
      textSpan: { start: position, length: name.length },
    }
  })

  for (const key of [
    'getDefinitionAtPosition',
    'getTypeDefinitionAtPosition',
    'getImplementationAtPosition',
  ] as const) {
    const forward = inner[key].bind(inner)
    override(key, ((fileName: string, position: number) => {
      if (!isShade(fileName)) return forward(fileName, position)
      const definitions = shade.getDefinition(fileName, shade.positionAt(fileName, position))
      return definitions.length === 0
        ? undefined
        : toDefinitionInfos(ctx, definitions, nameAt(fileName, position))
    }) as unknown as ts.LanguageService[typeof key])
  }

  override('findReferences', (fileName, position) => {
    if (!isShade(fileName)) return inner.findReferences(fileName, position)
    const at = shade.positionAt(fileName, position)
    const references = shade.getReferences(fileName, at, { includeDeclaration: true })
    if (references.length === 0) return undefined
    const declarations = shade.getDefinition(fileName, at)
    return toReferencedSymbols(ctx, references, declarations, nameAt(fileName, position))
  })

  override('getReferencesAtPosition', (fileName, position) => {
    if (!isShade(fileName)) return inner.getReferencesAtPosition(fileName, position)
    const references = shade.getReferences(fileName, shade.positionAt(fileName, position), {
      includeDeclaration: true,
    })
    return references.length === 0 ? undefined : toReferenceEntries(ctx, references)
  })

  override('getRenameInfo', (fileName, position, preferences) => {
    if (!isShade(fileName)) return inner.getRenameInfo(fileName, position, preferences)
    const prepared = shade.prepareRename(fileName, shade.positionAt(fileName, position))
    if (prepared === undefined) {
      return {
        canRename: false,
        localizedErrorMessage: 'This element cannot be renamed in a "use typeshade" file.',
      }
    }
    const span = {
      start: shade.offsetAt(fileName, prepared.range.start),
      length:
        shade.offsetAt(fileName, prepared.range.end) -
        shade.offsetAt(fileName, prepared.range.start),
    }
    return {
      canRename: true,
      displayName: prepared.placeholder,
      fullDisplayName: prepared.placeholder,
      kind: typescript.ScriptElementKind.unknown,
      kindModifiers: '',
      triggerSpan: span,
    }
  })

  // `findRenameLocations` is overloaded on its last parameter (a `UserPreferences` or the older
  // boolean), and an override sees the union, which matches neither overload. One cast, here,
  // rather than a branch that calls the same method twice to pick an overload.
  const forwardRename = inner.findRenameLocations.bind(inner) as (
    fileName: string,
    position: number,
    findInStrings: boolean,
    findInComments: boolean,
    preferences?: ts.UserPreferences | boolean,
  ) => readonly ts.RenameLocation[] | undefined

  override('findRenameLocations', (fileName, position, findInStrings, findInComments, prefs) => {
    if (!isShade(fileName)) {
      return forwardRename(fileName, position, findInStrings, findInComments, prefs)
    }
    // The service refuses exactly what `prepareRename` refuses, so a placeholder name is all
    // this needs: the result is locations, and the editor writes the text.
    const edits = shade.rename(fileName, shade.positionAt(fileName, position), 'newName')
    const locations = toRenameLocations(ctx, edits)
    return locations.length === 0 ? undefined : locations
  })

  override('getNavigationTree', (fileName) => {
    if (!isShade(fileName)) return inner.getNavigationTree(fileName)
    const symbols = shade.getDocumentSymbols(fileName)
    return toNavigationTree(ctx, fileName, symbols, fileName.split('/').pop() ?? fileName)
  })

  override('getNavigationBarItems', (fileName) => {
    if (!isShade(fileName)) return inner.getNavigationBarItems(fileName)
    return toNavigationBarItems(ctx, fileName, shade.getDocumentSymbols(fileName))
  })

  override('getEncodedSemanticClassifications', (fileName, span, format) => {
    if (!isShade(fileName)) return inner.getEncodedSemanticClassifications(fileName, span, format)
    const range = {
      start: shade.positionAt(fileName, span.start),
      end: shade.positionAt(fileName, span.start + span.length),
    }
    return toClassifications(ctx, fileName, shade.getSemanticTokens(fileName, range))
  })

  // ── answered with nothing, because the project's program would answer from the wrong one ──

  override('getCodeFixesAtPosition', (fileName, start, end, codes, formatting, preferences) =>
    isShade(fileName)
      ? []
      : inner.getCodeFixesAtPosition(fileName, start, end, codes, formatting, preferences),
  )

  nothingForShaders('getCombinedCodeFix', () => ({ changes: [] }))
  nothingForShaders('getDocumentHighlights', () => undefined)
  nothingForShaders('provideInlayHints', () => [])
  nothingForShaders('getApplicableRefactors', () => [])
  nothingForShaders('getEditsForRefactor', () => undefined)
  nothingForShaders('prepareCallHierarchy', () => undefined)
  nothingForShaders('provideCallHierarchyIncomingCalls', () => [])
  nothingForShaders('provideCallHierarchyOutgoingCalls', () => [])
  nothingForShaders('organizeImports', () => [])
  nothingForShaders('getFileReferences', () => [])
  nothingForShaders('getDocCommentTemplateAtPosition', () => undefined)
  nothingForShaders('getJsxClosingTagAtPosition', () => undefined)
  nothingForShaders('getSupportedCodeFixes', () => [])

  // `getNavigateToItems` and `getEditsForFileRename` are project-wide rather than per-file, so
  // they cannot be filtered the way the list above is: their first argument is a search string
  // or an old path. A shader's symbols reaching a workspace symbol search from the project's
  // program is a cosmetic wrong answer rather than a wrong diagnostic, and filtering it needs
  // the service to answer workspace-wide, which it does not. Left forwarding, deliberately.

  log('[typeshade] language service decorated')
  return proxy
}
