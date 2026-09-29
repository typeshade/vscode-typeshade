// === File names the TypeShade program can hold ===
//
// tsserver holds a file by whatever name the editor opened it under, and an untitled editor has
// no extension at all: VS Code opens one as `^/untitled/ts-nul-authority/Untitled-1` on the
// desktop and `/untitled/ts-nul-authority/Untitled-1` on the web, with `scriptKindName: "TS"`
// saying what it is. tsserver takes the kind from that; the TypeShade service builds its own
// TypeScript program and has only the name, and a TypeScript program leaves out a root file
// whose name has no TypeScript extension. The service then answers `[]` for the file, silently,
// while the decoration has already taken the file from the project's program, so the editor
// shows no error at all (`docs/measurements/vscode-dev-live/`, finding 1).
//
// So the service is handed such a file under an alias, the name with `.ts` appended, and every
// name it answers with is turned back before it leaves this module. The alias exists only
// between the plugin and the service: tsserver, the editor and the log never see it.

import type {
  TypeshadeDiagnostic,
  TypeshadeLanguageService,
  TypeshadeLocation,
} from './compiler.js';

/** The names a TypeScript program takes as TypeScript. */
const TYPESCRIPT_NAME = /\.[cm]?tsx?$/i;

const ALIAS = '.ts';

/** The name the TypeShade service holds `fileName` under. */
export function programName(fileName: string): string {
  return TYPESCRIPT_NAME.test(fileName) ? fileName : fileName + ALIAS;
}

/**
 * Wraps a TypeShade service so a file whose name TypeScript does not take is held under its
 * alias, and every name in an answer is the one tsserver knows.
 *
 * A name is turned back only when it is an alias this wrapper made, so a real `Untitled-1.ts`
 * beside an untitled `Untitled-1` would be read as the untitled one. Both would have to be open
 * shaders in the same directory; nothing the editor makes is named that way.
 *
 * @param shade - the service to wrap.
 * @returns the same service, speaking tsserver's names.
 */
export function withProgramNames(shade: TypeshadeLanguageService): TypeshadeLanguageService {
  /** Aliases handed to the service, to the name tsserver knows them by. */
  const aliases = new Map<string, string>();
  const toProgram = (fileName: string): string => {
    const name = programName(fileName);
    if (name !== fileName) aliases.set(name, fileName);
    return name;
  };
  const fromProgram = (uri: string): string => aliases.get(uri) ?? uri;
  const location = (l: TypeshadeLocation): TypeshadeLocation =>
    aliases.has(l.uri) ? { ...l, uri: fromProgram(l.uri) } : l;
  const diagnostic = (d: TypeshadeDiagnostic): TypeshadeDiagnostic =>
    aliases.size === 0
      ? d
      : {
          ...d,
          uri: fromProgram(d.uri),
          ...(d.relatedInformation
            ? {
                relatedInformation: d.relatedInformation.map((r) => ({
                  ...r,
                  location: location(r.location),
                })),
              }
            : {}),
        };

  return {
    openDocument: (uri, text, version) => shade.openDocument(toProgram(uri), text, version),
    updateDocument: (uri, text, version) => shade.updateDocument(toProgram(uri), text, version),
    closeDocument: (uri) => {
      const name = toProgram(uri);
      shade.closeDocument(name);
      aliases.delete(name);
    },
    getDiagnostics: (uri) => shade.getDiagnostics(toProgram(uri)).map(diagnostic),
    getCompletions: (uri, position) => shade.getCompletions(toProgram(uri), position),
    getHover: (uri, position) => shade.getHover(toProgram(uri), position),
    getDefinition: (uri, position) => shade.getDefinition(toProgram(uri), position).map(location),
    getReferences: (uri, position, options) =>
      shade.getReferences(toProgram(uri), position, options).map(location),
    getDocumentSymbols: (uri) => shade.getDocumentSymbols(toProgram(uri)),
    getSignatureHelp: (uri, position) => shade.getSignatureHelp(toProgram(uri), position),
    prepareRename: (uri, position) => shade.prepareRename(toProgram(uri), position),
    rename: (uri, position, newName) =>
      Object.fromEntries(
        Object.entries(shade.rename(toProgram(uri), position, newName)).map(([name, edits]) => [
          fromProgram(name),
          edits,
        ]),
      ),
    getSemanticTokens: (uri, range) => shade.getSemanticTokens(toProgram(uri), range),
    getCompiledOutput: (uri, target) => {
      const output = shade.getCompiledOutput(toProgram(uri), target);
      return output && { ...output, diagnostics: output.diagnostics.map(diagnostic) };
    },
    positionAt: (uri, offset) => shade.positionAt(toProgram(uri), offset),
    offsetAt: (uri, position) => shade.offsetAt(toProgram(uri), position),
  };
}
