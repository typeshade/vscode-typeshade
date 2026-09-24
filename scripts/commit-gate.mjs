// === The commit gate: the fast half of CI's check job, before every commit ===
//
// `.claude/settings.json` registers this as a Claude Code PreToolUse hook on Bash. It reads the
// tool call on stdin and does nothing unless the call is a `git commit`. Then it runs the checks
// below, a few seconds together, and blocks the commit (exit 2, the report goes to the agent)
// while one fails. A convention that only CI enforces costs a CI round trip to learn: an em dash
// in a new Markdown file did exactly that once. The slow half of the check job (the build, the
// type check, the tests) stays in `npm run check`, which is run before pushing.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** npm scripts from CI's check job that finish in seconds and need no build. */
const CHECKS = ['format:check', 'lint', 'check:prose'];

let command = '';
try {
  command = JSON.parse(readFileSync(0, 'utf8')).tool_input?.command ?? '';
} catch {
  process.exit(0);
}
if (!/(^|[;&|\s])git\s+(?:-C\s+\S+\s+)?commit\b/.test(command)) process.exit(0);

const failed = [];
for (const check of CHECKS) {
  // npm is `npm.cmd` on Windows, which only a shell resolves.
  const run = spawnSync('npm', ['run', '-s', check], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  // A check that could not start is not this gate's to report; CI still runs it.
  if (!run.error && run.status !== 0) {
    failed.push(`npm run ${check}\n${`${run.stdout}${run.stderr}`.trim()}`);
  }
}

if (failed.length > 0) {
  process.stderr.write(
    `${failed.join('\n\n')}\n\nCI's check job runs the same checks. Fix each one, then commit again.\n`,
  );
  process.exit(2);
}
