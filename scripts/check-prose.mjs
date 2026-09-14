// Fails on an em dash in any tracked text file.
//
// "No em dashes anywhere" is one of the conventions this repository inherits from the compiler
// (`AGENTS.md` there), and a convention nothing checks is a convention that drifts. The
// character is spelled by code point below so that this file can name the rule it enforces
// without breaking it.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const EM_DASH = String.fromCharCode(0x2014)

/** Files whose contents this repository does not author. */
const SKIP = new Set(['package-lock.json', 'LICENSE'])

/** Extensions worth reading as prose or source. */
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|jsonc|md|ya?ml|editorconfig|txt)$/

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter((f) => f !== '' && !SKIP.has(f) && TEXT.test(f))

const hits = []
for (const file of tracked) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    if (line.includes(EM_DASH)) hits.push(`${file}:${i + 1}: ${line.trim()}`)
  })
}

if (hits.length > 0) {
  console.error(`em dash in ${hits.length} place(s):`)
  for (const hit of hits) console.error(`  ${hit}`)
  process.exit(1)
}
console.log(`checked ${tracked.length} tracked files, no em dash`)
