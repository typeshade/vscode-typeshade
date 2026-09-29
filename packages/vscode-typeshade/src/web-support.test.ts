// The web entry's decisions, called with any input: which commands become stubs, which VS Code
// loads the plugin, and what the one-time warning says. `web-build.test.ts` runs the built entry
// with a fake `vscode`; these hold the functions it calls.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  describeEnvironment,
  FIRST_WEB_PLUGIN_VERSION,
  hostSupportsWebPlugin,
  webCommandIds,
} from './web-support.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')) as unknown;

describe('webCommandIds', () => {
  it('returns every command the real manifest contributes, in order', () => {
    // Written out on purpose: `manifest.test.ts` pins the eight ids and their titles, and this
    // is the check that the web entry, which reads the manifest and not a list, sees all of them.
    expect(webCommandIds(manifest)).toEqual([
      'typeshade.showWgsl',
      'typeshade.showGlsl',
      'typeshade.showReflection',
      'typeshade.showCanvas',
      'typeshade.runEntry',
      'typeshade.copyOutput',
      'typeshade.openInPlayground',
      'typeshade.openPlaygroundLink',
    ]);
  });

  it('follows the manifest it is given, not a list of its own', () => {
    const ids = webCommandIds({
      contributes: { commands: [{ command: 'a.one' }, { command: 'a.two' }, { command: 'a.one' }] },
    });
    expect(ids).toEqual(['a.one', 'a.two']);
  });

  it('answers an empty list for a manifest with no commands, and for no manifest', () => {
    expect(webCommandIds({})).toEqual([]);
    expect(webCommandIds({ contributes: {} })).toEqual([]);
    expect(webCommandIds({ contributes: { commands: 'typeshade.showWgsl' } })).toEqual([]);
    expect(webCommandIds(undefined)).toEqual([]);
    expect(webCommandIds(null)).toEqual([]);
  });

  it('skips an entry that has no command id', () => {
    expect(
      webCommandIds({
        contributes: { commands: [null, {}, { command: 3 }, { command: 'ok.command' }] },
      }),
    ).toEqual(['ok.command']);
  });
});

describe('hostSupportsWebPlugin', () => {
  it('is false below 1.110.0 and true from it on', () => {
    expect(FIRST_WEB_PLUGIN_VERSION).toBe('1.110.0');
    expect(hostSupportsWebPlugin('1.90.0')).toBe(false);
    expect(hostSupportsWebPlugin('1.109.0')).toBe(false);
    expect(hostSupportsWebPlugin('1.109.9')).toBe(false);
    expect(hostSupportsWebPlugin('1.110.0')).toBe(true);
    expect(hostSupportsWebPlugin('1.110.1')).toBe(true);
    expect(hostSupportsWebPlugin('1.139.1')).toBe(true);
    expect(hostSupportsWebPlugin('2.0.0')).toBe(true);
    expect(hostSupportsWebPlugin('1.200.0')).toBe(true);
  });

  it('compares numbers, not strings', () => {
    // As text `1.9.0` sorts after `1.110.0`, and `1.1000.0` before it.
    expect(hostSupportsWebPlugin('1.9.0')).toBe(false);
    expect(hostSupportsWebPlugin('1.1000.0')).toBe(true);
    expect(hostSupportsWebPlugin('0.200.0')).toBe(false);
  });

  it('drops the -insider suffix before it compares', () => {
    expect(hostSupportsWebPlugin('1.110.0-insider')).toBe(true);
    expect(hostSupportsWebPlugin('1.111.0-insider')).toBe(true);
    expect(hostSupportsWebPlugin('1.109.0-insider')).toBe(false);
  });

  it('is false for a string that is not a version', () => {
    // The warning is the only safeguard on a host that ignores the plugin, so an unreadable
    // version takes the cautious side rather than the quiet one.
    for (const version of ['', 'unknown', '1.110', '1.110.x', 'v1.110.0', '1.110.0-beta', '1..0']) {
      expect(hostSupportsWebPlugin(version), version).toBe(false);
    }
  });
});

describe('describeEnvironment', () => {
  it('says nothing on an isolated page of a supported VS Code', () => {
    expect(describeEnvironment({ isolated: true, version: '1.139.1' })).toBeUndefined();
    expect(describeEnvironment({ isolated: true, version: '1.110.0' })).toBeUndefined();
  });

  it('says the page is not isolated when the VS Code is new enough', () => {
    const notice = describeEnvironment({ isolated: false, version: '1.139.1' });
    expect(notice).toMatch(/not cross-origin isolated/);
    expect(notice).toMatch(/no TypeShade diagnostics/);
    expect(notice).not.toMatch(/needs 1\.110\.0/);
  });

  it('says the VS Code is too old, with its version, when isolation is there', () => {
    const notice = describeEnvironment({ isolated: true, version: '1.109.0' });
    expect(notice).toMatch(/1\.109\.0/);
    expect(notice).toMatch(/needs 1\.110\.0 or later/);
    expect(notice).not.toMatch(/isolated/);
  });

  it('says the VS Code is too old and nothing else when both are wrong', () => {
    // An old host never loads the plugin, so isolation would not bring it back: one sentence,
    // the one that can be acted on.
    const both = describeEnvironment({ isolated: false, version: '1.90.0' });
    expect(both).toBe(describeEnvironment({ isolated: true, version: '1.90.0' }));
    expect(both).toMatch(/needs 1\.110\.0 or later/);
  });

  it('takes the four combinations to two distinct warnings and one silence', () => {
    const answers = [
      describeEnvironment({ isolated: true, version: '1.139.1' }),
      describeEnvironment({ isolated: false, version: '1.139.1' }),
      describeEnvironment({ isolated: true, version: '1.109.0' }),
      describeEnvironment({ isolated: false, version: '1.109.0' }),
    ];
    expect(answers.filter((answer) => answer === undefined)).toHaveLength(1);
    expect(new Set(answers.filter((answer) => answer !== undefined)).size).toBe(2);
  });
});
