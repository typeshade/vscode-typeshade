// === The one file that imports the compiler ===
//
// The plugin's rule, kept here too (`packages/tsserver-plugin/src/compiler.ts`): every other
// module imports the compiler through this one, so a pin bump (`docs/design.md` §2) has a single
// place to read, and what this file re-exports IS the compiler surface the server consumes. The
// specifiers are the ones the published package serves, never a deep path into its `src/`, and
// they resolve to the submodule through the same three mappings the plugin uses.

export { compile, reflect, stageOf, typeKey } from 'typeshade';
export type {
  CompileResult,
  ConsoleEvent,
  FuncDecl,
  ModuleDecl,
  ShaderType,
  StructDecl,
  TsCompilerDiagnostic,
} from 'typeshade';

export {
  AMBIENT_LIB_URI,
  ATTRIBUTE_DOCS,
  BUILTIN_DOCS,
  CONSTANT_DOCS,
  FOREIGN_NAMES,
  FUNCTION_DOCS,
  MATH_MEMBER_DOCS,
  SHADE_DTS,
  TYPE_DOCS,
  checkOpenDocument,
  createTypeshadeLanguageService,
  foreignNameRemedy,
} from 'typeshade/language-service';
export type {
  CheckDiagnostic,
  TypeshadeDocumentSymbol,
  TypeshadeLanguageService,
  TypeshadeLocation,
  TypeshadePosition,
  TypeshadeRange,
} from 'typeshade/language-service';

export {
  createValueFormatter,
  resolveBindings,
  resolveInvocation,
  startDebugSession,
} from 'typeshade/debug';
export type { CpuValue, DebugInvocation, DebugPause } from 'typeshade/debug';
