// === The one file that imports the compiler ===
//
// Every other module here imports from this one, so a pin bump (`docs/design.md` §2) has a
// single place to read: what this file re-exports IS the compiler surface the plugin consumes,
// and the pull request that moves `vendor/typeshade` diffs it against
// `src/__api__/surface.md` at the new commit.
//
// The specifiers are the ones the published package will serve, never a deep path into the
// compiler's `src/`. They resolve to the submodule through `tsconfig.base.json` `paths` for
// type-checking and through an esbuild alias for the bundle, so the day `typeshade` is on npm
// this file does not change at all.

// `USE_TYPESHADE`, the exact string, rather than `hasUseTypeshadeDirective`, the predicate: a
// predicate carries its own `SyntaxKind` table and the plugin's nodes come from tsserver's
// TypeScript, not from this bundle's. `directive.ts` says what that cost when it was not obeyed.
export { USE_TYPESHADE } from 'typeshade';
export { createTypeshadeLanguageService } from 'typeshade/language-service';

export type {
  TypeshadeCompletionItem,
  TypeshadeCompletionKind,
  TypeshadeDiagnostic,
  TypeshadeDocumentSymbol,
  TypeshadeHover,
  TypeshadeLanguageService,
  TypeshadeLocation,
  TypeshadePosition,
  TypeshadeRange,
  TypeshadeSemanticToken,
  TypeshadeSemanticTokenType,
  TypeshadeSeverity,
  TypeshadeSignatureHelp,
  TypeshadeSymbolKind,
  TypeshadeTextEdit,
} from 'typeshade/language-service';
