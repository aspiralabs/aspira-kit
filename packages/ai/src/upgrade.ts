// `kit upgrade`: moves a repository an earlier kit set up to the global harness, and does nothing else. It writes the
// global harness (~/.claude) when it is not current, restores an aspira.json a pull of the untracking commit deleted,
// removes the harness an earlier kit committed (the removal `kit init` runs too) and stops tracking aspira.json. It never
// touches the stack wiring `kit init` owns (installs, .npmrc, eslint, prettier, tsconfig, css, .mcp.json) and commits
// nothing: it prints the one commit to make.
import { restoreAspira, untrackAspira } from './aspira.js'
import type { Log } from './fs.js'
import { harnessCurrent, writeGlobalHarness, type HarnessOptions } from './skills.js'
import { recordCommands, removeLeftovers } from './stacks/next.js'

export type UpgradeOptions = {
  /** The project root, where the earlier kit's harness and aspira.json are. */
  projectRoot: string
  /** `--dry-run`: list every change, make none (in the repository or in ~/.claude). */
  dryRun: boolean
  log: Log
} & Pick<HarnessOptions, 'home' | 'env'>

/** Run the migration; exit 0 whether there was something to do or not (an error throws). */
export function upgrade(opts: UpgradeOptions): number {
  const { projectRoot, dryRun, log } = opts
  const stale = harnessCurrent({ home: opts.home, env: opts.env })
  if (stale.length === 0) log('keep   the global harness (~/.claude) is current')
  else if (dryRun) for (const reason of stale) log(`update ${reason} (the global harness)`)
  else writeGlobalHarness({ home: opts.home, env: opts.env, log })
  const restored = restoreAspira(projectRoot, dryRun, log)
  const removed = removeLeftovers(projectRoot, dryRun, log)
  const untracked = untrackAspira(projectRoot, dryRun, log)
  if (removed.length === 0 && !untracked) {
    log(`done   ${projectRoot} is already on the global harness${restored ? ' (aspira.json is git-ignored, so its restore has nothing to commit)' : ''}`)
    return 0
  }
  if (dryRun) {
    log('note   dry run: nothing changed; run kit upgrade to make these changes')
    return 0
  }
  log(`next   record the move (kit upgrade commits nothing${untracked ? '; the commit takes everything staged, so check git status first' : ''}):`)
  log(`       ${recordCommands(projectRoot, removed, untracked).join(' && ')}`)
  return 0
}
