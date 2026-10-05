import { runStaticAnalysis } from '../agent/lib/runner.ts'

const args = process.argv.slice(2)
const flags: Record<string, string | boolean> = {}
const positional: string[] = []
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!
  if (arg.startsWith('--')) {
    const name = arg.slice(2)
    const next = args[i + 1]
    if (name === 'push' || name === 'fix-warnings') flags[name] = true
    else if (next !== undefined && !next.startsWith('--')) { flags[name] = next; i++ }
    else { console.error(`--${name} needs a value`); process.exit(2) }
  } else positional.push(arg)
}
const [source] = positional
if (!source || positional.length > 1) {
  console.error('Usage: pnpm analyze <absolute-repo-path> [--knowledge DIR | --guidelines FILE] [--output DIR] [--max-rounds N] [--max-cost USD] [--fix-warnings]\nRemote repositories need the eve entry point: pnpm exec eve invoke "Run static analysis on owner/name"')
  process.exit(2)
}
const controller = new AbortController()
process.once('SIGINT', () => controller.abort(new Error('Cancelled by user')))
const text = (name: string) => (typeof flags[name] === 'string' ? flags[name] : undefined)
try {
  const knowledge = text('knowledge')
  const guidelines = text('guidelines')
  const result = await runStaticAnalysis(
    { source, outputDir: text('output'), maxRounds: flags['max-rounds'] ? Number(flags['max-rounds']) : undefined, maxCostUsd: flags['max-cost'] ? Number(flags['max-cost']) : undefined, fixWarnings: flags['fix-warnings'] === true, ...(knowledge ? { knowledge } : {}), ...(guidelines ? { guidelines } : {}) },
    { signal: controller.signal, progress: (message) => console.error(`${new Date().toISOString()} ${message}`) },
  )
  console.log(JSON.stringify(result, null, 2))
  if (result.status !== 'clean') process.exitCode = 1
} catch (error) {
  // A run without the engineering guidelines (or any other setup failure) never starts.
  console.error(`code-analyzer: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
}
