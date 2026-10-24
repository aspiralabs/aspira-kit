import { exitCodeFor } from '@aspiralabs/ai/common/lib/run-status'
import { runGroom } from '../agent/lib/runner.ts'

const [folder, repoPath, guidelinesPath] = process.argv.slice(2)
if (!folder || !repoPath || !guidelinesPath) {
  console.error('Usage: pnpm groom <absolute-working-folder> <absolute-repo> <absolute-guidelines-snapshot>')
  process.exitCode = 2
} else {
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort(new Error('Cancelled by user')))
  const result = await runGroom({ folder, repoPath, guidelinesPath }, { signal: controller.signal, progress: (phase) => console.error(`${new Date().toISOString()} ${phase}`) })
  console.log(JSON.stringify(result, null, 2))
  // Exit by run status (run-status.ts's exitCodeFor): 0 ready, 1 incomplete or blocked, 3 refused, 5 needs-author (Decision Q4).
  process.exitCode = exitCodeFor(result.status)
}
