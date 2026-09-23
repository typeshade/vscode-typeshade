import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { BROKEN, CLEAN, testProject, type TestProject } from './fixtures.js';

// The server as a client meets it: the built bundle, started as a child process and spoken to
// over stdio by the official MCP client. The unit tests call `TypeshadeTools` directly; this is
// the half they cannot reach, which is the bundle loading at all, the handshake, the schemas,
// and a tool's failure arriving as a result the model reads rather than as a protocol error.
// `npm run build` must have run: `npm run check` does it first, as it does for the plugin.

const BUNDLE = fileURLToPath(new URL('../dist/index.js', import.meta.url));

/** The text of a tool result. */
function textOf(result: { content?: unknown }): string {
  const content = (result.content ?? []) as { type: string; text?: string }[];
  return content.map((c) => c.text ?? '').join('\n');
}

describe('the server, over stdio', () => {
  let project: TestProject;
  let client: Client;

  beforeAll(async () => {
    expect(existsSync(BUNDLE), `${BUNDLE} is missing; run npm run build`).toBe(true);
    project = testProject({ 'shaders/clean.shade.ts': CLEAN, 'shaders/broken.shade.ts': BROKEN });
    client = new Client({ name: 'typeshade-mcp-test', version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [BUNDLE, '--root', project.root],
        stderr: 'pipe',
      }),
    );
  });

  afterAll(async () => {
    await client.close();
    project.cleanup();
  });

  it('introduces itself, and tells the model to check after every edit', () => {
    expect(client.getServerVersion()?.name).toBe('typeshade');
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('"use typeshade"');
    expect(instructions).toContain('call `check` on it');
    // The compiler the bundle carries, by version and commit, so the model knows which
    // language it is being told about.
    expect(instructions).toMatch(/compiler \d+\.\d+\.\d+ \(([0-9a-f]{7,}|unknown commit)\)/);
  });

  it('lists the eight tools, every one of them read-only', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'check',
      'compile',
      'definition',
      'docs',
      'hover',
      'outline',
      'references',
      'run',
    ]);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.description?.length, tool.name).toBeGreaterThan(40);
    }
  });

  it('answers a check with the diagnostics a model can act on', async () => {
    const result = await client.callTool({ name: 'check', arguments: { file: 'shaders' } });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain('error TS8004 [typeshade] shaders/broken.shade.ts:5:13');
    expect(text).toContain('No problems: shaders/clean.shade.ts');
  });

  it("reports the agent's mistake as a failed result it can read, not a protocol error", async () => {
    const result = await client.callTool({
      name: 'hover',
      arguments: { file: 'shaders/clean.shade.ts', line: 7, symbol: 'nothere' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('"nothere" does not occur on line 7');
  });

  it('rejects arguments that do not fit the schema before any tool runs', async () => {
    const result = await client.callTool({ name: 'hover', arguments: { file: 'x', line: 0 } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/line/i);
  });

  it('runs a helper on the CPU', async () => {
    const result = await client.callTool({
      name: 'run',
      arguments: { file: 'shaders/clean.shade.ts', function: 'tint', args: [3] },
    });
    expect(textOf(result)).toBe('tint returned 1.5\nprecision: f32');
  });

  it('serves the ambient declarations as a resource', async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(['typeshade://ambient/shade.d.ts']);
    const { contents } = await client.readResource({ uri: 'typeshade://ambient/shade.d.ts' });
    const [first] = contents as { text?: string }[];
    expect(first.text).toContain('declare function mix(');
  });
});

describe('the roots the server reads under, without --root', () => {
  /** A client connected to a server started in `cwd`, reporting `roots` when given. */
  async function connect(cwd: string, roots?: string[]): Promise<Client> {
    const client = new Client(
      { name: 'typeshade-mcp-test', version: '0.0.0' },
      roots === undefined ? {} : { capabilities: { roots: { listChanged: true } } },
    );
    if (roots !== undefined) {
      client.setRequestHandler('roots/list', async () => ({
        roots: roots.map((root) => ({ uri: pathToFileURL(root).href })),
      }));
    }
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: [BUNDLE], cwd, stderr: 'pipe' }),
    );
    return client;
  }

  it('reads under the workspace folders the client reports, wherever it was started', async () => {
    // Not every client starts a stdio server in the project directory, which is why the roots
    // a client reports come first: here the server starts in the system's temporary directory
    // and still resolves a path under the project.
    const project = testProject({ 'shaders/clean.shade.ts': CLEAN });
    const client = await connect(tmpdir(), [project.root]);
    try {
      const result = await client.callTool({
        name: 'check',
        arguments: { file: 'shaders/clean.shade.ts' },
      });
      expect(textOf(result)).toBe('No problems: shaders/clean.shade.ts');
    } finally {
      await client.close();
      project.cleanup();
    }
  });

  it('reads under the directory it was started in when the client reports no roots', async () => {
    const project = testProject({ 'shaders/clean.shade.ts': CLEAN });
    const client = await connect(project.root);
    try {
      const result = await client.callTool({
        name: 'check',
        arguments: { file: 'shaders/clean.shade.ts' },
      });
      expect(textOf(result)).toBe('No problems: shaders/clean.shade.ts');
    } finally {
      await client.close();
      project.cleanup();
    }
  });
});

describe('the command line', () => {
  it('prints its usage, naming the compiler it carries', () => {
    const usage = execFileSync(process.execPath, [BUNDLE, '--help'], { encoding: 'utf8' });
    expect(usage).toMatch(/^typeshade-mcp \S+ \(compiler \d+\.\d+\.\d+ /);
    expect(usage).toContain('--root <dir>');
  });

  it('refuses an argument it does not know, and a root that does not exist', () => {
    const run = (args: string[]): string => {
      try {
        execFileSync(process.execPath, [BUNDLE, ...args], { encoding: 'utf8', stdio: 'pipe' });
      } catch (error) {
        return String((error as { stderr?: string }).stderr);
      }
      throw new Error('expected the process to fail');
    };
    expect(run(['--frobnicate'])).toContain('unknown argument: --frobnicate');
    expect(run(['--root', '/no/such/directory/anywhere'])).toContain('typeshade-mcp:');
  });
});
