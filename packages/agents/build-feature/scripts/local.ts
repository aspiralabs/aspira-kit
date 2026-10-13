// The build-feature driver, as `build-feature.sh local` runs it:
//   local.ts <ID> [--local] [--repo <dir>] [--run <runId>] [--force-run] [--finish]
// With --local every step runs its skill with --local in this session; without it every step runs
// its skill's default mode (the step's cloud agent, started and waited on). F2, Q10 revised.
// Prints exactly one stage as JSON on stdout and exits 0; a refusal prints its message on stderr
// and exits 1. Time comes from BUILD_FEATURE_NOW when set (tests), else the clock.

import { parseArgs } from 'node:util'
import { nextStage, Refusal } from '#src/driver.ts'

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      local: { type: 'boolean', default: false },
      repo: { type: 'string' },
      run: { type: 'string' },
      'force-run': { type: 'boolean', default: false },
      finish: { type: 'boolean', default: false },
    },
  })
  const [id] = positionals
  if (id === undefined || !/^[A-Za-z]+-\d+$/.test(id)) throw new Refusal('Usage: local.ts <ID> [--local] [--run <runId>] [--force-run] [--finish]; <ID> is the Feature Board ticket ID, for example KIT-11.')
  const now = process.env.BUILD_FEATURE_NOW !== undefined && process.env.BUILD_FEATURE_NOW !== '' ? process.env.BUILD_FEATURE_NOW : new Date().toISOString()
  const stage = await nextStage({
    id: id.toUpperCase(),
    repo: values.repo ?? process.cwd(),
    ...(values.run === undefined ? {} : { run: values.run }),
    forceRun: values['force-run'],
    finish: values.finish,
    mode: values.local ? 'local' : 'cloud',
    now,
    env: process.env,
  })
  process.stdout.write(`${JSON.stringify(stage, null, 2)}\n`)
  return 0
}

try {
  process.exitCode = await main()
} catch (error) {
  process.stderr.write(`build-feature: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
