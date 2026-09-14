// === Which files are TypeShade files ===
//
// The rule is the compiler's (`docs/design.md` §1.4): a file is a TypeShade file when a top-level
// statement is the string literal expression `"use typeshade"`. What is shared with the compiler
// is that RULE and the exact string it matches, which is `USE_TYPESHADE`. What is NOT shared is
// the compiler's `hasUseTypeshadeDirective`, and the reason is the whole of why this file looks
// the way it does.
//
// A `ts.is*` predicate compares `node.kind` against its own module's `SyntaxKind` table. Two
// TypeScript instances in one process have two tables, and the numbers move between releases. The
// nodes here come from TSSERVER's program, so they carry the host's numbering; the compiler's
// predicate carries whatever `typescript` the compiler's own import resolved to. In this
// repository's own test harness those are the same copy, so the mismatch is invisible. In a real
// VS Code they are not: the editor's tsserver was TypeScript 6.0.3 and the plugin's import
// resolved to 5.6.3, `isExpressionStatement` accepted a node it should not have, and the very
// first `navtree` request died with `Cannot read properties of undefined (reading 'kind')`,
// taking every diagnostic in the window with it. `packages/vscode-typeshade/test-electron/` is
// what found that, and it is the only kind of test that could.
//
// So: the rule is the compiler's, applied with the instance that owns the node.

import type ts from 'typescript'
import { USE_TYPESHADE } from './compiler.js'

/**
 * Whether a source file carries the directive, decided with the TypeScript instance that built
 * it.
 *
 * @param typescript - the instance that owns `sourceFile`. For a file from tsserver's program
 *   that is the host's own module, handed to the plugin as `modules.typescript`.
 * @param sourceFile - the parsed file.
 * @returns true when a top-level statement is `"use typeshade"`.
 */
export function sourceFileHasDirective(typescript: typeof ts, sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some((statement) => {
    if (!typescript.isExpressionStatement(statement)) return false
    const expression = statement.expression
    return typescript.isStringLiteral(expression) && expression.text === USE_TYPESHADE
  })
}

/**
 * Whether `fileName` is a TypeShade file according to the project's own parse of it.
 *
 * The source file comes from tsserver's program, so the directive costs one scan of a tree that
 * was already built; nothing here parses anything a second time. A file the program does not
 * hold is not a TypeShade file, which is the safe answer: the plugin then passes it through.
 *
 * @param typescript - the host's own `typescript` module, which is what parsed the program.
 * @param service - the project's language service, whose program holds the parsed file.
 * @param fileName - the file to ask about.
 * @returns true when the file carries the directive.
 */
export function isTypeshadeFile(
  typescript: typeof ts,
  service: ts.LanguageService,
  fileName: string,
): boolean {
  const sourceFile = service.getProgram()?.getSourceFile(fileName)
  return sourceFile !== undefined && sourceFileHasDirective(typescript, sourceFile)
}

/**
 * Whether `text` carries the directive, for a file the project has not parsed.
 *
 * This is the import path (`docs/design.md` §1.7): a relative import out of a shader is served
 * to the TypeShade program only when the imported file is itself a shader, and the plugin may
 * have to decide that about a file tsserver has no source file for. Parsing here is a real
 * parse, so it is only ever done for a module specifier that resolved to something.
 *
 * @param typescript - the host's own `typescript` module, which both parses the text and reads
 *   the result, so the two can never be different instances.
 * @param fileName - the file name to parse under, which decides the script kind.
 * @param text - the file's text.
 * @returns true when the text carries the directive.
 */
export function textHasDirective(typescript: typeof ts, fileName: string, text: string): boolean {
  const parsed = typescript.createSourceFile(
    fileName,
    text,
    typescript.ScriptTarget.ES2022,
    /* setParentNodes */ false,
  )
  return sourceFileHasDirective(typescript, parsed)
}
