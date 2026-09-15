// === The one file that imports the compiler ===
//
// Same rule as the plugin's `compiler.ts` (`docs/design.md` §2): every other module here imports
// from this one, so a pin bump has a single place to read, and the pull request that moves
// `vendor/typeshade` diffs what this file names against `src/__api__/surface.md` at the new
// commit.
//
// The extension's list is LONGER than the plugin's, and the reason is §4's decision. The plugin
// only ever asks the language service questions about a document. The extension has to show
// reflection and run an entry on the CPU, and neither is a language service method: `reflect`
// and `compileModule` both take a `ModuleDecl`, which the service builds internally and does not
// hand out. So the extension calls `compileTsSource` itself for those two, with the same
// `emit: false` the service uses, and the service only for what the panel shows as text.

export { compileModule, compileTsSource, isTypeshadeSource, reflect } from 'typeshade'
export { createTypeshadeLanguageService } from 'typeshade/language-service'

export type {
  CpuModule,
  CpuPrecision,
  CpuValue,
  EntryInfo,
  FuncDecl,
  ModuleDecl,
  Reflection,
  ShaderType,
} from 'typeshade'

export type {
  TypeshadeCompiledOutput,
  TypeshadeDiagnostic,
  TypeshadeDocumentSymbol,
  TypeshadeLanguageService,
  TypeshadeLanguageServiceHost,
  TypeshadePosition,
  TypeshadeRange,
} from 'typeshade/language-service'
