import { parseArgs } from 'node:util'
import { agentVersion, recordAgentVersion } from '@aspiralabs/agent-common/lib/agent-version'
import { KnowledgeRequired, runLocal } from '../agent/lib/local.ts'

// One step of a --local run. Prints the knowledge stage until the guidelines are in place, then
// each fix stage's tasks (prompt and output file per batch), then the exported run.
// Every step names the agent package that ran (`agent`), and an export records it in its trace.
const usage = 'Usage: pnpm run local <absolute-repo-path> [--knowledge DIR | --guidelines FILE] [--max-rounds N] [--fix-warnings] [--no-fix] [--output DIR] [--finish]'

const agent = await agentVersion(new URL('..', import.meta.url))
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      knowledge: { type: 'string' },
      guidelines: { type: 'string' },
      output: { type: 'string' },
      'max-rounds': { type: 'string' },
      'fix-warnings': { type: 'boolean' },
      'no-fix': { type: 'boolean' },
      finish: { type: 'boolean' },
    },
  })
  const [source, ...extra] = positionals
  if (source === undefined || extra.length > 0) throw new Error(usage)
  const rounds = values['max-rounds']
  const progress = (message: string) => console.error(`${new Date().toISOString()} ${message}`)
  const result = await runLocal(
    {
      source,
      ...(values.knowledge === undefined ? {} : { knowledge: values.knowledge }),
      ...(values.guidelines === undefined ? {} : { guidelines: values.guidelines }),
      ...(values.output === undefined ? {} : { output: values.output }),
      ...(rounds === undefined ? {} : { maxRounds: Number(rounds) }),
      ...(values['fix-warnings'] === true ? { fixWarnings: true } : {}),
      noFix: values['no-fix'] === true,
      finish: values.finish === true,
    },
    { progress },
  )
  if (!result.pending) await recordAgentVersion(result.dir, agent)
  console.log(JSON.stringify({ ...result, agent }, null, 2))
  if (!result.pending && result.status !== 'clean') process.exitCode = 1
} catch (error) {
  if (error instanceof KnowledgeRequired) {
    // Not a failure: the stage the session runs before the first step.
    console.log(JSON.stringify({ pending: true, refused: error.message, ...error.plan, agent }, null, 2))
  } else {
    console.error(`code-analyzer local: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }
}
