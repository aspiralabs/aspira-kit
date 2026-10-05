import { parseArgs } from 'node:util'
import { runLocal } from '../agent/lib/local.ts'

// One step of a --local review. Prints the next stage's tasks (prompt and output file per task)
// or, once every stage is done, the exported review. --finish exports what exists as incomplete.
const usage = 'Usage: pnpm review:local <github-pr | absolute-repo-path> [--branch B] [--base main] [--max-rounds N] [--output DIR] [--no-comment] [--finish]'

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      branch: { type: 'string' },
      base: { type: 'string' },
      'max-rounds': { type: 'string' },
      output: { type: 'string' },
      'no-comment': { type: 'boolean' },
      finish: { type: 'boolean' },
    },
  })
  const [source, ...extra] = positionals
  if (source === undefined || extra.length > 0) throw new Error(usage)
  const rounds = values['max-rounds']
  const result = await runLocal({
    source,
    ...(values.branch === undefined ? {} : { branch: values.branch }),
    ...(values.base === undefined ? {} : { base: values.base }),
    ...(rounds === undefined ? {} : { maxRounds: Number(rounds) }),
    ...(values.output === undefined ? {} : { output: values.output }),
    noComment: values['no-comment'] === true,
    finish: values.finish === true,
  })
  console.log(JSON.stringify(result, null, 2))
  if (!result.pending && result.status !== 'complete') process.exitCode = 1
} catch (error) {
  console.error(`pr-reviewer local: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
}
