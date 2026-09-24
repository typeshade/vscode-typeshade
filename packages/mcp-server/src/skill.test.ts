import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from './compiler.js';
import { FOREIGN_NAMES, Vocabulary } from './vocabulary.js';

// The plugin's skill (`plugins/typeshade/skills/typeshade`) held to the compiler it describes.
//
// A skill that teaches a construct the compiler refuses is worse than no skill: the agent writes
// it with confidence. So every `"use typeshade"` block in the skill is compiled here against the
// pinned compiler, the way the compiler's own `src/compiler/ts/doc-snippets.test.ts` holds its
// documentation, and the pull request that moves the pin fails when the language moves under the
// skill. The test lives in this package because the plugin has none of its own and this package
// owns everything agent-facing; nothing here ships to a user.

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const PLUGIN = join(REPO, 'plugins/typeshade');
const SKILL = join(PLUGIN, 'skills/typeshade');

/** Every Markdown file of the skill, with its text. */
function skillFiles(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.md'))
        out.push({ file: path.slice(SKILL.length + 1), text: readFileSync(path, 'utf8') });
    }
  };
  walk(SKILL);
  return out;
}

/** A shader block and what it is expected to do. */
interface Block {
  readonly where: string;
  readonly source: string;
  /** The one error code the block must produce, when it is an example of a mistake. */
  readonly expect?: string;
}

/** The fenced `ts` blocks that are shaders, each with the `<!-- expect: TS8xxx -->` marker above
 *  it when it has one. Host code (no directive) is not a shader and is skipped. */
function shaderBlocks(): Block[] {
  const blocks: Block[] = [];
  for (const { file, text } of skillFiles()) {
    const fence = /(?:<!-- expect: (TS\d{4}) -->\n\n?)?```ts\n([\s\S]*?)\n```/g;
    for (const match of text.matchAll(fence)) {
      const source = match[2];
      // A shader block starts with the directive exactly as an author writes it. One that starts
      // any other way (`'use typeshade';`, which a TypeScript formatter produces) is a block a
      // formatter has rewritten, and it would otherwise be skipped here in silence.
      if (/^['"]use typeshade['"];?$/m.test(source.split('\n')[0])) {
        expect(source.split('\n')[0], `${file}: a rewritten directive`).toBe('"use typeshade"');
      }
      if (!source.startsWith('"use typeshade"')) continue;
      const line = text.slice(0, match.index).split('\n').length;
      blocks.push({ where: `${file}:${line}`, source: `${source}\n`, expect: match[1] });
    }
  }
  return blocks;
}

describe('the skill', () => {
  const blocks = shaderBlocks();

  it('has shader examples to check', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(15);
  });

  it.each(blocks.map((b) => [b.where, b] as const))('%s compiles as the skill says', (_, block) => {
    const { diagnostics } = compile(block.source, { fileName: 'skill-example.shade.ts' });
    const shown = diagnostics.map(
      (d) => `${d.line}:${d.character} ${d.category} ${d.code} ${d.message}`,
    );
    if (block.expect === undefined) {
      // Not even a warning: a warning such as a GLSL-reserved name drops the GLSL output, and an
      // example should be one a reader can copy for either target.
      expect(shown).toEqual([]);
    } else {
      const errors = diagnostics.filter((d) => d.category === 'error');
      expect(errors.length, shown.join('\n')).toBeGreaterThan(0);
      expect(errors.map((d) => d.code)).toEqual(errors.map(() => block.expect));
    }
  });

  it('keeps to the portable Agent Skills frontmatter', () => {
    const text = readFileSync(join(SKILL, 'SKILL.md'), 'utf8');
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
    const fields = Object.fromEntries(
      front
        .split('\n')
        .map((line) => [
          line.slice(0, line.indexOf(':')),
          line.slice(line.indexOf(':') + 1).trim(),
        ]),
    );
    // Only fields every Agent Skills reader understands, so the directory can be copied into
    // Codex, Cursor or Gemini CLI as it is.
    expect(Object.keys(fields).sort()).toEqual(['description', 'name']);
    expect(fields.name).toBe('typeshade');
    expect(fields.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(fields.description.length).toBeGreaterThan(100);
    expect(fields.description.length).toBeLessThanOrEqual(1024);
    expect(text.split('\n').length).toBeLessThan(500);
  });

  it('links only to files it has', () => {
    for (const { file, text } of skillFiles()) {
      for (const [, target] of text.matchAll(/\]\(((?:references\/)?[\w-]+\.md)\)/g)) {
        const base = file.includes('/') ? join(SKILL, file, '..') : SKILL;
        expect(existsSync(join(base, target)), `${file} links to ${target}`).toBe(true);
      }
    }
  });

  it("translates GLSL and HLSL names exactly as the server's docs tool does", () => {
    const text = readFileSync(join(SKILL, 'SKILL.md'), 'utf8');
    const table = text.split('<!-- names: foreign to typeshade -->\n')[1]?.split('\n\n')[0] ?? '';
    const rows = table.split('\n').filter((row) => row.startsWith('| `'));
    expect(rows.length).toBeGreaterThan(10);
    const vocabulary = new Vocabulary();
    for (const row of rows) {
      const [foreign, target] = row.split('|').slice(1, 3);
      const want = /`([^`]+)`/.exec(target)?.[1] ?? '';
      const name = want.replace(/^@builtin\("(.*)"\)$/, '$1').replace(/\(\)$/, '');
      expect(vocabulary.has(want), `${want} is not a TypeShade name`).toBe(true);
      for (const [, source] of foreign.matchAll(/`([^`]+)`/g)) {
        const key = source.replace(/\(\)$/, '');
        expect(FOREIGN_NAMES[key]?.name, `${key} in SKILL.md and in FOREIGN_NAMES`).toBe(name);
      }
    }
  });

  it('lists every diagnostic code the compiler has, by its own name', () => {
    // `codes.ts` is the compiler's private table. It is read as text because it is not exported,
    // and a pin bump that adds or renames a code fails here, which is the moment to document it.
    const codes = readFileSync(join(REPO, 'vendor/typeshade/src/compiler/ts/codes.ts'), 'utf8');
    const compiler = [...codes.matchAll(/(\w+): '(TS8\d{3})'/g)].map(
      ([, name, code]) => `${code} ${name}`,
    );
    const text = readFileSync(join(SKILL, 'references/diagnostics.md'), 'utf8');
    const listed = [...text.matchAll(/^\| (TS8\d{3}) \| (\w+) +\|/gm)].map(
      ([, code, name]) => `${code} ${name}`,
    );
    expect(listed.sort()).toEqual(compiler.sort());
  });
});

describe('the plugin', () => {
  const read = (path: string): Record<string, unknown> =>
    JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

  it('is the one plugin of the marketplace, at the path the marketplace names', () => {
    const marketplace = read(join(REPO, '.claude-plugin/marketplace.json'));
    const plugins = marketplace.plugins as { name: string; source: string }[];
    expect(plugins.map((p) => p.name)).toEqual(['typeshade']);
    expect(join(REPO, plugins[0].source)).toBe(join(PLUGIN));
    expect(read(join(PLUGIN, '.claude-plugin/plugin.json')).name).toBe('typeshade');
  });

  it('starts this package as its MCP server', () => {
    const { mcpServers } = read(join(PLUGIN, '.mcp.json')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    const ownName = (
      read(fileURLToPath(new URL('../package.json', import.meta.url))) as { name: string }
    ).name;
    expect(mcpServers.typeshade.command).toBe('npx');
    expect(mcpServers.typeshade.args).toEqual(['-y', ownName]);
  });
});
