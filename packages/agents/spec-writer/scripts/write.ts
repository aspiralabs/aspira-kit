import { runWrite } from '../agent/lib/runner.ts'

const [ideaPath, repoPath, guidelinesPath, outputDir] = process.argv.slice(2)
if (!ideaPath || !repoPath || !guidelinesPath) {
  console.error('Usage: pnpm write <absolute-idea> <absolute-repo> <absolute-guidelines-snapshot> [output-directory]')
  process.exitCode = 2
} else {
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort(new Error('Cancelled by user')))
  const result = await runWrite({ ideaPath, repoPath, guidelinesPath, outputDir }, { signal: controller.signal, progress: (phase) => console.error(`${new Date().toISOString()} ${phase}`) })
  console.log(JSON.stringify(result, null, 2))
  if (result.status !== 'ready') process.exitCode = 1
}
