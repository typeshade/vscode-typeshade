// === TypeShade answers, in the shapes tsserver returns ===
//
// The adapter half of the plugin, and the whole of it: the service decides and this file
// converts (`docs/language-service-api.md` §1). Every conversion `docs/design.md` §3 calls out
// as risky lives here, with the reason beside it, so the risky ones are read together rather
// than found one at a time.

import type ts from 'typescript'
import type {
  TypeshadeCompletionItem,
  TypeshadeCompletionKind,
  TypeshadeDiagnostic,
  TypeshadeDocumentSymbol,
  TypeshadeHover,
  TypeshadeLanguageService,
  TypeshadeLocation,
  TypeshadeRange,
  TypeshadeSemanticToken,
  TypeshadeSemanticTokenType,
  TypeshadeSignatureHelp,
  TypeshadeSymbolKind,
} from './compiler.js'

/** What every conversion needs: the host's `typescript` module for its enums, and the service
 *  for position arithmetic, which is the only place offsets and line/character meet. */
export interface ConvertContext {
  readonly typescript: typeof ts
  readonly shade: TypeshadeLanguageService
}

/** The 2020 semantic classifier's token types, by index.
 *
 *  Hard-coded rather than imported: `ts.classifier.v2020` exists only at run time
 *  (`typescript.js:152086` in the pinned 5.6.3) and `typescript.d.ts` declares no `classifier`
 *  namespace at all, so there is nothing to import. The indices are from `typescript.js:148594`
 *  and the encoding constants from line 148590. */
const V2020_TOKEN_TYPE = {
  class: 0,
  enum: 1,
  interface: 2,
  namespace: 3,
  typeParameter: 4,
  type: 5,
  parameter: 6,
  variable: 7,
  enumMember: 8,
  property: 9,
  function: 10,
  member: 11,
} as const

/** `TokenEncodingConsts.typeOffset`. A classification is `(type + 1) << typeOffset | modifiers`. */
const TYPE_OFFSET = 8

/** The 2020 classifier's modifier bits, by index (`typescript.js:148610`). */
const V2020_MODIFIER = { declaration: 0, readonly: 3, defaultLibrary: 4 } as const

/** TypeShade's thirteen token types onto the twelve TypeScript has.
 *
 *  Seven have no counterpart (`decorator`, `builtin`, `resource`, `operator`, `number`,
 *  `string`, `keyword`), and the legend belongs to VS Code's built-in TypeScript extension, so
 *  it cannot be widened from here. Those tokens are DROPPED rather than mislabelled: a dropped
 *  token still gets TextMate's colour, while a mislabelled one gets a confidently wrong one
 *  (`docs/design.md` §3, and §8 item 2 for the open question). */
const TOKEN_TYPE: Partial<Record<TypeshadeSemanticTokenType, number>> = {
  type: V2020_TOKEN_TYPE.type,
  struct: V2020_TOKEN_TYPE.type,
  function: V2020_TOKEN_TYPE.function,
  parameter: V2020_TOKEN_TYPE.parameter,
  variable: V2020_TOKEN_TYPE.variable,
  property: V2020_TOKEN_TYPE.property,
}

/** Converts a range in `uri` to the offset span tsserver speaks in. */
function spanOf(ctx: ConvertContext, uri: string, range: TypeshadeRange): ts.TextSpan {
  const start = ctx.shade.offsetAt(uri, range.start)
  const end = ctx.shade.offsetAt(uri, range.end)
  return { start, length: Math.max(0, end - start) }
}

/**
 * One TypeShade diagnostic as a `ts.Diagnostic`.
 *
 * Two decisions live here. A `ts.Diagnostic.code` is a number while TypeShade's are the strings
 * `TS8001` upward, and those numbers collide with TypeScript's own 8001 to 8039 family, so the
 * code carries the numeric part and `source: 'typeshade'` is what tells the two apart. Nothing
 * else can: TypeScript's own 8001 is a rename diagnostic, and this plugin maps rename. The
 * collision is only dangerous through code-keyed behaviour, which is why the decoration answers
 * no code fixes for a TypeShade file at all (`docs/design.md` §3).
 *
 * A diagnostic that came from the TypeShade program's own TypeScript pass keeps its numeric
 * code and carries no source, so it reads as the TypeScript error it is.
 *
 * @param ctx - the host's `typescript` module and the service.
 * @param file - the source file the diagnostic belongs to, from tsserver's program.
 * @param diagnostic - the service's diagnostic.
 * @returns the same diagnostic in tsserver's shape.
 */
export function toTsDiagnostic(
  ctx: ConvertContext,
  file: ts.SourceFile,
  diagnostic: TypeshadeDiagnostic,
): ts.Diagnostic {
  const isTypeshade = diagnostic.source === 'typeshade'
  return {
    file,
    start: diagnostic.span.start,
    length: diagnostic.span.length,
    messageText: diagnostic.message,
    category: categoryOf(ctx, diagnostic.severity),
    code: numericCode(diagnostic.code),
    ...(isTypeshade ? { source: 'typeshade' } : {}),
    reportsUnnecessary: undefined,
    reportsDeprecated: undefined,
  }
}

/** `TS8003` to 8003, and a number through unchanged. A code that parses to nothing becomes
 *  8099, the compiler's own catch-all, rather than NaN. */
function numericCode(code: string | number): number {
  if (typeof code === 'number') return code
  const digits = /(\d+)/.exec(code)
  return digits ? Number(digits[1]) : 8099
}

/** TypeShade's four severities onto TypeScript's four categories. */
function categoryOf(ctx: ConvertContext, severity: TypeshadeDiagnostic['severity']) {
  const c = ctx.typescript.DiagnosticCategory
  if (severity === 'error') return c.Error
  if (severity === 'warning') return c.Warning
  if (severity === 'information') return c.Message
  return c.Suggestion
}

/**
 * Drops from `diagnostics` the entries the syntactic pass already reported.
 *
 * The service's `getDiagnostics` includes the TypeShade program's own syntactic diagnostics
 * (`diagnostics.ts` concatenates both passes), and the decoration passes tsserver's syntactic
 * pass through untouched, so a missing brace would otherwise be underlined twice. Matching is
 * by code and span, which is exact here: both passes parsed the same text.
 *
 * @param diagnostics - what the semantic method is about to return.
 * @param syntactic - what the syntactic method returned for the same file.
 * @returns the semantic answer with the duplicates removed.
 */
export function withoutSyntacticDuplicates(
  diagnostics: readonly TypeshadeDiagnostic[],
  syntactic: readonly ts.DiagnosticWithLocation[],
): TypeshadeDiagnostic[] {
  if (syntactic.length === 0) return [...diagnostics]
  const seen = new Set(syntactic.map((d) => `${d.code}:${d.start}:${d.length}`))
  // Only a TypeScript-sourced diagnostic can be a duplicate of the syntactic pass, and this
  // runs BEFORE conversion so that is still visible: converting first erased `source`, and a
  // TypeShade code that happened to share a number and a span with a TypeScript one would have
  // been dropped as a duplicate of something it has nothing to do with.
  return diagnostics.filter(
    (d) =>
      d.source !== 'typescript' ||
      !seen.has(`${numericCode(d.code)}:${d.span.start}:${d.span.length}`),
  )
}

/**
 * A hover as `ts.QuickInfo`.
 *
 * `TypeshadeHover.contents` is one Markdown string; `ts.QuickInfo` wants `displayParts` and
 * `documentation`, and VS Code renders the display parts inside a TypeScript code fence. So
 * Markdown put there renders as code. The split: the first fenced block becomes the display
 * parts with its fence stripped, everything else becomes the documentation, and a hover with no
 * fenced block puts all of it in the documentation (`docs/design.md` §3).
 *
 * @param ctx - the host's `typescript` module and the service.
 * @param uri - the document the hover is in.
 * @param hover - the service's hover.
 * @returns the hover in tsserver's shape.
 */
export function toQuickInfo(ctx: ConvertContext, uri: string, hover: TypeshadeHover): ts.QuickInfo {
  const { signature, prose } = splitHover(hover.contents)
  return {
    kind: ctx.typescript.ScriptElementKind.unknown,
    kindModifiers: '',
    textSpan: spanOf(ctx, uri, hover.range),
    displayParts: signature === '' ? [] : [{ text: signature, kind: 'text' }],
    documentation: prose === '' ? [] : [{ text: prose, kind: 'text' }],
    tags: undefined,
  }
}

/** The first fenced code block of a Markdown hover, and everything else, in order. */
export function splitHover(contents: string): { signature: string; prose: string } {
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```[ \t]*$/m.exec(contents)
  if (!fence) return { signature: '', prose: contents.trim() }
  const prose = (contents.slice(0, fence.index) + contents.slice(fence.index + fence[0].length))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { signature: fence[1].trim(), prose }
}

/** TypeShade's completion kinds onto TypeScript's element kinds.
 *
 *  Lossy in one direction: `attribute`, `builtin` and `resource` have no spelling in
 *  `ts.ScriptElementKind`, so they borrow the nearest one and the item's own `detail` carries
 *  the true kind. Only the icon is approximate; nothing the user reads is lost. */
function completionKind(ctx: ConvertContext, kind: TypeshadeCompletionKind): ts.ScriptElementKind {
  const k = ctx.typescript.ScriptElementKind
  switch (kind) {
    case 'keyword':
    case 'attribute':
    case 'builtin':
      return k.keyword
    case 'type':
    case 'struct':
      return k.interfaceElement
    case 'function':
      return k.functionElement
    case 'variable':
    case 'resource':
      return k.variableElement
    case 'field':
      return k.memberVariableElement
    case 'snippet':
      return k.string
  }
}

/**
 * Completion items as a `ts.CompletionInfo`.
 *
 * Replaced entirely rather than merged with TypeScript's: a merged list is one where `Promise`
 * and `document` are offered inside a shader, and the service's own list already carries the
 * keywords (`docs/design.md` §8 item 1).
 *
 * @param ctx - the host's `typescript` module and the service.
 * @param uri - the document the completions are for.
 * @param items - the service's items.
 * @returns the list in tsserver's shape.
 */
export function toCompletionInfo(
  ctx: ConvertContext,
  uri: string,
  items: readonly TypeshadeCompletionItem[],
): ts.WithMetadata<ts.CompletionInfo> {
  return {
    isGlobalCompletion: false,
    isMemberCompletion: false,
    isNewIdentifierLocation: false,
    entries: items.map((item) => ({
      name: item.label,
      kind: completionKind(ctx, item.kind),
      kindModifiers: '',
      sortText: item.sortText ?? item.label,
      ...(item.insertText === undefined ? {} : { insertText: item.insertText }),
      ...(item.insertTextFormat === 'snippet' ? { isSnippet: true as const } : {}),
      ...(item.filterText === undefined ? {} : { filterText: item.filterText }),
      ...(item.textEdit === undefined
        ? {}
        : { replacementSpan: spanOf(ctx, uri, item.textEdit.range) }),
      ...(item.detail === undefined ? {} : { labelDetails: { description: item.detail } }),
    })),
  }
}

/**
 * The details pane for one completion entry, found in the same list by name.
 *
 * @param ctx - the host's `typescript` module and the service.
 * @param item - the item the entry came from.
 * @returns the details in tsserver's shape.
 */
export function toCompletionEntryDetails(
  ctx: ConvertContext,
  item: TypeshadeCompletionItem,
): ts.CompletionEntryDetails {
  return {
    name: item.label,
    kind: completionKind(ctx, item.kind),
    kindModifiers: '',
    displayParts: item.detail === undefined ? [] : [{ text: item.detail, kind: 'text' }],
    documentation:
      item.documentation === undefined ? [] : [{ text: item.documentation, kind: 'text' }],
    tags: undefined,
  }
}

/**
 * Signature help as `ts.SignatureHelpItems`.
 *
 * The service reports labels rather than parts, so each signature's label is split at its
 * parentheses into the prefix, the parameters and the suffix tsserver wants. `applicableSpan`
 * has no counterpart in the service's answer and is what the editor uses to decide when to
 * dismiss the popup, so the caller supplies it from the syntax it already has.
 *
 * @param help - the service's signature help.
 * @param applicableSpan - the span the popup stays open over.
 * @returns the help in tsserver's shape.
 */
export function toSignatureHelpItems(
  help: TypeshadeSignatureHelp,
  applicableSpan: ts.TextSpan,
): ts.SignatureHelpItems {
  return {
    items: help.signatures.map((signature) => {
      const open = signature.label.indexOf('(')
      const prefix = open === -1 ? signature.label : signature.label.slice(0, open + 1)
      const close = signature.label.lastIndexOf(')')
      const suffix = close === -1 ? '' : signature.label.slice(close)
      return {
        isVariadic: false,
        prefixDisplayParts: [{ text: prefix, kind: 'text' }],
        suffixDisplayParts: suffix === '' ? [] : [{ text: suffix, kind: 'text' }],
        separatorDisplayParts: [{ text: ', ', kind: 'punctuation' }],
        parameters: signature.parameters.map((parameter) => ({
          name: parameter.label,
          documentation:
            parameter.documentation === undefined
              ? []
              : [{ text: parameter.documentation, kind: 'text' }],
          displayParts: [{ text: parameter.label, kind: 'text' }],
          isOptional: false,
          isRest: false,
        })),
        documentation:
          signature.documentation === undefined
            ? []
            : [{ text: signature.documentation, kind: 'text' }],
        tags: [],
      }
    }),
    applicableSpan,
    selectedItemIndex: help.activeSignature,
    argumentIndex: help.activeParameter,
    argumentCount: help.signatures[help.activeSignature]?.parameters.length ?? 0,
  }
}

/**
 * Locations as definitions.
 *
 * @param ctx - the host's `typescript` module and the service.
 * @param locations - the service's locations.
 * @param name - the symbol's name, for the editor's own labelling.
 * @returns one `ts.DefinitionInfo` per location.
 */
export function toDefinitionInfos(
  ctx: ConvertContext,
  locations: readonly TypeshadeLocation[],
  name: string,
): ts.DefinitionInfo[] {
  return locations.map((location) => ({
    fileName: location.uri,
    textSpan: spanOf(ctx, location.uri, location.range),
    kind: ctx.typescript.ScriptElementKind.unknown,
    name,
    containerKind: ctx.typescript.ScriptElementKind.unknown,
    containerName: '',
  }))
}

/**
 * References as `ts.ReferenceEntry` values, for the clients that ask that way.
 *
 * @param ctx - the host's `typescript` module and the service.
 * @param locations - the service's locations.
 * @returns one entry per location.
 */
export function toReferenceEntries(
  ctx: ConvertContext,
  locations: readonly TypeshadeLocation[],
  declarations: readonly TypeshadeLocation[] = [],
): ts.ReferenceEntry[] {
  return locations.map((location) => ({
    fileName: location.uri,
    textSpan: spanOf(ctx, location.uri, location.range),
    isWriteAccess: false,
    // The editor heads its list with the declaration and marks it in the peek view, so a list
    // where nothing is the definition reads worse than the wrong answer it replaced.
    isDefinition: isDeclaration(location, declarations),
  }))
}

/** Whether `location` is one of the declarations, by uri and start position. */
function isDeclaration(
  location: TypeshadeLocation,
  declarations: readonly TypeshadeLocation[],
): boolean {
  return declarations.some(
    (declaration) =>
      declaration.uri === location.uri &&
      declaration.range.start.line === location.range.start.line &&
      declaration.range.start.character === location.range.start.character,
  )
}

/**
 * References grouped the way `findReferences` returns them, which is the method tsserver
 * actually calls (`typescript.js:189656`; `getReferencesAtPosition` has no call site in the
 * server at all).
 *
 * @param ctx - the host's `typescript` module and the service.
 * @param locations - every reference, including the declaration.
 * @param declarations - the declaration locations, which head their group.
 * @param name - the symbol's name.
 * @returns one referenced symbol per file, each with its own definition.
 */
export function toReferencedSymbols(
  ctx: ConvertContext,
  locations: readonly TypeshadeLocation[],
  declarations: readonly TypeshadeLocation[],
  name: string,
): ts.ReferencedSymbol[] {
  const byFile = new Map<string, TypeshadeLocation[]>()
  for (const location of locations) {
    const group = byFile.get(location.uri)
    if (group) group.push(location)
    else byFile.set(location.uri, [location])
  }
  return [...byFile].map(([uri, group]) => {
    const declaration = declarations.find((d) => d.uri === uri) ?? group[0]
    return {
      definition: {
        containerKind: ctx.typescript.ScriptElementKind.unknown,
        containerName: '',
        fileName: uri,
        kind: ctx.typescript.ScriptElementKind.unknown,
        name,
        textSpan: spanOf(ctx, uri, declaration.range),
        displayParts: [{ text: name, kind: 'text' }],
      },
      references: group.map((location) => {
        const textSpan = spanOf(ctx, uri, location.range)
        return {
          fileName: uri,
          textSpan,
          // The context span is what the peek view shows around a hit. The service reports the
          // name's range and nothing wider, so the context is the name: a narrow context is
          // honest, an absent one makes the preview fall back to the raw line.
          contextSpan: textSpan,
          isWriteAccess: false,
          isDefinition: isDeclaration(location, declarations),
        }
      }),
    }
  })
}

/**
 * A rename result as the locations tsserver expects.
 *
 * The service returns edits keyed by uri, and a `ts.RenameLocation` is only the place, since
 * the editor writes the new name itself.
 *
 * @param ctx - the host's `typescript` module and the service.
 * @param edits - the service's edits, by uri.
 * @returns one location per edit.
 */
export function toRenameLocations(
  ctx: ConvertContext,
  edits: Readonly<Record<string, readonly { range: TypeshadeRange }[]>>,
): ts.RenameLocation[] {
  const out: ts.RenameLocation[] = []
  for (const [uri, fileEdits] of Object.entries(edits)) {
    for (const edit of fileEdits)
      out.push({ fileName: uri, textSpan: spanOf(ctx, uri, edit.range) })
  }
  return out
}

/** TypeShade's symbol kinds onto TypeScript's element kinds, for the outline. */
function symbolKind(ctx: ConvertContext, kind: TypeshadeSymbolKind): ts.ScriptElementKind {
  const k = ctx.typescript.ScriptElementKind
  switch (kind) {
    case 'function':
    case 'entry':
      return k.functionElement
    case 'struct':
      return k.interfaceElement
    case 'field':
      return k.memberVariableElement
    case 'resource':
    case 'variable':
      return k.variableElement
    case 'constant':
      return k.constElement
    case 'parameter':
      return k.parameterElement
  }
}

/**
 * The document outline as a `ts.NavigationTree`.
 *
 * @param ctx - the host's `typescript` module and the service.
 * @param uri - the document.
 * @param symbols - the service's symbols.
 * @param rootText - the name of the tree's root, which tsserver expects to be the file.
 * @returns the outline in tsserver's shape.
 */
export function toNavigationTree(
  ctx: ConvertContext,
  uri: string,
  symbols: readonly TypeshadeDocumentSymbol[],
  rootText: string,
  fileLength: number,
): ts.NavigationTree {
  // The root stands for the whole file, so its span is the whole file: a zero-length root makes
  // an outline whose top entry cannot be revealed.
  const fullSpan: ts.TextSpan = { start: 0, length: fileLength }
  return {
    text: rootText,
    kind: ctx.typescript.ScriptElementKind.moduleElement,
    kindModifiers: '',
    spans: [fullSpan],
    nameSpan: undefined,
    childItems: symbols.map((symbol) => toNavigationNode(ctx, uri, symbol)),
  }
}

/** One outline node, with its children. */
function toNavigationNode(
  ctx: ConvertContext,
  uri: string,
  symbol: TypeshadeDocumentSymbol,
): ts.NavigationTree {
  return {
    text: symbol.detail === undefined ? symbol.name : `${symbol.name} (${symbol.detail})`,
    kind: symbolKind(ctx, symbol.kind),
    kindModifiers: '',
    spans: [spanOf(ctx, uri, symbol.range)],
    nameSpan: spanOf(ctx, uri, symbol.selectionRange),
    childItems: symbol.children?.map((child) => toNavigationNode(ctx, uri, child)),
  }
}

/**
 * The outline as the flat list `getNavigationBarItems` returns.
 *
 * @param ctx - the host's `typescript` module and the service.
 * @param uri - the document.
 * @param symbols - the service's symbols.
 * @returns the outline in tsserver's other shape.
 */
export function toNavigationBarItems(
  ctx: ConvertContext,
  uri: string,
  symbols: readonly TypeshadeDocumentSymbol[],
): ts.NavigationBarItem[] {
  const item = (symbol: TypeshadeDocumentSymbol, indent: number): ts.NavigationBarItem => ({
    text: symbol.name,
    kind: symbolKind(ctx, symbol.kind),
    kindModifiers: '',
    spans: [spanOf(ctx, uri, symbol.range)],
    childItems: symbol.children?.map((child) => item(child, indent + 1)) ?? [],
    indent,
    bolded: false,
    grayed: false,
  })
  return symbols.map((symbol) => item(symbol, 0))
}

/**
 * Semantic tokens in the 2020 classifier's encoding.
 *
 * A token whose type has no counterpart in that legend is dropped rather than mislabelled, and
 * so are the `entry` and `gpu` modifiers (`TOKEN_TYPE` above says why).
 *
 * @param ctx - the host's `typescript` module and the service.
 * @param uri - the document.
 * @param tokens - the service's tokens, in document order.
 * @returns the classifications in tsserver's shape.
 */
export function toClassifications(
  ctx: ConvertContext,
  uri: string,
  tokens: readonly TypeshadeSemanticToken[],
): ts.Classifications {
  const spans: number[] = []
  for (const token of tokens) {
    const type = TOKEN_TYPE[token.type]
    if (type === undefined) continue
    const start = ctx.shade.offsetAt(uri, { line: token.line, character: token.character })
    let modifiers = 0
    for (const modifier of token.modifiers) {
      const bit = V2020_MODIFIER[modifier as keyof typeof V2020_MODIFIER]
      if (bit !== undefined) modifiers |= 1 << bit
    }
    spans.push(start, token.length, ((type + 1) << TYPE_OFFSET) | modifiers)
  }
  return { spans, endOfLineState: ctx.typescript.EndOfLineState.None }
}
