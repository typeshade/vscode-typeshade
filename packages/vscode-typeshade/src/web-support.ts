// === What the web entry decides, held apart from the `vscode` module ===
//
// `extension.web.ts` is the extension in VS Code for the Web: the language features there come
// from the tsserver plugin, which the web host loads by itself (`docs/playground-bridge.md` §4),
// and every command that needs the desktop is a stub that says so. The decisions the entry makes
// are these three, and none of them needs `vscode`, so they are ordinary functions a test can
// call with any input. This file must stay free of Node imports as well: it is bundled for a web
// worker, where there is no `process`, `Buffer` or `require`, and `eslint.config.mjs` refuses a
// `node:` import here.

/** The first VS Code for the Web that loads a TypeScript server plugin from an extension. Earlier
 *  builds were measured not to request the plugin file at all (1.109.0 and 1.90.0), so TypeScript's
 *  own false errors stay and TypeShade's diagnostics never arrive. */
export const FIRST_WEB_PLUGIN_VERSION = '1.110.0';

/** What every stubbed command shows, and the line a reader can trust about the web: what it
 *  gives and what it does not. */
export const WEB_STUB_MESSAGE =
  'TypeShade on the web gives diagnostics, hover, completion and navigation in "use typeshade" ' +
  'files. The preview, the Canvas, Run Entry on CPU and the Playground link need the desktop ' +
  'version.';

/** What the web entry reports about the page it runs in, for the user's warning and for a test. */
export interface WebEnvironment {
  /** Whether the page is cross-origin isolated. Without it TypeScript's semantic server does not
   *  run in the browser, so neither TypeScript nor TypeShade reports a semantic diagnostic. */
  readonly isolated: boolean;
  /** Whether this VS Code is new enough to load the plugin at all. */
  readonly supported: boolean;
  /** The one-time warning, or `undefined` when the page has nothing to warn about. */
  readonly notice: string | undefined;
}

/** The value `activate()` of the web entry returns. */
export interface TypeshadeWebApi {
  readonly web: WebEnvironment;
}

/**
 * The id of every command the manifest contributes.
 *
 * The web entry registers exactly these, read from the manifest at run time and not written down
 * a second time, so a ninth command added to `package.json` is a stub on the web without anyone
 * remembering to say so.
 *
 * @param packageJSON - the extension's manifest, as `context.extension.packageJSON` hands it over.
 * @returns the command ids, in manifest order; empty when the manifest has none.
 */
export function webCommandIds(packageJSON: unknown): string[] {
  const commands = (packageJSON as { contributes?: { commands?: unknown } } | null | undefined)
    ?.contributes?.commands;
  if (!Array.isArray(commands)) return [];
  const ids: string[] = [];
  for (const entry of commands) {
    const id = (entry as { command?: unknown } | null)?.command;
    if (typeof id === 'string' && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Splits `1.110.0` or `1.110.0-insider` into its numbers, or `undefined` for anything else. */
function parseVersion(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-insider)?$/.exec(version.trim());
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Whether a VS Code for the Web of this version loads the TypeShade plugin.
 *
 * An Insiders build reports `1.110.0-insider`, and its suffix is dropped before the comparison.
 * A string that is not a version answers `false`: the warning is the only safeguard on a host
 * that silently ignores the plugin, so an unreadable version takes the cautious side.
 *
 * @param version - `vscode.version`.
 * @returns `true` from 1.110.0 on.
 */
export function hostSupportsWebPlugin(version: string): boolean {
  const have = parseVersion(version);
  const need = parseVersion(FIRST_WEB_PLUGIN_VERSION);
  if (have === undefined || need === undefined) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i] !== need[i]) return have[i] > need[i];
  }
  return true;
}

/**
 * The environment warning for a page, or `undefined` when there is nothing to warn about.
 *
 * A host that is too old never loads the plugin, so that is said first and alone: isolation would
 * not bring it back. On a supported host without isolation the plugin loads and then has nothing
 * to answer with.
 *
 * @param environment - whether the page is cross-origin isolated and which VS Code it is.
 * @returns the sentence to show once, or `undefined`.
 */
export function describeEnvironment(environment: {
  readonly isolated: boolean;
  readonly version: string;
}): string | undefined {
  if (!hostSupportsWebPlugin(environment.version)) {
    return (
      `TypeShade: this VS Code for the Web is ${environment.version}, and the TypeShade plugin ` +
      `needs ${FIRST_WEB_PLUGIN_VERSION} or later. TypeScript's own errors will show on ` +
      '"use typeshade" files, and TypeShade\'s diagnostics, hover and completion will not.'
    );
  }
  if (!environment.isolated) {
    return (
      'TypeShade: this page is not cross-origin isolated, so the TypeScript server runs without ' +
      'its semantic checks in the browser. There are no TypeShade diagnostics here, and ' +
      'TypeScript shows none of its own either. vscode.dev is isolated; a self-hosted VS Code ' +
      'for the Web needs the Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers.'
    );
  }
  return undefined;
}
