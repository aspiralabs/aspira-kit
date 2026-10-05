import { parseArgs } from 'node:util'
import { KnowledgeRequired, knowledgeStage, runLocal } from '../agent/lib/local.ts'

// One step of a --local run. Prints the knowledge stage (the Notion pages to fetch) until the
// guidelines are there, then the pending phases (prompt and output file per phase) or, once every
// phase output is present, the finished report. --finish exports what exists as incomplete.
const usage = 'Usage: pnpm run write:local <absolute-idea> <absolute-repo> [--guidelines FILE] [--output DIR] [--finish]'

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { guidelines: { type: 'string' }, output: { type: 'string' }, finish: { type: 'boolean' } },
  })
  const [ideaPath, repoPath, ...extra] = positionals
  if (ideaPath === undefined || repoPath === undefined || extra.length > 0) throw new Error(usage)
  const result = await runLocal({
    ideaPath,
    repoPath,
    ...(values.guidelines === undefined ? {} : { guidelinesPath: values.guidelines }),
    ...(values.output === undefined ? {} : { outputDir: values.output }),
    finish: values.finish === true,
  })
  console.log(JSON.stringify(result, null, 2))
  if (!result.pending && result.status !== 'ready') process.exitCode = 1
} catch (error) {
  if (error instanceof KnowledgeRequired) console.log(JSON.stringify(knowledgeStage(error), null, 2))
  else {
    console.error(`spec-writer local: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }
}
