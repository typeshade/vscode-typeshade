// === The Playground's link and folder, read and written outside the browser ===
//
// `docs/playground-bridge.md` §2: a workspace moves between the site's Playground and a folder in
// VS Code. The site writes both formats and documents them (typeshade.github.io `DESIGN.md`,
// Components, "The link and the folder"); this module is the other reader and writer, with no
// `vscode` import so the tests can hold it to the site's own bytes.
//
// The link's fragment is URL search parameters. `code` is the main file and `files` a JSON
// object of the files beside it by path, both `encodeSource`d: `z` then the UTF-8 bytes
// `deflate-raw` compressed in base64url, or `u` then the bytes uncompressed. `passes` is
// `name:path` pairs in draw order. The folder holds the same files, the main one at the root,
// with `typeshade.json` naming it and the passes.

import { deflateRawSync, inflateRawSync } from 'node:zlib';

/** The main file's name in the Playground, which the link does not carry: the site's editor
 *  always calls it this (`playground.fileName` in its dictionaries). */
export const PLAYGROUND_MAIN = 'hello.shade.ts';

/** The site the link opens on. */
export const PLAYGROUND_ORIGIN = 'https://typeshade.dev';

/** How a pasted link is read: a short link on the site's own origin is fetched once to learn its
 *  fragment; every other link is read from its own fragment and never fetched. */
export type LinkPlan =
  | { readonly kind: 'fetch'; readonly url: string }
  | { readonly kind: 'fragment'; readonly link: string };

/** The site's short link: `/s/<id>`, with the trailing slash the Worker writes. */
const SHORT_LINK_PATH = /^\/s\/[^/]+\/?$/;

/**
 * Decides whether a link may cost a network request.
 *
 * The `vscode://` handler takes its link from any web page, so a link is data from a stranger:
 * following a short link wherever it points would let a page make the reader's machine fetch
 * an address of its choosing (a host on the reader's network, for one). Only a short link whose
 * origin is exactly the site's is fetched. Anything else, including a link that is no URL at all
 * (the bare fragment `readLink` also reads), is read from the text it carries.
 *
 * @param link - what the reader pasted or the handler received.
 * @param origin - the origin whose short links may be followed; the site's by default.
 */
export function planLink(link: string, origin: string = PLAYGROUND_ORIGIN): LinkPlan {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return { kind: 'fragment', link };
  }
  if (url.origin === origin && SHORT_LINK_PATH.test(url.pathname))
    return { kind: 'fetch', url: url.toString() };
  return { kind: 'fragment', link };
}

/**
 * The Playground link a short link's response redirects to, or an error.
 *
 * It fails closed: a response that is no redirect, has no `Location`, or sends the reader to
 * another origin is refused, so a short link cannot be turned into a link to somewhere else. The
 * caller reads the returned link's fragment and does not fetch it.
 *
 * @param shortLink - the short link that was fetched.
 * @param status - the response's status.
 * @param location - the response's `Location` header, if any.
 * @param origin - the only origin a redirect may name; the site's by default.
 * @throws when the response is not a redirect back to `origin`.
 */
export function shortLinkTarget(
  shortLink: string,
  status: number,
  location: string | null,
  origin: string = PLAYGROUND_ORIGIN,
): string {
  if (status < 300 || status >= 400 || location === null)
    throw new Error(`the short link ${shortLink} does not redirect (${status})`);
  let target: URL;
  try {
    target = new URL(location, shortLink);
  } catch {
    throw new Error(`the short link ${shortLink} redirects to something that is no address`);
  }
  if (target.origin !== origin)
    throw new Error(
      `the short link ${shortLink} redirects away from ${origin}, so it was not followed`,
    );
  return target.toString();
}

/** One pass of the graph, in draw order (compiler change 0026). */
export interface Pass {
  readonly name: string;
  readonly file: string;
}

/** A workspace: the main file, the files beside it by a path relative to the main file's
 *  directory, and the passes. */
export interface Workspace {
  readonly main: { readonly path: string; readonly text: string };
  readonly files: Readonly<Record<string, string>>;
  readonly passes: readonly Pass[];
}

/** What a link names: a workspace, or an example the site has and the link does not carry. */
export type LinkContents =
  | { readonly kind: 'workspace'; readonly workspace: Workspace }
  | { readonly kind: 'example'; readonly id: string }
  | { readonly kind: 'blank' };

const PACKED = 'z';
const PLAIN = 'u';

/** The site's `encodeSource`, compressed. */
export function encodeSource(text: string): string {
  return PACKED + deflateRawSync(Buffer.from(text, 'utf8')).toString('base64url');
}

/** The site's `decodeSource`: either form, whichever browser wrote it. */
export function decodeSource(value: string): string {
  const body = Buffer.from(value.slice(1), 'base64url');
  if (value.startsWith(PACKED)) return inflateRawSync(body).toString('utf8');
  if (value.startsWith(PLAIN)) return body.toString('utf8');
  throw new Error(`a link value starts with ${PACKED} or ${PLAIN}, not ${value.slice(0, 1)}`);
}

/** A pass name the site accepts: the file's stem as an identifier. */
const PASS_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A path the Playground accepts for a file beside the main one (its `badName` rule): a
 *  relative `.shade.ts` path of letters, digits, dots, hyphens, underscores and slashes. */
const FILE_PATH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._\-/]+\.shade\.ts$/;

/** The paths of a link's files, each held to the Playground's own rule. A link is data from a
 *  stranger and `openLink` writes every path it carries into a folder the user picked, so a path
 *  that climbs out of it (`../`), starts at the root, or is no `.shade.ts` file (`.vscode/tasks.json`)
 *  is refused, as is one that would replace the main file. */
function checkedFilePaths(files: Readonly<Record<string, string>>): void {
  for (const path of Object.keys(files)) {
    if (!FILE_PATH.test(path))
      throw new Error(
        `the link carries the file ${path}, which is no .shade.ts path at or below the main file's directory, so nothing was read`,
      );
    if (path === PLAYGROUND_MAIN)
      throw new Error(`the link carries a file at ${path}, the path of its main file`);
  }
}

function checkedPasses(passes: readonly Pass[], files: Readonly<Record<string, string>>): Pass[] {
  return passes.map((pass) => {
    if (!PASS_NAME.test(pass.name)) throw new Error(`the pass name ${pass.name} is no identifier`);
    if (files[pass.file] === undefined)
      throw new Error(`the pass ${pass.name} names ${pass.file}, which the workspace has not`);
    return { name: pass.name, file: pass.file };
  });
}

/**
 * Reads a Playground link, or the fragment of one.
 *
 * @param link - `https://typeshade.dev/playground/#code=...`, or only what follows the `#`.
 * @returns what the link names.
 * @throws when the fragment names nothing, or a value in it does not decode.
 */
export function readLink(link: string): LinkContents {
  const hash = link.includes('#') ? link.slice(link.indexOf('#') + 1) : link;
  const params = new URLSearchParams(hash);
  const code = params.get('code');
  if (code !== null) {
    const filesParam = params.get('files');
    const files = filesParam === null ? {} : (JSON.parse(decodeSource(filesParam)) as unknown);
    if (
      typeof files !== 'object' ||
      files === null ||
      Array.isArray(files) ||
      !Object.values(files).every((text) => typeof text === 'string')
    )
      throw new Error('the link carries files that are not a JSON object of texts by path');
    checkedFilePaths(files as Record<string, string>);
    const passes = (params.get('passes') ?? '')
      .split(',')
      .filter((pair) => pair !== '')
      .map((pair) => {
        const colon = pair.indexOf(':');
        return { name: pair.slice(0, colon), file: pair.slice(colon + 1) };
      });
    const byPath = files as Record<string, string>;
    return {
      kind: 'workspace',
      workspace: {
        main: { path: PLAYGROUND_MAIN, text: decodeSource(code) },
        files: byPath,
        passes: checkedPasses(passes, byPath),
      },
    };
  }
  const example = params.get('example');
  if (example !== null && example !== '') return { kind: 'example', id: example };
  if (params.has('blank')) return { kind: 'blank' };
  throw new Error('the link names no code, example or blank file');
}

/**
 * Writes the link that opens a workspace in the Playground.
 *
 * The main file becomes the Playground's `hello.shade.ts`, so every other file has to sit at or
 * below the main file's directory for an import between them to mean the same thing there.
 *
 * @throws when a file beside the main one is not a path the Playground accepts.
 */
export function writeLink(workspace: Workspace, origin: string = PLAYGROUND_ORIGIN): string {
  for (const path of Object.keys(workspace.files))
    if (!FILE_PATH.test(path))
      throw new Error(
        `${path} is not a .shade.ts path at or below the main file's directory, so the Playground cannot hold it`,
      );
  checkedPasses(workspace.passes, workspace.files);
  const parts = [`code=${encodeSource(workspace.main.text)}`];
  if (Object.keys(workspace.files).length > 0)
    parts.push(`files=${encodeSource(JSON.stringify(workspace.files))}`);
  if (workspace.passes.length > 0)
    parts.push(`passes=${workspace.passes.map((p) => `${p.name}:${p.file}`).join(',')}`);
  return `${origin}/playground/#${parts.join('&')}`;
}

/** `typeshade.json`: the main file and the passes, paths relative to the folder. */
export interface Manifest {
  readonly main: string;
  readonly passes: readonly Pass[];
}

/** Reads `typeshade.json`, refusing what the site would not have written. */
export function readManifest(text: string): Manifest {
  const value = JSON.parse(text) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('typeshade.json is not a JSON object');
  const { main, passes = [] } = value as { main?: unknown; passes?: unknown };
  if (typeof main !== 'string' || !main.endsWith('.shade.ts'))
    throw new Error("typeshade.json's main is not a .shade.ts path");
  if (
    !Array.isArray(passes) ||
    !passes.every(
      (p: unknown) =>
        typeof p === 'object' &&
        p !== null &&
        typeof (p as Pass).name === 'string' &&
        typeof (p as Pass).file === 'string',
    )
  )
    throw new Error("typeshade.json's passes is not a list of { name, file }");
  return { main, passes: (passes as Pass[]).map((p) => ({ name: p.name, file: p.file })) };
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** The folder a workspace is written to: the layout the site's download writes
 *  (typeshade.github.io `src/scripts/workspace-folder.ts`). */
export function folderOf(workspace: Workspace): Record<string, string> {
  return {
    [workspace.main.path]: workspace.main.text,
    ...workspace.files,
    'typeshade.json': json({
      main: workspace.main.path,
      ...(workspace.passes.length > 0 ? { passes: workspace.passes } : {}),
    }),
    'tsconfig.json': json({
      compilerOptions: {
        module: 'esnext',
        moduleResolution: 'bundler',
        allowImportingTsExtensions: true,
        experimentalDecorators: true,
        strict: true,
        noEmit: true,
      },
      include: ['**/*.shade.ts'],
    }),
    '.vscode/extensions.json': json({ recommendations: ['typeshade.vscode-typeshade'] }),
  };
}
