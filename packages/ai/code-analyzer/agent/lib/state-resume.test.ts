// T25: resuming a --local run saved by the pre-rename skill. agent/lib/local.ts:104 keeps
// stop.status a strict enum of the old words ('clean' | 'partial' | 'nothing-detected' |
// 'failed'); 'partial' is one of them, so a pre-upgrade state.json parses today exactly as this
// test expects. What is missing is the read-side mapping onto the five shared statuses (F7):
// exporting that resumed run still reports the old word 'partial' instead of 'incomplete'. This
// test fails on the second expectation until that mapping (readRunStatus or equivalent) lands.
//
// Real git and a real prior run's own state.json (agent/lib/local.ts:191-194 parses a saved
// state.json on resume): the fixture is produced by a first call of runLocal itself, then edited
// to look like a run a previous skill version left mid-build, never a mocked module.

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { runLocal, workDirFor, type LocalDeps, type LocalDone, type LocalResult } from './local.ts'

const exec = promisify(execFile)

const REQUIRED_MD = '<!-- Required reading -->\n\n---\n\n# Agent Instructions\n\nAGT-001 Read the rules.\n\n---\n\n# Review Verification\n\nREV-001 Verify.\n'
async function seedKnowledge(dir: string) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'REQUIRED.md'), REQUIRED_MD)
  await writeFile(join(dir, 'INDEX.md'), '# Engineering\n\n- [TypeScript](typescript.md)\n')
  await writeFile(join(dir, 'typescript.md'), '# TypeScript\n\nTS-002 No any.\n')
}

/** A repository with a lint script, so the first call leaves a real, resumable state.json behind. */
async function repo() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'sa-resume-')))
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'resume', scripts: { lint: 'node lint.js' } }))
  await writeFile(
    join(dir, 'lint.js'),
    "const fs = require('node:fs'); let bad = false\nif (fs.readFileSync('src/a.js', 'utf8').includes('var ')) { bad = true; console.log('src/a.js(1,1): error TS9000: no var') }\nprocess.exit(bad ? 1 : 0)\n",
  )
  await writeFile(join(dir, 'src', 'a.js'), 'var x = 1\nmodule.exports = x\n')
  await exec('git', ['init', '-q', dir])
  await exec('git', ['-C', dir, 'add', '-A'])
  await exec('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'])
  const knowledge = join(dir, '.static-analysis', '.local', 'knowledge')
  await seedKnowledge(knowledge)
  return { dir }
}

const pending = (result: LocalResult) => {
  if (!result.pending) throw new Error(`expected a pending stage, got ${result.status}: ${result.reason}`)
  return result
}
const finished = (result: LocalResult): LocalDone => {
  if (result.pending) throw new Error('expected a finished run')
  return result
}
const deps = (): LocalDeps => ({ env: {} })

describe('runLocal, resuming a saved state', () => {
  it('a pre-upgrade state.json with stop.status "partial" parses and exports status incomplete, not the old word', async () => {
    const { dir } = await repo()
    // A real first call: it leaves a pending fix stage and a real state.json behind.
    pending(await runLocal({ source: dir }, deps()))
    const stateFile = join(workDirFor(join(dir, '.static-analysis')), 'state.json')

    // What a run saved by the skill version before this ticket looks like once it had stopped:
    // no pending fix stage, and the stop recorded in the old vocabulary ('partial').
    const saved = JSON.parse(await readFile(stateFile, 'utf8')) as { pending: unknown; stop: unknown }
    saved.pending = null
    saved.stop = { status: 'partial', reason: 'round cap (6) reached' }
    await writeFile(stateFile, JSON.stringify(saved, null, 2))

    // The saved shape still parses today (stateSchema's stop.status enum already includes
    // 'partial'): resuming must not throw.
    const result = await runLocal({ source: dir }, deps())
    const done = finished(result)
    // Not yet true: today's export carries the state's own word through unchanged ('partial').
    expect(done.status).toBe('incomplete')
  })
})
