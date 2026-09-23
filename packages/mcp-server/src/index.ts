#!/usr/bin/env node
// === typeshade-mcp: the stdio entry point ===
//
// An MCP client starts this as a child process and speaks JSON-RPC over its stdin and stdout, so
// stdout belongs to the protocol from the first byte. Anything else written there (a stray
// `console.log` in a dependency) would be read as a malformed message, so the console's stdout
// methods are pointed at stderr before anything else loads, and stderr is where this process
// says anything a person should see.

import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';

/** Set by `scripts/build.mjs` from this package's `package.json`. */
declare const __TYPESHADE_MCP_VERSION__: string;
/** Set by `scripts/build.mjs` from the vendored compiler: its version and commit. */
declare const __TYPESHADE_COMPILER__: string;

const VERSION = typeof __TYPESHADE_MCP_VERSION__ === 'string' ? __TYPESHADE_MCP_VERSION__ : 'dev';
const COMPILER = typeof __TYPESHADE_COMPILER__ === 'string' ? __TYPESHADE_COMPILER__ : 'dev';

const USAGE = `typeshade-mcp ${VERSION} (compiler ${COMPILER})

A Model Context Protocol server over stdio for TypeShade shader files. An MCP client starts it;
there is nothing to type into it.

Usage:
  typeshade-mcp [--root <dir>]...

Options:
  --root <dir>   A directory the tools may read under. Repeat for several. The first is where
                 relative paths resolve. Default: the workspace folders the client reports
                 (MCP roots), or else the directory the client started it in.
  --help         Print this and exit.
  --version      Print the version and exit.

Claude Code:
  claude mcp add typeshade -- npx -y @typeshade/mcp`;

/** What the command line asked for. */
type Command = { kind: 'serve'; roots: string[] } | { kind: 'help' } | { kind: 'version' };

/**
 * Reads the command line.
 *
 * @param argv - the arguments after the script name.
 * @returns what to do.
 * @throws Error naming the first argument that is not understood.
 */
function parseArguments(argv: readonly string[]): Command {
  const roots: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { kind: 'help' };
    if (arg === '--version' || arg === '-v') return { kind: 'version' };
    if (arg === '--root') {
      const value = argv[++i];
      if (value === undefined) throw new Error('--root needs a directory');
      roots.push(value);
    } else if (arg.startsWith('--root=')) {
      roots.push(arg.slice('--root='.length));
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { kind: 'serve', roots };
}

async function main(): Promise<void> {
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;

  const command = parseArguments(process.argv.slice(2));
  // Neither of these starts the server, so stdout is free for them, as it is for any command.
  if (command.kind === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (command.kind === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const server = createServer({
    roots: command.roots,
    cwd: process.cwd(),
    version: VERSION,
    compiler: COMPILER,
  });
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(
    `typeshade-mcp: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
