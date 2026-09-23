// === Which files are TypeShade files ===
//
// The rule is the compiler's, not a copy of it (`docs/design.md` §1.4): a file is a TypeShade
// file when a top-level statement is the string literal expression `"use typeshade"`, which is
// what `hasUseTypeshadeDirective` decides. Using the compiler's own predicate is what keeps the
// editor and the compiler from ever disagreeing about which files are shaders, and `.shade.ts`
// stays a convention rather than the rule.

import type ts from 'typescript';
import { hasUseTypeshadeDirective } from './compiler.js';

/**
 * Whether `fileName` is a TypeShade file according to the project's own parse of it.
 *
 * The source file comes from tsserver's program, so the directive costs one scan of a tree that
 * was already built; nothing here parses anything a second time. A file the program does not
 * hold is not a TypeShade file, which is the safe answer: the plugin then passes it through.
 *
 * @param service - the project's language service, whose program holds the parsed file.
 * @param fileName - the file to ask about.
 * @returns true when the file carries the directive.
 */
export function isTypeshadeFile(service: ts.LanguageService, fileName: string): boolean {
  const sourceFile = service.getProgram()?.getSourceFile(fileName);
  return sourceFile !== undefined && hasUseTypeshadeDirective(sourceFile);
}

/**
 * Whether `text` carries the directive, for a file the project has not parsed.
 *
 * This is the import path (`docs/design.md` §1.7): a relative import out of a shader is served
 * to the TypeShade program only when the imported file is itself a shader, and the plugin may
 * have to decide that about a file tsserver has no source file for. Parsing here is a real
 * parse, so it is only ever done for a module specifier that resolved to something.
 *
 * @param typescript - the host's own `typescript` module, never one this package imports.
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
  );
  return hasUseTypeshadeDirective(parsed);
}
