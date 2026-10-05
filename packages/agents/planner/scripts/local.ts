import { parseArgs } from 'node:util'
import { runLocal } from '../agent/lib/local.ts'

// One step of a --local plan. Prints the knowledge stage, the next phase's task (prompt and output
// file), or, once both phases are done, the exported plan. --finish exports what exists as incomplete.
const usage = 'Usage: pnpm run plan:local <absolute-spec> <absolute-repo> [--output DIR] [--guidelines REQUIRED.md] [--finish]'

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { output: { type: 'string' }, guidelines: { type: 'string' }, finish: { type: 'boolean' } },
  })
  const [specPath, repoPath, ...extra] = positionals
  if (specPath === undefined || repoPath === undefined || extra.length > 0) throw new Error(usage)
  const result = await runLocal({
    specPath,
    repoPath,
    ...(values.output === undefined ? {} : { outputDir: values.output }),
    ...(values.guidelines === undefined ? {} : { guidelinesPath: values.guidelines }),
    finish: values.finish === true,
  })
  console.log(JSON.stringify(result, null, 2))
  if (!result.pending && result.status !== 'ready') process.exitCode = 1
} catch (error) {
  console.error(`planner local: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
}
