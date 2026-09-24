// === The MCP adapter ===
//
// Declares the tools, validates their arguments against a schema a client can read, and turns
// what `TypeshadeTools` answers into a tool result. Nothing here knows anything about TypeShade
// beyond the words in the descriptions; the answers are all `tools.ts`'s.
//
// The descriptions are written for the model that reads them, which decides from these words
// alone when to call a tool and what to pass. So each one says what the tool is for, in the
// terms of the job ("after editing a shader"), and what its input looks like, briefly.

import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { SHADE_DTS } from './compiler.js';
import { ToolError } from './errors.js';
import { TypeshadeTools } from './tools.js';
import { Workspace } from './workspace.js';

/** How the server was started. */
export interface ServerOptions {
  /** The directories `--root` named. When there are none, the server reads under the workspace
   *  folders the client reports, and under `cwd` until it has them or if it never does. */
  readonly roots: readonly string[];
  /** The directory the client started the server in. */
  readonly cwd: string;
  /** This server's version, reported in the handshake. */
  readonly version: string;
  /** The compiler the server was built with, as `version (commit)`, reported to the model so it
   *  knows which language it is being told about. */
  readonly compiler: string;
}

/** What every tool result carries: text for the model, and whether the call failed. */
interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/** The instructions sent in the handshake, which clients put in front of the model. */
function instructionsFor(compiler: string): string {
  return [
    `TypeShade (compiler ${compiler}) is a shader language written as TypeScript: a file that ` +
      'starts with the line "use typeshade" compiles to WGSL and GLSL ES 3.00.',
    "These tools answer from TypeShade's own compiler and language service. They know GPU " +
      "types that TypeScript's checker does not, and they drop the TypeScript errors that are " +
      'false for shader code (vector arithmetic, stage decorators), so trust them over a plain ' +
      'TypeScript diagnostic on a "use typeshade" file.',
    'After writing or editing a "use typeshade" file, call `check` on it and fix every error ' +
      'before moving on. Use `docs` to find the TypeShade name for a type, builtin function, ' +
      'attribute or @builtin id instead of guessing a GLSL or HLSL spelling. Use `run` to test ' +
      'a helper or an entry point on the CPU with concrete inputs.',
    'Lines and columns are 1-based. Paths are relative to the workspace root.',
  ].join('\n\n');
}

/** A schema for one-based positions, shared by the navigation tools. */
const position = {
  file: z.string().describe('Path of a "use typeshade" file, relative to the workspace root.'),
  line: z.number().int().min(1).describe('1-based line number.'),
  symbol: z
    .string()
    .optional()
    .describe('The identifier to point at on that line. Easier than counting columns.'),
  column: z.number().int().min(1).optional().describe('1-based column, instead of `symbol`.'),
};

/** A schema for "a file, or source text instead". */
const source = {
  file: z
    .string()
    .optional()
    .describe('Path of a "use typeshade" file, relative to the workspace root.'),
  source: z
    .string()
    .optional()
    .describe('Shader source text, starting with "use typeshade", to use instead of a file.'),
};

/** Tool annotations: every tool reads, none writes, and none reaches outside the workspace. */
const readOnly = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

/**
 * Builds the server, with every tool registered and nothing connected yet.
 *
 * @param options - the roots to read under, and the versions to report.
 * @returns the server, ready for `connect`.
 * @throws Error when a root does not exist.
 */
export function createServer(options: ServerOptions): McpServer {
  const explicit = options.roots.length > 0;
  const workspace = new Workspace(explicit ? options.roots : [options.cwd]);
  const tools = new TypeshadeTools(workspace);
  const server = new McpServer(
    { name: 'typeshade', version: options.version },
    { instructions: instructionsFor(options.compiler) },
  );
  const ready = explicit ? Promise.resolve() : followClientRoots(server, workspace);

  server.registerTool(
    'check',
    {
      title: 'Check TypeShade files',
      description:
        'Report the errors and warnings in "use typeshade" shader files, exactly as the ' +
        'TypeShade editor plugin shows them, plus any target the WGSL or GLSL emitter refuses. ' +
        'Call it after every edit to a shader. Pass `file` (a file, or a directory to check ' +
        'every shader under it), `files`, or `source` to check text before writing it.',
      inputSchema: z.object({
        ...source,
        file: z
          .string()
          .optional()
          .describe('A shader file, or a directory whose "use typeshade" files are all checked.'),
        files: z.array(z.string()).optional().describe('Several files or directories.'),
      }),
      annotations: readOnly,
    },
    async (args) => answer(ready, () => tools.check(args)),
  );

  server.registerTool(
    'compile',
    {
      title: 'Compile a TypeShade file',
      description:
        'Compile one shader and show what the compiler emits: WGSL (the default), the GLSL ES ' +
        '3.00 vertex and fragment programs, the reflection (bind groups, uniform layouts with ' +
        'byte offsets, entry points), or the determinism report (operations whose results may ' +
        'differ between GPUs).',
      inputSchema: z.object({
        ...source,
        targets: z
          .array(z.enum(['wgsl', 'glsl', 'reflection', 'determinism']))
          .optional()
          .describe('Which outputs to show. Default: ["wgsl"].'),
      }),
      annotations: readOnly,
    },
    async (args) => answer(ready, () => tools.compile(args)),
  );

  server.registerTool(
    'hover',
    {
      title: 'Type of a name',
      description:
        "The TypeShade compiler's type and documentation for the name at a position in a shader " +
        "(the editor's hover). It knows what TypeScript cannot: `let x = 1.` is an f32, and a " +
        'resource shows its @group and @binding.',
      inputSchema: z.object(position),
      annotations: readOnly,
    },
    async (args) => answer(ready, () => tools.hover(args)),
  );

  server.registerTool(
    'definition',
    {
      title: 'Go to definition',
      description: 'Where the name at a position in a shader is declared.',
      inputSchema: z.object(position),
      annotations: readOnly,
    },
    async (args) => answer(ready, () => tools.definition(args)),
  );

  server.registerTool(
    'references',
    {
      title: 'Find references',
      description:
        'Every use of the name at a position, across all "use typeshade" files in the workspace.',
      inputSchema: z.object(position),
      annotations: readOnly,
    },
    async (args) => answer(ready, () => tools.references(args)),
  );

  server.registerTool(
    'outline',
    {
      title: 'Outline a shader',
      description:
        'The structs, resources (with their @group and @binding), constants, functions and entry ' +
        'points of one shader file, each with its type and line range.',
      inputSchema: z.object({ file: position.file }),
      annotations: readOnly,
    },
    async (args) => answer(ready, () => tools.outline(args)),
  );

  server.registerTool(
    'docs',
    {
      title: 'TypeShade vocabulary',
      description:
        'Look up a TypeShade type, builtin function, constant, attribute, @builtin id or Math ' +
        'member: its meaning and every overload signature. An unknown name (say, a GLSL or HLSL ' +
        'spelling) gets the nearest TypeShade names. With no name, lists the whole vocabulary.',
      inputSchema: z.object({
        name: z
          .string()
          .optional()
          .describe(
            'For example "mix", "vec3", "textureSample", "@builtin", "position", "Math.sin".',
          ),
      }),
      annotations: readOnly,
    },
    async (args) => answer(ready, () => tools.docs(args)),
  );

  server.registerTool(
    'run',
    {
      title: 'Run a shader function on the CPU',
      description:
        'Run one function of a shader on the TypeShade CPU interpreter and show what it returns, ' +
        'at f32 precision like a GPU. A helper takes positional `args`; an entry point takes ' +
        '`invocation` (builtin inputs by @builtin id, such as {"position": [100.5, 50.5, 0, 1]} ' +
        'or {"global_invocation_id": [3, 0, 0]}, and @location inputs under "inputs"). Uniform ' +
        'and storage values go in `bindings` by name. Values: a number or boolean for a scalar, ' +
        'a flat array for a vector or column-major matrix, an object for a struct. `breakpoints` ' +
        'lists lines at which to report every local.',
      inputSchema: z.object({
        ...source,
        function: z.string().describe('The function to run: an entry point or a helper.'),
        args: z.array(z.unknown()).optional().describe('Positional arguments, for a helper.'),
        invocation: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('An entry point\'s inputs by @builtin id, plus "inputs" and "dispatch".'),
        bindings: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Uniform and storage values by declared name. Omitted ones read as zero.'),
        precision: z
          .enum(['f32', 'f64'])
          .optional()
          .describe('f32 (default) is what a GPU computes; f64 is the math without f32 rounding.'),
        breakpoints: z
          .array(z.number().int().min(1))
          .optional()
          .describe('1-based lines at which to stop and report the locals.'),
        gpuStubs: z
          .boolean()
          .optional()
          .describe('Let derivatives and texture reads return placeholders instead of failing.'),
      }),
      annotations: readOnly,
    },
    async (args) => answer(ready, () => tools.run(args)),
  );

  server.registerResource(
    'ambient-declarations',
    'typeshade://ambient/shade.d.ts',
    {
      title: 'TypeShade ambient declarations',
      description:
        'Every type, builtin and attribute a "use typeshade" file can name, as the TypeScript ' +
        'declarations the language service checks against (about 2600 lines).',
      mimeType: 'text/plain',
    },
    async (uri) => ({ contents: [{ uri: uri.href, text: SHADE_DTS }] }),
  );

  return server;
}

/**
 * Runs a tool, once the workspace roots are settled, and wraps what it says as a result.
 *
 * A {@link ToolError} is the agent's to fix, so its message is the whole result. Anything else
 * is this server's fault, and says so, so the model does not rewrite a correct shader to work
 * around it.
 */
async function answer(ready: Promise<void>, run: () => string): Promise<ToolResult> {
  await ready;
  try {
    return { content: [{ type: 'text', text: run() }] };
  } catch (error) {
    const text =
      error instanceof ToolError
        ? error.message
        : `Internal error in the TypeShade MCP server (not a problem with your shader): ${
            error instanceof Error ? (error.stack ?? error.message) : String(error)
          }`;
    return { content: [{ type: 'text', text }], isError: true };
  }
}

/** How long a tool call waits for the client to answer `roots/list` before it goes ahead with
 *  the roots it has. A client that declares the capability answers at once; this is for one
 *  that declares it and then never does. */
const ROOTS_TIMEOUT_MS = 2000;

/**
 * Reads under the workspace folders the client reports, when no `--root` was given.
 *
 * MCP's `roots` are how a client says which directories a server is working on, and not every
 * client starts a stdio server in the project directory, so they are a better default than the
 * working directory whenever the client offers them. The list is asked for once the handshake
 * completes and again whenever the client says it changed.
 *
 * @returns a promise every tool call waits on, so the first call after the handshake already
 *   reads under the client's roots. It settles when the roots are in, when the client turns out
 *   not to have any, or after {@link ROOTS_TIMEOUT_MS}, whichever is first.
 */
function followClientRoots(server: McpServer, workspace: Workspace): Promise<void> {
  const adopt = async (): Promise<void> => {
    if (server.server.getClientCapabilities()?.roots === undefined) return;
    try {
      const { roots } = await server.server.listRoots(undefined, { timeout: ROOTS_TIMEOUT_MS });
      workspace.adopt(
        roots.filter((root) => root.uri.startsWith('file:')).map((root) => fileURLToPath(root.uri)),
      );
    } catch {
      // A client that fails the request keeps the working directory as the root.
    }
  };
  let settle: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const timer = setTimeout(settle, ROOTS_TIMEOUT_MS);
  timer.unref();
  server.server.oninitialized = () => {
    void adopt().finally(() => {
      clearTimeout(timer);
      settle();
    });
  };
  server.server.setNotificationHandler('notifications/roots/list_changed', () => adopt());
  return ready;
}
