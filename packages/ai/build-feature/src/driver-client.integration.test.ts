// The build-feature driver under a client harness (KIT-68 P8, T33-T40; F5-F8, F11, F13, F14, F16-F18, F20, F21, F23):
// `scripts/local.ts <ID>` at a client root that is not a git repository, holding aspira.json
// {board, statusFlow: false, pullRequest: false, guidelines, workRoot, repos: {web, api}}, a guidelines folder with REV-001,
// and two git repositories with bare origins. Observed through the one JSON stage each call prints, git state, gh's recorded
// calls and what the mock Notion (the session's side of the boundary, driver-client.test-helper.ts) was asked to do.
// Only the boundaries are stood in for (TEST-007): the session's Notion answers, git's remote, gh and pnpm, time, and the
// fake step launchers, which write each step's export and (the implementor) commit one file.
// The helper beside driver.test-helper.ts is new so the existing tests stay unedited.

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ID } from './driver.test-helper.ts'
import { cleanupClient, clientProject, BRANCH, worktreeIn, type ClientProject } from './driver-client.test-helper.ts'
import { SLOW } from './driver.integration.shared.ts'

afterAll(cleanupClient)

const kindsOf = (h: ClientProject) => h.stages.map((stage) => stage.stage)
const noStageYet = (h: ClientProject) => !kindsOf(h).some((kind) => ['approval', 'worktree', 'step', 'move'].includes(kind))
const isStep = (name: string) => (stage: { stage: string; step?: unknown }) => stage.stage === 'step' && stage.step === name

/** Start, answer the card resolution, and return the result after it: where a refusal that needs the card's Area tags lands. */
async function startAndResolve(h: ClientProject, extra: string[] = []) {
  const first = await h.start(extra)
  await h.answer(first.stage, h.resolution())
  return h.next()
}

describe('T33 F23 F5 F7 F17 F18: a client run from groom to review leaves the client repos untouched', () => {
  it('records no Status move, no Dev write and no release row, and writes nothing to a client repo but the ticket branch commits', async () => {
    const h = await clientProject({ areas: ['web'] })
    const end = await h.advance({ from: await h.start() })
    const worktree = worktreeIn(h.web)

    // Mock Notion: the session was asked for no move, no ticket write (Status, Dev), no PR property and no release row.
    const writes = h.notion.requests.filter((request) => request.op === 'write')
    const mock = {
      end: end.stage?.stage,
      moves: h.notion.moves.length,
      ticketWrites: writes.filter((request) => request.target === 'ticket' || request.target === 'release-page').length,
      releaseRows: h.notion.releaseRows,
      prWrites: h.notion.prWrites.length,
      pages: [...new Set(writes.filter((request) => request.target === 'child-page').map((request) => request.page))].sort(),
    }

    // No push and no PR: both origins hold what they held, and gh was never asked for a pull request.
    const origins = { web: await h.originHeads(h.origins.web), api: await h.originHeads(h.origins.api) }
    const gh = (await h.ghCalls()).filter((args) => args[0] === 'pr')
    const pushes = (await h.gitCalls()).filter((args) => args.includes('push'))

    // The repos: clean, the base untouched, only the ticket branch differs, and no Aspira file or folder in either repo or the worktree.
    const status = { web: await h.git(h.web, 'status', '--porcelain'), api: await h.git(h.api, 'status', '--porcelain') }
    const branchFiles = (await h.git(h.web, 'diff', '--name-only', `${h.heads.web}..${BRANCH}`)).split('\n').filter((file) => file !== '')
    const leaked = ['web', 'api', 'worktree'].flatMap((name) => {
      const root = name === 'web' ? h.web : name === 'api' ? h.api : worktree
      return ['aspira.json', 'guidelines', '.work'].filter((entry) => h.exists(join(root, entry))).map((entry) => `${name}/${entry}`)
    })
    const exclude = await readFile(join(h.web, '.git/info/exclude'), 'utf8')
    const gitignore = await readFile(join(h.web, '.gitignore'), 'utf8')

    expect({
      mock,
      origins,
      prCommands: gh.length,
      pushes: pushes.length,
      status,
      baseUnmoved: (await h.git(h.web, 'rev-parse', 'main')) === h.heads.web,
      branchOnly: branchFiles.includes('src/feature.ts') && branchFiles.every((file) => !/^(aspira\.json|guidelines|\.work)/.test(file)),
      leaked,
      worktreeLink: h.exists(join(worktree, 'aspira.json')),
      excluded: exclude.split('\n').includes('.worktrees/'),
      ignored: gitignore.includes('.worktrees'),
    }).toEqual({
      mock: { end: 'end', moves: 0, ticketWrites: 0, releaseRows: 0, prWrites: 0, pages: ['Grooming Decisions', 'Implementation', 'PR Review', 'Plan', 'Spec', 'Spec Reviewed', 'Spec Review Decisions'].sort() },
      origins: { web: { main: h.heads.web }, api: { [h.apiBranch]: h.heads.api } },
      prCommands: 0,
      pushes: 0,
      status: { web: '', api: '' },
      baseUnmoved: true,
      branchOnly: true,
      leaked: [],
      worktreeLink: false,
      excluded: true,
      ignored: false,
    })
  }, SLOW * 3)
})

describe('T34 F13: the card\'s Area tags choose the repo', () => {
  it.each([
    { name: 'no tag', areas: [] as string[] },
    { name: 'tags for two repos', areas: ['web', 'api'] },
  ])('refuses a card with $name before any stage, naming its tags and the mapped ones', async ({ areas }) => {
    const h = await clientProject({ areas })
    const refused = await startAndResolve(h)
    expect({
      // A refusal is a non-zero exit, or the run stopping (its summary and end stages) instead of going on to the approval, worktree or a step.
      refused: refused.code !== 0 || refused.stage?.stage === 'end' || refused.stage?.stage === 'summary',
      stages: noStageYet(h),
      mapped: ['web', 'api'].every((tag) => refused.text.includes(tag)),
      tags: areas.every((tag) => refused.text.includes(tag)),
    }).toEqual({ refused: true, stages: true, mapped: true, tags: true })
  }, SLOW)

  it('names web/ in the run-start approval record and the first stage after the card, and works in web/\'s ticket worktree', async () => {
    const h = await clientProject({ areas: ['web'] })
    const afterCard = await startAndResolve(h)
    const worktree = await h.advance({ from: afterCard, until: (stage) => stage.stage === 'worktree' })
    const approvals = JSON.stringify((await h.state()).approvals ?? [])
    expect({
      first: JSON.stringify(afterCard.stage).includes(h.web),
      approval: approvals.includes(h.web) || approvals.includes('web/'),
      worktree: worktree.stage?.stage === 'worktree' ? worktree.stage.worktree : worktree.stage?.stage,
    }).toEqual({ first: true, approval: true, worktree: worktreeIn(h.web) })
  }, SLOW)

  it('refuses --no-ticket at the client root naming the mapped repos, and runs it on api/ from inside api/', async () => {
    const root = await clientProject({ areas: [] })
    const refused = await root.start(['--no-ticket'])
    const inside = await clientProject({ areas: [], startIn: 'api' })
    const started = await inside.start(['--no-ticket'])
    expect({
      refused: refused.code !== 0,
      mapped: ['web', 'api'].every((name) => refused.text.includes(name)),
      stages: root.stages.length,
      runs: started.code === 0 && started.text.includes(inside.api) && !started.text.includes(inside.web),
    }).toEqual({ refused: true, mapped: true, stages: 0, runs: true })
  }, SLOW)
})

describe('T35 F20: client runs are in session only', () => {
  it('refuses --cloud and --autonomous saying so, and accepts --no-comment', async () => {
    // A fresh project for each start: a start that is accepted leaves a run in progress.
    const cloud = await (await clientProject({ areas: ['web'] })).start(['--cloud'])
    const autonomous = await (await clientProject({ areas: ['web'] })).start(['--autonomous'])
    const comment = await (await clientProject({ areas: ['web'] })).start(['--no-comment'])
    const says = (text: string) => /session/i.test(text) && /client/i.test(text)
    expect({
      cloud: cloud.code !== 0 && says(cloud.text),
      autonomous: autonomous.code !== 0 && says(autonomous.text),
      noComment: comment.code === 0 && comment.stage?.stage === 'resolve',
    }).toEqual({ cloud: true, autonomous: true, noComment: true })
  }, SLOW)
})

describe('T36 F7: pullRequest false needs statusFlow false', () => {
  it('is refused before any stage, naming pullRequest and statusFlow', async () => {
    const h = await clientProject({
      areas: ['web'],
      edit: (config) => {
        const { statusFlow: _removed, ...rest } = config
        return rest
      },
    })
    const refused = await h.start()
    expect({ refused: refused.code !== 0, stages: h.stages.length, named: refused.text.includes('pullRequest') && refused.text.includes('statusFlow') }).toEqual({ refused: true, stages: 0, named: true })
  }, SLOW)
})

describe('T37 F16 F6: a blocking follow-up ends the run after grooming', () => {
  it('ends as needs-author listing the follow-up, stops again while it is unresolved, and resumes at the spec once it is resolved', async () => {
    const h = await clientProject({ areas: ['web'], groomPage: 'blocking' })
    const first = await h.advance({ from: await h.start() })
    const firstText = `${first.text}\n${JSON.stringify(first.stage)}\n${await h.summary()}`
    const firstSteps = h.stages.filter((stage) => stage.stage === 'step').map((stage) => stage.step)

    // Unresolved: the rerun stops at the same point, listing it.
    const again = await h.advance({ from: await h.start() })
    const againText = `${again.text}\n${JSON.stringify(again.stage)}`

    // Resolved on the page: the rerun starts at the spec stage and does not repeat grooming.
    h.setGroomPage('resolved')
    const before = h.stages.length
    const resumed = await h.advance({ from: await h.start(), until: (stage) => stage.stage === 'step' })
    const stepsAfter = h.stages.slice(before).filter((stage) => stage.stage === 'step')

    expect({
      first: { end: first.stage?.stage, status: first.stage?.status, listed: firstText.includes('Which payment provider?'), steps: firstSteps },
      again: { end: again.stage?.stage, status: again.stage?.status, listed: againText.includes('Which payment provider?') },
      resumed: { stage: resumed.stage?.step, groomerAgain: stepsAfter.some((stage) => stage.step === 'groomer') },
    }).toEqual({
      first: { end: 'end', status: 'needs-author', listed: true, steps: ['groomer'] },
      again: { end: 'end', status: 'needs-author', listed: true },
      resumed: { stage: 'spec-writer', groomerAgain: false },
    })
  }, SLOW * 2)
})

describe('T38 F11: run state lives under workRoot at the client root', () => {
  it('keeps the run state and stage outputs in <client root>/.work/<ticket folder> and makes no .work in a repo', async () => {
    const h = await clientProject({ areas: ['web'] })
    await h.advance({ from: await h.start(), until: isStep('implementor') })
    const worktree = worktreeIn(h.web)
    expect({
      state: h.exists(join(h.stateDir, 'state.json')),
      groom: h.exists(join(h.folder, 'groom/trace/groom.json')),
      plan: h.exists(join(h.folder, 'plan.review/trace/plan.json')),
      folder: h.folder === join(h.client, '.work', 'kit-11-x'),
      inRepos: [join(h.web, '.work'), join(h.api, '.work'), join(worktree, '.work')].filter((dir) => h.exists(dir)),
    }).toEqual({ state: true, groom: true, plan: true, folder: true, inRepos: [] })
  }, SLOW * 2)
})

describe('T39 F14 F21: a repos entry\'s base branch, app and gates apply in its worktree', () => {
  it('branches the worktree from origin/develop, runs api\'s gates there, and reports visual verify skipped', async () => {
    const h = await clientProject({ areas: ['api'], apiDevelop: true })
    await h.advance({ from: await h.start(), until: isStep('pr-reviewer') })
    const worktree = worktreeIn(h.api)
    const adds = (await h.gitCalls()).filter((args) => args[0] === 'worktree' && args[1] === 'add')
    const gate = h.stages.find((stage) => stage.stage === 'gate')
    const cwds = ((gate?.cwds ?? []) as string[]).map((cwd) => resolve(worktree, cwd))
    const phases = (await h.state()).phases ?? {}
    expect({
      added: adds.map((args) => args.at(-1)),
      mergeBase: await h.git(worktree, 'merge-base', 'HEAD', 'origin/develop'),
      commands: gate?.commands,
      cwds,
      visual: phases['visual-verify']?.status,
    }).toEqual({
      added: ['origin/develop'],
      mergeBase: h.heads.api,
      commands: ['pnpm api-check'],
      cwds: [join(worktree, 'service')],
      visual: 'skipped',
    })
  }, SLOW * 2)
})

describe('T40 F8: the review reads the ticket worktree branch against the repos base and still pushes PR Review', () => {
  it('launches the pr-reviewer on the ticket branch against main with the ticket, and records a PR Review push with no PR on the card', async () => {
    const h = await clientProject({ areas: ['web'] })
    const reviewer = await h.advance({ from: await h.start(), until: isStep('pr-reviewer') })
    const command = String(reviewer.stage?.command)
    if (reviewer.stage?.stage === 'step') {
      await h.report(reviewer.stage, 'complete')
      await h.advance()
    }
    expect({
      stage: reviewer.stage?.stage,
      cwd: reviewer.stage?.cwd,
      ticket: command.includes(ID) && !command.includes('--no-ticket'),
      branch: /--branch feat\/kit-11-x(\s|$)/.test(command),
      base: /--base main(\s|$)/.test(command),
      prReviewPush: h.notion.requests.some((request) => request.stage === 'step' && request.op === 'write' && request.target === 'child-page' && request.page === 'PR Review'),
      prProperty: [h.card.pr, ...h.notion.prWrites],
    }).toEqual({ stage: 'step', cwd: worktreeIn(h.web), ticket: true, branch: true, base: true, prReviewPush: true, prProperty: [null] })
  }, SLOW * 2)
})
