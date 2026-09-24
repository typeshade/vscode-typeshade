// === Where the server may read, and how a path an agent wrote becomes a file ===
//
// The server reads shader files for an agent, and an agent's arguments are text a model wrote,
// possibly under the influence of text it read somewhere else. So every path goes through one
// rule: it resolves against the first root, it is canonicalized (symbolic links followed), and it
// is refused unless it lands inside one of the roots. The roots are the ones `--root` names, or
// else the workspace folders the client reports (`server.ts`), or else the working directory the
// client started the server in. Nothing here writes.
//
// Paths reach the language service as its document uris, spelled with forward slashes on every
// platform, which is the spelling tsserver hands the plugin and the one the service's default
// import resolution expects (`docs/design.md` §1.1).

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ToolError } from './errors.js';

/** Directories a scan never enters: dependencies, version control, and anything hidden. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git']);

/** How many `.ts` files one directory scan reads before it stops, so a stray root of `/` cannot
 *  keep the server busy for minutes. */
const SCAN_LIMIT = 5000;

/** A path as the language service spells a document uri. */
export function toUri(path: string): string {
  return sep === '\\' ? path.replace(/\\/g, '/') : path;
}

/**
 * The files an agent may ask about.
 */
export class Workspace {
  private current: readonly string[];

  /**
   * @param roots - the directories the server may read under. Each must exist.
   * @throws Error when a root does not exist or is not a directory, since a server started on a
   *   typo would otherwise refuse every request with a message about the request.
   */
  constructor(roots: readonly string[]) {
    if (roots.length === 0) throw new Error('at least one root is required');
    this.current = roots.map((root) => {
      const canonical = realpathSync.native(resolve(root));
      if (!statSync(canonical).isDirectory()) throw new Error(`root is not a directory: ${root}`);
      return canonical;
    });
  }

  /** The canonical roots, in order. The first one is where a relative path resolves. */
  get roots(): readonly string[] {
    return this.current;
  }

  /**
   * Replaces the roots with the ones a client reported.
   *
   * A client's list is taken as far as it names directories that exist here; one that names none
   * (a remote workspace, a folder since deleted) leaves the roots as they were rather than
   * leaving the server with nowhere to read.
   *
   * @param roots - directory paths.
   * @returns whether the roots changed.
   */
  adopt(roots: readonly string[]): boolean {
    const usable: string[] = [];
    for (const root of roots) {
      try {
        const canonical = realpathSync.native(resolve(root));
        if (statSync(canonical).isDirectory() && !usable.includes(canonical))
          usable.push(canonical);
      } catch {
        // Not a directory on this machine; the rest of the list may still be.
      }
    }
    if (usable.length === 0) return false;
    this.current = usable;
    return true;
  }

  /**
   * Resolves a path an agent wrote to a canonical path inside a root.
   *
   * @param file - absolute, or relative to the first root.
   * @returns the canonical path, with the platform's own separators.
   * @throws ToolError when the path does not exist or leaves every root.
   */
  resolve(file: string): string {
    const requested = resolve(this.roots[0], file);
    let canonical: string;
    try {
      canonical = realpathSync.native(requested);
    } catch {
      throw new ToolError(`No such file or directory: ${this.display(requested)}`);
    }
    if (!this.contains(canonical)) {
      throw new ToolError(
        `${file} is outside the workspace. The server reads only under ${this.roots.join(', ')}; ` +
          'start it with --root to widen that.',
      );
    }
    return canonical;
  }

  /**
   * Reads a file inside a root.
   *
   * @param path - a path the caller already resolved, or a document uri.
   * @returns the text, or undefined when the file is missing, unreadable or outside every root.
   *   Never throws: this is the reader the language service calls for an import, and an import
   *   that cannot be read is reported by TypeScript as unresolved, which is the honest answer.
   */
  read(path: string): string | undefined {
    try {
      const canonical = realpathSync.native(path);
      if (!this.contains(canonical) || !statSync(canonical).isFile()) return undefined;
      return readFileSync(canonical, 'utf8');
    } catch {
      return undefined;
    }
  }

  /** Whether `path` is a directory, for the tools that take a file or a directory of them. */
  isDirectory(path: string): boolean {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Every `.ts` file under a directory, in a stable order, skipping declaration files,
   * dependencies, version control and hidden directories.
   *
   * @param directory - a canonical directory inside a root.
   * @returns the canonical paths, and whether the scan stopped at its limit.
   */
  listTypeScriptFiles(directory: string): { files: string[]; truncated: boolean } {
    const files: string[] = [];
    let truncated = false;
    const walk = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        if (files.length >= SCAN_LIMIT) {
          truncated = true;
          return;
        }
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) walk(path);
        } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
          files.push(path);
        }
      }
    };
    walk(directory);
    return { files, truncated };
  }

  /**
   * A path the way an agent should write it back: relative to the root that holds it, with
   * forward slashes, or absolute when no root does.
   */
  display(path: string): string {
    const native = sep === '\\' ? path.replace(/\//g, '\\') : path;
    for (const root of this.roots) {
      const rel = relative(root, native);
      if (rel === '') return '.';
      if (isInside(rel)) return toUri(rel);
    }
    return toUri(native);
  }

  /** Whether a canonical path is one of the roots or under one. */
  private contains(canonical: string): boolean {
    return this.roots.some((root) => {
      const rel = relative(root, canonical);
      return rel === '' || isInside(rel);
    });
  }
}

/** Whether a `relative()` result stays below its base. A name that merely starts with two dots
 *  (`..shaders`) is inside; only a first segment of exactly `..` leaves. */
function isInside(rel: string): boolean {
  return !isAbsolute(rel) && rel.split(sep)[0] !== '..';
}
