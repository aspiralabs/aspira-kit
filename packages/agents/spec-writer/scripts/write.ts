import { exitCodeFor, readRunStatus } from '@aspiralabs/agent-common/lib/run-status'
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
  // Exit by run status (run-status.ts's exitCodeFor): 0 ready, 1 incomplete or blocked, 3 refused, 5 needs-author (Decision Q4).
  process.exitCode = exitCodeFor(readRunStatus(result.status)?.status ?? 'incomplete')
}
