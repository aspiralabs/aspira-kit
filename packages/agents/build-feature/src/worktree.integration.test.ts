// F50: one worktree per ticket (GIT-001, GIT-002), at seam S1 with real git. The run starts in the
// main checkout on main; before any step the driver makes (or reuses) `.worktrees/<TYPE>-<ID>` on
// `<prefix>/<id>-<slug>` from origin/main, excludes `.worktrees/` locally when `.gitignore` does not
// list it, runs the project's install and build there (pnpm is a fake on PATH), carries the
// ticket's `.work/` folder over, and prints a `worktree` stage telling the session to continue from
// inside it. The repository is a temp repo with a bare origin; nothing reaches the network.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { SLUG, branchFor, cleanup, kinds, ofKind, project, worktreeFor, type Project, type Result } from './driver.test-helper.ts'

const exec = promisify(execFile)
afterEach(cleanup)

const SLOW = 120_000
// The step command without its trailing --parent-run <run>:<nonce> (KIT-19), which these tests do not pin.
const commandOf = (result: Result) => (result.stage?.stage === 'step' ? String(result.stage.command).replace(/ --parent-run \S+$/, '') : `<${result.stage?.stage ?? 'no stage'}>`)
const gitIn = async (dir: string, ...args: string[]) => (await exec('git', ['-C', dir, ...args])).stdout.trim()
const SPEC = '# X\n\n## Acceptance criteria\n\n- [ ] F1: it works.\n'

/** A run started from the main checkout at Ready: Spec, with the ticket's spec in the main checkout's .work/. */
async function fromMain(options: Parameters<typeof project>[0]): Promise<{ h: Project; result: Result }> {
  const h = await project({ layout: 'checkout', ...options })
  await mkdir(h.folder, { recursive: true })
  await writeFile(join(h.folder, 'spec.md'), SPEC)
  const result = await h.advance({}, await h.start())
  return { h, result }
}

describe('F50: the run works the ticket in its own worktree', () => {
  it('creates .worktrees/FEATURE-KIT-11 on feat/kit-11-x from origin/main with the GIT-002 command, before any step', async () => {
    const { h, result } = await fromMain({ status: 'Ready: Spec' })
    const worktree = worktreeFor(h.main)
    const adds = (await h.gitCalls()).filter((args) => args[0] === 'worktree' && args[1] === 'add')
    expect({
      stage: result.stage?.stage,
      worktree: result.stage?.worktree,
      branch: result.stage?.branch,
      head: await gitIn(worktree, 'rev-parse', '--abbrev-ref', 'HEAD'),
      fromMain: (await gitIn(worktree, 'rev-parse', 'HEAD')) === h.base,
      adds,
      steps: ofKind(h.stages, 'step').length,
    }).toEqual({
      stage: 'worktree',
      worktree,
      branch: 'feat/kit-11-x',
      head: 'feat/kit-11-x',
      fromMain: true,
      adds: [['worktree', 'add', '-b', 'feat/kit-11-x', '.worktrees/FEATURE-KIT-11', 'origin/main']],
      steps: 0,
    })
  }, SLOW)

  it('names the worktree and branch by the card Type: BUG with fix/, CHORE with chore/', async () => {
    const outcomes = []
    for (const type of ['Bug', 'Chore']) {
      const { h, result } = await fromMain({ status: 'Ready: Spec', type })
      outcomes.push({ type, worktree: result.stage?.worktree === worktreeFor(h.main, type), head: await gitIn(worktreeFor(h.main, type), 'rev-parse', '--abbrev-ref', 'HEAD') })
    }
    expect(outcomes).toEqual([
      { type: 'Bug', worktree: true, head: branchFor('Bug') },
      { type: 'Chore', worktree: true, head: branchFor('Chore') },
    ])
  }, SLOW)

  it('adds .worktrees/ to .git/info/exclude when .gitignore does not list it, and leaves exclude alone when it does', async () => {
    const without = await fromMain({ status: 'Ready: Spec' })
    const listed = await fromMain({ status: 'Ready: Spec', mainFiles: { '.gitignore': 'node_modules/\n.worktrees/\n' } })
    const excluded = async (h: Project) => (await readFile(join(h.main, '.git/info/exclude'), 'utf8')).split('\n').includes('.worktrees/')
    expect({ without: await excluded(without.h), listed: await excluded(listed.h) }).toEqual({ without: true, listed: false })
  }, SLOW)

  it('runs pnpm install then pnpm build in the new worktree for a pnpm workspace with a build script, else only the install', async () => {
    const workspace = await fromMain({ status: 'Ready: Spec', mainFiles: { 'pnpm-workspace.yaml': 'packages: []\n', 'package.json': JSON.stringify({ name: 'fixture', scripts: { build: 'echo built' } }) } })
    const single = await fromMain({ status: 'Ready: Spec', mainFiles: { 'pnpm-lock.yaml': 'lockfileVersion: 9.0\n', 'package.json': JSON.stringify({ name: 'fixture' }) } })
    expect({ workspace: await workspace.h.pnpmCalls(), single: await single.h.pnpmCalls() }).toEqual({
      workspace: [`${worktreeFor(workspace.h.main)} install`, `${worktreeFor(workspace.h.main)} build`],
      single: [`${worktreeFor(single.h.main)} install`],
    })
  }, SLOW)

  it('continues from inside the worktree: the ticket folder is there and the next stage is the step', async () => {
    const { h, result } = await fromMain({ status: 'Ready: Spec' })
    const mainState = JSON.parse(await readFile(join(h.stateDir, 'state.json'), 'utf8')) as { inProgress: unknown; runs: { ended: string | null }[] }
    h.cd(String(result.stage?.worktree))
    await h.answer(result.stage, {})
    const step = await h.advance()
    expect({
      spec: existsSync(join(h.folder, 'spec.md')),
      folder: h.folder === join(worktreeFor(h.main), '.work', SLUG),
      command: commandOf(step),
      inProgress: ((await h.state()).inProgress as { runId?: string } | null)?.runId === step.stage?.runId,
      mainLock: mainState.inProgress,
      mainEnded: mainState.runs.at(-1)?.ended,
    }).toEqual({ spec: true, folder: true, command: '/aspira-planner KIT-11 --local --take-recommended', inProgress: true, mainLock: null, mainEnded: 'moved' })
  }, SLOW)

  it('reuses an existing worktree: from the main checkout it only says to continue there, and adds no worktree', async () => {
    const h = await project({ status: 'Ready: Spec', layout: 'checkout' })
    await mkdir(h.folder, { recursive: true })
    await writeFile(join(h.folder, 'spec.md'), SPEC)
    const worktree = worktreeFor(h.main)
    await exec('git', ['-C', h.main, 'worktree', 'add', '-q', '-b', 'feat/kit-11-x', worktree, 'main'])
    const redirect = await h.start()
    h.cd(worktree)
    const step = await h.advance({}, await h.start())
    expect({
      stage: redirect.stage?.stage,
      worktree: redirect.stage?.worktree,
      adds: (await h.gitCalls()).filter((args) => args[0] === 'worktree' && args[1] === 'add').length,
      spec: existsSync(join(h.folder, 'spec.md')),
      command: commandOf(step),
    }).toEqual({ stage: 'worktree', worktree, adds: 0, spec: true, command: '/aspira-planner KIT-11 --local --take-recommended' })
  }, SLOW)

  it('stops naming the missing Type before any worktree or step when the card has no Type', async () => {
    const { h, result } = await fromMain({ status: 'Ready: Spec', type: null })
    const text = `${result.text}\n${await readFile(join(h.folder, 'build-summary.md'), 'utf8').catch(() => '')}`
    expect({ end: result.stage?.stage, named: /\bType\b/.test(text), worktrees: existsSync(join(h.main, '.worktrees')), steps: kinds(h.stages).filter((kind) => kind === 'step' || kind === 'worktree').length }).toEqual({
      end: 'end',
      named: true,
      worktrees: false,
      steps: 0,
    })
  }, SLOW)
})
