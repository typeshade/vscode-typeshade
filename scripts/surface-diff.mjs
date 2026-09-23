// Writes, as Markdown, what a compiler bump changes in the compiler's public surface.
//
//   node scripts/surface-diff.mjs <old-sha> <new-sha>
//
// `docs/design.md` §2 has every bump of `vendor/typeshade` quote the diff of the compiler's
// `src/__api__/surface.md` between the two SHAs: that file lists every public export per
// `exports` subpath, then one line of shape per definition, so its diff is exactly what changed
// for this repository. `.github/workflows/pin-compiler.yml` puts this output in the body of the
// bump's pull request. A diff of up to 200 lines is quoted whole. A longer one would bury the
// few lines a reviewer needs (and can pass the size a pull request body allows), so it is
// summarised instead: the export count per subpath, every export added or removed, and every
// definition whose shape was added, removed or changed. The full diff is one command away, and
// the output opens with that command.

import { execFileSync } from 'node:child_process'

const SUBMODULE = 'vendor/typeshade'
const SURFACE = 'src/__api__/surface.md'
const MAX_QUOTED_LINES = 200
/** Names listed per group before the rest is counted, to keep the body well under its limit. */
const MAX_NAMES = 300

const [oldSha, newSha] = process.argv.slice(2)
if (!oldSha || !newSha) {
  console.error('usage: node scripts/surface-diff.mjs <old-sha> <new-sha>')
  process.exit(2)
}

const git = (...args) =>
  execFileSync('git', ['-C', SUBMODULE, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 })

const short = (sha) => git('rev-parse', '--short=7', sha).trim()
const command = `git -C ${SUBMODULE} diff ${short(oldSha)} ${short(newSha)} -- ${SURFACE}`
const diff = git('diff', oldSha, newSha, '--', SURFACE)
const diffLines = diff === '' ? 0 : diff.trimEnd().split('\n').length

if (diffLines === 0) {
  console.log(`\`${SURFACE}\` is unchanged between the two SHAs: the public surface did not move.`)
  process.exit(0)
}

if (diffLines <= MAX_QUOTED_LINES) {
  console.log(`\`${command}\`, ${diffLines} lines:`)
  console.log()
  // Four backticks, because the file itself fences its lists with three.
  console.log('````diff')
  console.log(diff.trimEnd())
  console.log('````')
  process.exit(0)
}

/** Splits one version of the file into its sections: heading (without the count) to lines. */
function sections(sha) {
  const result = new Map()
  let heading = null
  let fenced = false
  for (const line of git('show', `${sha}:${SURFACE}`).split('\n')) {
    if (line.startsWith('## ')) {
      // "## `.` <dash> 459 exports": the name is everything before the count.
      heading = line.slice(3).replace(/\s+\S+\s+\d+\s+\w+$/, '')
      result.set(heading, [])
      fenced = false
    } else if (line.startsWith('```')) {
      fenced = !fenced
    } else if (heading !== null && fenced && line.trim() !== '') {
      result.get(heading).push(line)
    }
  }
  return result
}

/** An export line is its own key; a shape line is keyed by the definition it describes. */
const keyOf = (line) => line.split('  ')[0]

function list(label, names) {
  if (names.length === 0) return
  const shown = names.slice(0, MAX_NAMES).map((n) => `\`${n}\``)
  const rest = names.length - shown.length
  console.log(
    `- ${label} (${names.length}): ${shown.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}`,
  )
}

const before = sections(oldSha)
const after = sections(newSha)
const headings = [...new Set([...before.keys(), ...after.keys()])]

console.log(
  `\`${command}\` is ${diffLines} lines, over the ${MAX_QUOTED_LINES} this body quotes whole, so here is what it adds and removes. Run the command for the full diff.`,
)
console.log()
console.log('| Section | Before | After | Added | Removed | Changed |')
console.log('| --- | ---: | ---: | ---: | ---: | ---: |')

const details = []
for (const heading of headings) {
  const old = new Map((before.get(heading) ?? []).map((l) => [keyOf(l), l]))
  const neu = new Map((after.get(heading) ?? []).map((l) => [keyOf(l), l]))
  const added = [...neu.keys()].filter((k) => !old.has(k))
  const removed = [...old.keys()].filter((k) => !neu.has(k))
  const changed = [...neu.keys()].filter((k) => old.has(k) && old.get(k) !== neu.get(k))
  const count = (m, present) => (present ? String(m.size) : 'none')
  console.log(
    `| ${heading} | ${count(old, before.has(heading))} | ${count(neu, after.has(heading))} | ${added.length} | ${removed.length} | ${changed.length} |`,
  )
  if (added.length + removed.length + changed.length > 0) {
    details.push({ heading, added, removed, changed })
  }
}

for (const { heading, added, removed, changed } of details) {
  console.log()
  console.log(`### ${heading}`)
  console.log()
  list('Removed', removed)
  list('Added', added)
  list('Shape changed', changed)
}
