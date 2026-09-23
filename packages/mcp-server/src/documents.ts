// === The TypeShade language service, fed from the disk ===
//
// The plugin keeps the TypeShade program in step with tsserver's snapshots through
// `DocumentSync` (`packages/tsserver-plugin/src/documents.ts`). The server has no tsserver, so
// it feeds the SAME class from the files themselves: a script version is a hash of what is on
// disk now, and a snapshot is the file's text. Reusing the class rather than writing a second
// one keeps the three rules of `docs/design.md` §1.1 in one place, in particular the one that is
// easy to lose: a shader pulled in through an import is promoted to a real document, because the
// service's host caches an imported file and never re-reads it, so an agent's edit to
// `lib.shade.ts` would otherwise be invisible to `main.shade.ts`.
//
// The import is relative rather than through the plugin's package, because the plugin's package
// is one CommonJS bundle that exports only the factory tsserver calls. Both packages are bundled,
// so this costs nothing at run time.

import { createHash } from 'node:crypto';
import typescript from 'typescript';
import { DocumentSync, type SyncHost } from '../../tsserver-plugin/src/documents.js';
import { textHasDirective } from '../../tsserver-plugin/src/directive.js';
import { createTypeshadeLanguageService, type TypeshadeLanguageService } from './compiler.js';
import { toUri, type Workspace } from './workspace.js';

/** A file as one request saw it. */
export interface OpenedFile {
  /** The document uri the service knows the file by. */
  readonly uri: string;
  /** The file's text at the moment it was synced. */
  readonly text: string;
  /** Whether the file carries `"use typeshade"`. Without it the service holds nothing for it. */
  readonly isShader: boolean;
}

/**
 * One language service over the workspace's shader files, kept current with the disk.
 *
 * Long-lived on purpose: the service reuses the parsed ambient lib and every unchanged document
 * between requests, which is most of the cost of an answer (`docs/design.md` §1.3).
 */
export class DiskDocuments {
  /** The TypeShade service every navigation tool asks. */
  readonly shade: TypeshadeLanguageService;
  private readonly sync: DocumentSync;
  /** Reads made during the current request, so a file is read once however many times the sync
   *  asks for its version and its text. Cleared by {@link beginRequest}. */
  private readonly reads = new Map<string, string | undefined>();
  /** The version of each file read during the current request, for the same reason: the sync
   *  compares every open document's version on every call it gets. */
  private readonly versions = new Map<string, string>();
  /** A counter for the uris of documents that exist only as text an agent passed in. */
  private inlineCount = 0;

  constructor(private readonly workspace: Workspace) {
    // The service and the sync refer to each other, as they do in the plugin: the service asks
    // for an imported file through `readDocument`, and the sync answers it.
    let sync: DocumentSync | undefined;
    this.shade = createTypeshadeLanguageService({
      readDocument: (uri) => sync?.readDocument(uri),
    });
    const host: SyncHost = {
      getScriptVersion: (uri) => {
        let version = this.versions.get(uri);
        if (version === undefined) {
          const text = this.readOnce(uri);
          version = text === undefined ? '' : createHash('sha1').update(text).digest('hex');
          this.versions.set(uri, version);
        }
        return version;
      },
      getScriptSnapshot: (uri) => {
        const text = this.readOnce(uri);
        return text === undefined ? undefined : typescript.ScriptSnapshot.fromString(text);
      },
      // Only read when `getProjectVersion` is present, which it is not: there is no project, and
      // a document whose file was deleted is closed by the sync itself when its text is gone.
      getScriptFileNames: () => [],
      readFile: (uri) => this.readOnce(uri),
    };
    sync = new DocumentSync(typescript, host, this.shade);
    this.sync = sync;
  }

  /** Forgets what the last request read, so the next {@link open} sees the disk as it is now.
   *  Called once at the start of every tool call, and never in the middle of one, so a request
   *  that opens many files reads each of them once. */
  beginRequest(): void {
    this.reads.clear();
    this.versions.clear();
  }

  /**
   * Brings a file's current text into the service, along with any open document that changed on
   * disk since the last request.
   *
   * @param path - a canonical path inside the workspace.
   * @returns the file as this request saw it.
   */
  open(path: string): OpenedFile {
    const uri = toUri(path);
    const text = this.readOnce(uri) ?? '';
    const isShader = textHasDirective(typescript, uri, text);
    this.sync.sync(uri, isShader);
    return { uri, text, isShader };
  }

  /**
   * Runs `use` against a document that exists only as text, then drops it.
   *
   * The document is named as if it sat at the first root, so a relative import in it resolves
   * against the workspace the way it would from a file there.
   *
   * @param text - the source an agent passed in.
   * @param use - what to ask the service while the document is open.
   * @returns whatever `use` returns.
   */
  withInline<T>(text: string, use: (file: OpenedFile) => T): T {
    const uri = `${toUri(this.workspace.roots[0])}/typeshade-inline-${++this.inlineCount}.shade.ts`;
    const isShader = textHasDirective(typescript, uri, text);
    this.shade.openDocument(uri, text, 1);
    try {
      return use({ uri, text, isShader });
    } finally {
      this.shade.closeDocument(uri);
    }
  }

  /** A file's text, read at most once per request. */
  private readOnce(uri: string): string | undefined {
    if (!this.reads.has(uri)) this.reads.set(uri, this.workspace.read(uri));
    return this.reads.get(uri);
  }
}
