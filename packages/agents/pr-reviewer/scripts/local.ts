import { parseArgs } from 'node:util'
import { agentVersion, recordAgentVersion } from '@aspiralabs/agent-common/lib/agent-version'
import { KnowledgeRequired, runLocal } from '../agent/lib/local.ts'

// One step of a --local review. Prints the next stage's tasks (prompt and output file per task)
// or, once every stage is done, the exported review. --finish exports what exists as incomplete.
// Without the engineering guidelines folder it refuses (exit 3) and prints the pages to fetch.
// Every step names the agent package that ran (`agent`), and an export records it in its trace.
const usage = 'Usage: pnpm review:local <github-pr | absolute-repo-path> [--branch B] [--base main] [--max-rounds N] [--output DIR] [--knowledge DIR] [--no-comment] [--finish]'

const agent = await agentVersion(new URL('..', import.meta.url))
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      branch: { type: 'string' },
      base: { type: 'string' },
      'max-rounds': { type: 'string' },
      output: { type: 'string' },
      knowledge: { type: 'string' },
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
    ...(values.knowledge === undefined ? {} : { knowledge: values.knowledge }),
    noComment: values['no-comment'] === true,
    finish: values.finish === true,
  })
  if (!result.pending) await recordAgentVersion(result.dir, agent)
  console.log(JSON.stringify({ ...result, agent }, null, 2))
  if (!result.pending && result.status !== 'complete') process.exitCode = 1
} catch (error) {
  if (error instanceof KnowledgeRequired) {
    console.log(JSON.stringify({ pending: false, status: 'refused', stage: 'knowledge', reason: error.message, knowledge: error.plan, agent }, null, 2))
    console.error(`pr-reviewer local: ${error.message}`)
    process.exitCode = 3
  } else {
    console.error(`pr-reviewer local: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }
}
