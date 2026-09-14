// === A real language service over files in memory, for the tests ===
//
// Test-only, and deliberately a REAL `ts.LanguageService` rather than a hand-written stand-in.
// A thin fake was the first thing written here, and it hid a decoration that reaches for
// members a fake does not have; the real service has every member tsserver's does, so a test
// against it fails for the same reasons production would.
//
// This is not the tsserver test. `tsserver.test.ts` spawns the real server and drives its
// protocol, which is what proves the loading and decoration contract (`docs/design.md` §6).
// This helper is for the conversions, where a whole server is a slow way to ask a small
// question.

import ts from 'typescript'

/** A project standing in for one tsserver would build: real compiler options, the real standard
 *  library, and texts held in memory so a test can edit one without touching a disk. */
export interface TestProject {
  /** The service a decoration is built over. */
  readonly service: ts.LanguageService
  /** The host, which a `DocumentSync` reads through. */
  readonly host: ts.LanguageServiceHost
  /** Replaces a file's text and bumps its version, as an editor would. */
  edit(fileName: string, text: string): void
  /** Removes a file from the project, as closing and deleting one would. */
  remove(fileName: string): void
}

/**
 * Builds a project over `files`.
 *
 * @param files - file name to text. Names are absolute-looking paths so they read like the ones
 *   tsserver passes.
 * @returns the project.
 */
export function testProject(files: Readonly<Record<string, string>>): TestProject {
  const texts = new Map(Object.entries(files))
  const versions = new Map([...texts.keys()].map((name) => [name, 1]))
  let projectVersion = 1

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...texts.keys()],
    getScriptVersion: (fileName) => String(versions.get(fileName) ?? 0),
    getScriptSnapshot: (fileName) => {
      const text = texts.get(fileName) ?? ts.sys.readFile(fileName)
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
    },
    getCurrentDirectory: () => '/project',
    getCompilationSettings: () => ({
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ['lib.es2022.d.ts'],
      strict: true,
      noEmit: true,
    }),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: (fileName) => texts.has(fileName) || ts.sys.fileExists(fileName),
    readFile: (fileName) => texts.get(fileName) ?? ts.sys.readFile(fileName),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    getProjectVersion: () => String(projectVersion),
  }

  return {
    service: ts.createLanguageService(host, ts.createDocumentRegistry()),
    host,
    edit(fileName, text) {
      texts.set(fileName, text)
      versions.set(fileName, (versions.get(fileName) ?? 1) + 1)
      projectVersion += 1
    },
    remove(fileName) {
      texts.delete(fileName)
      versions.delete(fileName)
      projectVersion += 1
    },
  }
}

/** A `ts.server.PluginCreateInfo` over a test project, carrying only what the plugin reads.
 *
 *  @param project - the project to decorate.
 *  @param logged - collects the lines the plugin writes to the server log.
 *  @returns the info object, and the same `logged` array for convenience.
 */
export function testCreateInfo(
  project: TestProject,
  logged: string[] = [],
): { info: ts.server.PluginCreateInfo; logged: string[] } {
  const info = {
    languageService: project.service,
    languageServiceHost: project.host,
    project: {
      projectService: {
        logger: {
          info: (message: string) => logged.push(message),
        },
      },
    },
  } as unknown as ts.server.PluginCreateInfo
  return { info, logged }
}
