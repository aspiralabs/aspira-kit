import { runLocal } from '../agent/lib/local.ts'

// One step of a --local run. Prints the pending phases (prompt and output file per phase) or, once
// every phase output is present, the finished report. --finish exports what exists as incomplete.
const args = process.argv.slice(2)
const finish = args.includes('--finish')
const [ideaPath, repoPath, guidelinesPath, outputDir] = args.filter((arg) => arg !== '--finish')
if (!ideaPath || !repoPath || !guidelinesPath) {
  console.error('Usage: pnpm write:local <absolute-idea> <absolute-repo> <absolute-guidelines-snapshot> [output-directory] [--finish]')
  process.exitCode = 2
} else {
  const result = await runLocal({ ideaPath, repoPath, guidelinesPath, outputDir, finish })
  console.log(JSON.stringify(result, null, 2))
  if (!result.pending && result.status !== 'ready') process.exitCode = 1
}
