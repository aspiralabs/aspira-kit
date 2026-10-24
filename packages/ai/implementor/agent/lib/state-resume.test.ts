// T26: resuming an implementor run saved by the skill version before this ticket. The state
// schema (agent/lib/local.ts:126-146) requires planAccepted to be a string or null; a run from
// before that field held a plan sha, a plain boolean `planAccepted: true`, fails that schema
// today. runLocal's own `stateSchema.parse(JSON.parse(text))` (agent/lib/local.ts ~390) runs
// inside the fulfilled branch of a `.then(onFulfilled, onRejected)`, so a parse error there is not
// caught by onRejected: it propagates out of runLocal as an uncaught ZodError instead of being
// read as "no saved state" or mapped onto today's shape. This test fails on exactly that today:
// the call below throws, instead of resuming into the run's next stage.
//
// The wave-1 result's own status, 'partial', is a WAVE_RESULT word (agent/lib/local-plan.ts:77-83
// keeps committed | partial | blocked) and is explicitly exempt from the run-status rename this
// ticket makes elsewhere; it is part of the fixture precisely because it must keep parsing
// unchanged.
//
// Real git, a real plan.review directory and the package's own procedure/instructions files:
// never a module the project owns is mocked.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { knowledgeFingerprint } from './local-knowledge.ts'
import { INSTRUCTIONS_FILE, PROCEDURE_FILE, RUN_DIR, runLocal, type LocalDeps } from './local.ts'

const exec = promisify(execFile)
const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '../..')
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'implementor-resume-')))
  const pkg = join(dir, 'pkg')
  await mkdir(join(pkg, 'agent/skills/aspira-implementor'), { recursive: true })
  await cp(join(PACKAGE, PROCEDURE_FILE), join(pkg, PROCEDURE_FILE))
  await cp(join(PACKAGE, INSTRUCTIONS_FILE), join(pkg, INSTRUCTIONS_FILE))

  const repo = join(dir, 'repo')
  await exec('git', ['init', '-q', '-b', 'feat/x', repo])
  const git = (...args: string[]) => exec('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])
  await writeFile(join(repo, 'AGENTS.md'), '# Project\n')
  await git('add', '.')
  await git('commit', '-qm', 'init')
  const head = (await git('rev-parse', 'HEAD')).stdout.trim()

  const review = join(repo, 'specs', 'x', 'plan.review')
  await mkdir(join(review, 'trace'), { recursive: true })
  const plan = { tasks: [{ id: 'T1', kind: 'tests', featureIds: ['F1'], dependsOn: [], testIds: [], changes: [], commands: [] }], tests: [], decisions: [], gaps: [] }
  const reviewRecord = { status: 'ready', problems: [], decisions: [] }
  const planText = JSON.stringify(plan)
  const reviewText = JSON.stringify(reviewRecord)
  await writeFile(join(review, 'trace/plan.json'), planText)
  await writeFile(join(review, 'trace/review.json'), reviewText)

  const runDir = join(review, RUN_DIR)
  const knowledge = join(runDir, 'knowledge')
  await mkdir(knowledge, { recursive: true })
  const requiredText = '# Agent Instructions\n\nAGT-001 Read the rules.\n\n---\n\n# Review Verification\n\nREV-001 Verify.\n'
  await writeFile(join(knowledge, 'REQUIRED.md'), requiredText)
  const knowledgeFp = await knowledgeFingerprint(knowledge)

  await mkdir(join(runDir, 'outputs'), { recursive: true })
  const parallelization = { waves: [{ lanes: [{ id: 'V', tasks: ['T1'], worker: false, writeScope: [], rules: [], ui: '' }] }], inferredEdges: [], notes: '' }
  await writeFile(join(runDir, 'outputs', 'parallelize.json'), JSON.stringify(parallelization))
  const waveResult = { status: 'partial', commit: null, tasks: [{ id: 'T1', status: 'blocked' }], notes: 'left incomplete before the rename landed' }
  await writeFile(join(runDir, 'outputs', 'wave-1.json'), JSON.stringify(waveResult))

  // A run saved by the skill version before this ticket: gate already set (unaffected by the
  // rename; 'ready' is already one of the five shared words), but planAccepted is still the old
  // boolean flag, not the sha256 string the current schema requires.
  const state = {
    source: review,
    sourceFingerprint: sha256(JSON.stringify([planText, reviewText])),
    maxParallel: 4,
    serial: false,
    startedAt: new Date().toISOString(),
    startCommit: head,
    knowledge: { source: 'guidelines', fingerprint: knowledgeFp, fetchedAt: null, pages: [{ role: 'snapshot', title: 'REQUIRED.md', url: null, file: 'REQUIRED.md', sha256: sha256(requiredText) }], config: null },
    gate: { status: 'ready', repoCommit: null, head, decisions: [] },
    planAccepted: true,
    rejections: {},
  }
  await writeFile(join(runDir, 'state.json'), JSON.stringify(state, null, 2))

  return { pkg, review }
}

describe('runLocal, resuming a saved state', () => {
  it('a pre-upgrade state.json (a legacy planAccepted flag) and a partial wave-1 result resume at the next stage instead of failing', async () => {
    const { pkg, review } = await fixture()
    const deps: LocalDeps = { packageDir: pkg }

    // Not yet true: stateSchema.parse rejects planAccepted: true today (it wants a string or
    // null), and that rejection is not caught, so this call throws instead of resuming.
    const result = await runLocal({ source: review }, deps)

    expect(result.pending).toBe(true)
    if (result.pending) expect(result.stage).toBe('verification')
  })
})
