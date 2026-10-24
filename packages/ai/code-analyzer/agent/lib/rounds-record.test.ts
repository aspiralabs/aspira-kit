// T24: the five-status rename and the ticket/head record this ticket adds to code-analyzer's
// --local export. Today loop.ts's Status is 'clean' | 'partial' | 'nothing-detected' | 'failed'
// (agent/lib/loop.ts:8-9), nothing-detected and every-analyzer-failed stop with those words
// (agent/lib/local.ts:259-266), and rounds.json carries no ticket or head (agent/lib/local.ts:
// 526-533). These tests fail until that lands: 'ready'/'incomplete' are not among local.ts's
// exported statuses, the report never says "no static analysis ran", and rounds.json has no
// ticket or head field at all.
//
// Real git repositories and a real failing lint script, the seam agent/lib/local.test.ts already
// tests at (runLocal end to end): never a module the project owns is mocked.

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { runLocal, type LocalDeps, type LocalDone, type LocalResult } from './local.ts'

const exec = promisify(execFile)

// The folder the session builds from Notion before the first step, in load-knowledge's shape.
const REQUIRED_MD = '<!-- Required reading -->\n\n---\n\n# Agent Instructions\n\nAGT-001 Read the rules.\n\n---\n\n# Review Verification\n\nREV-001 Verify.\n'
async function seedKnowledge(dir: string) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'REQUIRED.md'), REQUIRED_MD)
  await writeFile(join(dir, 'INDEX.md'), '# Engineering\n\n- [TypeScript](typescript.md)\n')
  await writeFile(join(dir, 'typescript.md'), '# TypeScript\n\nTS-002 No any.\n')
}

const git = async (dir: string, ...args: string[]) => (await exec('git', ['-C', dir, ...args])).stdout.trim()

/** No package.json, no pyproject.toml, no go.mod: detect() finds no analyzer at all. */
async function repoWithNoAnalyzers() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'sa-rounds-none-')))
  await writeFile(join(dir, 'README.md'), '# Nothing to analyze\n')
  await exec('git', ['init', '-q', dir])
  await exec('git', ['-C', dir, 'add', '-A'])
  await exec('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'])
  const knowledge = join(dir, '.static-analysis', '.local', 'knowledge')
  await seedKnowledge(knowledge)
  return { dir }
}

/** A lint script that always fails without any parseable diagnostic: the one analyzer errors on every run. */
async function repoWhereEveryAnalyzerErrors() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'sa-rounds-failing-')))
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'failing', scripts: { lint: 'node lint.js' } }))
  await writeFile(join(dir, 'lint.js'), "console.error('lint crashed before producing any diagnostics')\nprocess.exit(1)\n")
  await writeFile(join(dir, 'src', 'a.js'), 'module.exports = 1\n')
  await exec('git', ['init', '-q', dir])
  await exec('git', ['-C', dir, 'add', '-A'])
  await exec('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'])
  const knowledge = join(dir, '.static-analysis', '.local', 'knowledge')
  await seedKnowledge(knowledge)
  return { dir }
}

const finished = (result: LocalResult): LocalDone => {
  if (result.pending) throw new Error(`expected a finished run, got stage ${result.stage}`)
  return result
}
const deps = (): LocalDeps => ({ env: {} })

// LocalInput has no `ticket` field yet: this ticket's implementation (not in this task's write
// scope) adds it to export rounds.json with the ticket a run was for. The cast documents that gap
// at this one boundary, named by TS-003, rather than hiding it behind a suppression.
const withTicket = (source: string, ticket: string) => ({ source, ticket }) as Parameters<typeof runLocal>[0]

describe('runLocal export, the run record', () => {
  it('nothing detected exports status ready with reasonCode no-analyzers, and the report says no static analysis ran', async () => {
    const { dir } = await repoWithNoAnalyzers()
    const result = finished(await runLocal(withTicket(dir, 'KIT-2'), deps()))
    expect(result.status).toBe('ready')
    const rounds = JSON.parse(await readFile(join(dir, '.static-analysis', 'rounds.json'), 'utf8')) as { reasonCode?: string }
    expect(rounds.reasonCode).toBe('no-analyzers')
    const report = await readFile(join(dir, '.static-analysis', 'report.md'), 'utf8')
    expect(report).toContain('no static analysis ran')
  })

  it('every analyzer erroring exports status incomplete', async () => {
    const { dir } = await repoWhereEveryAnalyzerErrors()
    const result = finished(await runLocal(withTicket(dir, 'KIT-2'), deps()))
    expect(result.status).toBe('incomplete')
  })

  it('records the ticket and the head rounds.json was exported at', async () => {
    const { dir } = await repoWithNoAnalyzers()
    const head = await git(dir, 'rev-parse', 'HEAD')
    finished(await runLocal(withTicket(dir, 'KIT-2'), deps()))
    const rounds = JSON.parse(await readFile(join(dir, '.static-analysis', 'rounds.json'), 'utf8')) as { ticket?: string; head?: string }
    expect(rounds.ticket).toBe('KIT-2')
    expect(rounds.head).toBe(head)
  })
})
