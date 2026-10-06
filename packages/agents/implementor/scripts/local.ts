import { parseArgs } from 'node:util'
import { agentVersion, recordAgentVersion } from '@aspiralabs/agent-common/lib/agent-version'
import { runLocal } from '../agent/lib/local.ts'

// One step of a --local build. Prints the knowledge stage, the next stage's tasks (a prompt and an
// output file per task), or the finished run. --finish exports what exists as incomplete.
// Every step names the agent package that ran (`agent`), and an export records it in its trace.
const usage = 'Usage: pnpm run implement:local <plan.review | plan.reviewed.md | spec.md> [--repo DIR] [--guidelines FILE] [--max-parallel N] [--serial] [--work DIR] [--finish]'

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      guidelines: { type: 'string' },
      'max-parallel': { type: 'string' },
      serial: { type: 'boolean' },
      work: { type: 'string' },
      finish: { type: 'boolean' },
    },
  })
  const [source, ...extra] = positionals
  if (source === undefined || extra.length > 0) throw new Error(usage)
  const parallel = values['max-parallel']
  const agent = await agentVersion(new URL('..', import.meta.url))
  const result = await runLocal({
    source,
    ...(values.repo === undefined ? {} : { repo: values.repo }),
    ...(values.guidelines === undefined ? {} : { guidelines: values.guidelines }),
    ...(parallel === undefined ? {} : { maxParallel: Number(parallel) }),
    ...(values.work === undefined ? {} : { work: values.work }),
    serial: values.serial === true,
    finish: values.finish === true,
  })
  if (!result.pending && result.export !== null) await recordAgentVersion(result.export, agent)
  console.log(JSON.stringify({ ...result, agent }, null, 2))
  if (!result.pending && result.status !== 'complete') process.exitCode = 1
} catch (error) {
  console.error(`implementor local: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
}
