import { runReview } from '../agent/lib/runner.ts'

const [specPath, repoPath, guidelinesPath, outputDir] = process.argv.slice(2)
if (!specPath || !repoPath || !guidelinesPath) {
  console.error('Usage: pnpm review <absolute-spec> <absolute-repo> <absolute-guidelines-snapshot> [output-directory]')
  process.exitCode = 2
} else {
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort(new Error('Cancelled by user')))
  const result = await runReview({ specPath, repoPath, guidelinesPath, outputDir }, { signal: controller.signal, progress: (phase) => console.error(`${new Date().toISOString()} ${phase}`) })
  console.log(JSON.stringify(result, null, 2))
  if (result.status !== 'ready') process.exitCode = 1
}
