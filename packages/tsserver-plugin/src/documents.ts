// === Keeping the TypeShade program's documents in step with tsserver's ===
//
// The plugin never reads a file itself (`docs/design.md` §1.1). Every text comes from
// tsserver's own script snapshots, and every decision to re-send one comes from comparing
// tsserver's own script version with what was last sent. That is what makes the two programs
// agree about what the user typed without the plugin watching the filesystem.
//
// Three transitions are handled here, and each exists because of something in the service's
// host (`vendor/typeshade/src/language-service/host.ts`):
//
//   a file loses its directive   closed, or the TypeShade program holds it forever: the file is
//                                still in the project, so pruning cannot reach it
//   a file leaves the project    closed on the next project version change, which is the only
//                                moment the file set can shrink
//   an imported shader changes   re-opened as a real document. The service's host caches a file
//                                pulled in through `readDocument` and never re-reads it, so an
//                                edit to an imported shader would otherwise be invisible to the
//                                importer's diagnostics

import type ts from 'typescript'
import type { TypeshadeLanguageService } from './compiler.js'
import { textHasDirective } from './directive.js'

/** What `DocumentSync` needs from tsserver: script texts, their versions, the project's file
 *  set, and a version that changes whenever that set might have. Narrowed to what is used, so
 *  a test can supply it without standing up a server. */
export interface SyncHost {
  getScriptVersion(fileName: string): string
  getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined
  getScriptFileNames(): string[]
  readFile?(fileName: string): string | undefined
  getProjectVersion?(): string
}

/**
 * Mirrors tsserver's documents into a `TypeshadeLanguageService`.
 *
 * One instance per project, owned by the decoration. Every entry point is cheap when nothing
 * changed: the common case is one string comparison per request.
 */
export class DocumentSync {
  /** Script version last sent to the TypeShade service, per open document. */
  private readonly open = new Map<string, string>()
  /** Files served to the service through `readDocument` and not yet opened as documents. */
  private readonly served = new Set<string>()
  /** The project version at the last prune. */
  private projectVersion = ''
  /** Monotonic document version handed to the service. Its own revision counter is what
   *  actually decides staleness, so this only has to never go backwards. */
  private nextVersion = 1

  constructor(
    private readonly typescript: typeof ts,
    private readonly host: SyncHost,
    private readonly shade: TypeshadeLanguageService,
  ) {}

  /**
   * Brings `fileName` into the TypeShade program, or takes it back out.
   *
   * @param fileName - the file the request is about.
   * @param isTypeshade - whether it carries the directive right now.
   * @returns true when the TypeShade service holds the file and may be asked about it.
   */
  sync(fileName: string, isTypeshade: boolean): boolean {
    this.pruneIfProjectChanged()
    if (!isTypeshade) {
      // The directive was edited out. Close it now: nothing else can, because the file is still
      // a member of the project and so survives every prune.
      if (this.open.delete(fileName)) this.shade.closeDocument(fileName)
      return false
    }
    this.refreshServed()
    return this.send(fileName)
  }

  /**
   * Reads a file the TypeShade program asked for because an open shader imports it.
   *
   * Only a file that carries the directive is served (`docs/design.md` §1.7): a plain
   * TypeScript module is written for the standard library, and the TypeShade program has none,
   * so pulling it in would report errors inside a file nobody asked to be a shader.
   *
   * @param uri - the resolved file the import points at.
   * @returns the file's text, or undefined to leave the import unresolved.
   */
  readDocument = (uri: string): string | undefined => {
    if (this.open.has(uri)) return this.textOf(uri)
    const text = this.textOf(uri)
    if (text === undefined) return undefined
    if (!textHasDirective(this.typescript, uri, text)) return undefined
    // Remembered so the next request promotes it to a real document, whose version the service
    // tracks; the copy the host keeps for a `readDocument` file never refreshes.
    this.served.add(uri)
    return text
  }

  /** Every document the TypeShade service currently holds, for a test to assert against. */
  openFileNames(): readonly string[] {
    return [...this.open.keys()]
  }

  /** Sends `fileName`'s current text when its version moved, and reports whether the service
   *  holds it at all. */
  private send(fileName: string): boolean {
    const version = this.host.getScriptVersion(fileName)
    if (this.open.get(fileName) === version) return true
    const text = this.textOf(fileName)
    if (text === undefined) {
      if (this.open.delete(fileName)) this.shade.closeDocument(fileName)
      return false
    }
    const documentVersion = this.nextVersion++
    if (this.open.has(fileName)) this.shade.updateDocument(fileName, text, documentVersion)
    else this.shade.openDocument(fileName, text, documentVersion)
    this.open.set(fileName, version)
    this.served.delete(fileName)
    return true
  }

  /** Promotes every file served through `readDocument` into a real document, and keeps it
   *  current afterwards. */
  private refreshServed(): void {
    if (this.served.size === 0) return
    for (const uri of [...this.served]) this.send(uri)
  }

  /** Drops documents the project no longer holds. Only runs when the project version moved,
   *  because that is the only moment the file set can have shrunk. */
  private pruneIfProjectChanged(): void {
    const version = this.host.getProjectVersion?.()
    if (version === undefined || version === this.projectVersion) return
    this.projectVersion = version
    const inProject = new Set(this.host.getScriptFileNames())
    for (const fileName of [...this.open.keys()]) {
      if (!inProject.has(fileName)) {
        this.open.delete(fileName)
        this.served.delete(fileName)
        this.shade.closeDocument(fileName)
      }
    }
  }

  /** A file's current text, from the snapshot tsserver holds, or from the host's own reader for
   *  a file it has no snapshot for. */
  private textOf(fileName: string): string | undefined {
    const snapshot = this.host.getScriptSnapshot(fileName)
    if (snapshot !== undefined) return snapshot.getText(0, snapshot.getLength())
    return this.host.readFile?.(fileName)
  }
}
