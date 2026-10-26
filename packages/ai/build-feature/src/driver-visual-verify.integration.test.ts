// The visual-verify phase of the build-feature driver at seam S1: `scripts/local.ts <ID>`, as
// `build-feature.sh local` runs it, observed through the one JSON stage each call prints and the
// files it writes under `.work/<id>-<slug>/` (build-summary.md, visual-verify/report.md,
// .local/build-feature/state.json and pr-body.md) and the git calls it makes. Only the boundaries
// are stood in for (TEST-007): git's remote, gh and time; route.ts and the phase run for real, and
// no browser is involved (the session's answer is the stage answer file). KIT-58 plan P2: T4-T20.
// These tests are written before the phase exists (P6): until then the sequence goes straight from
// the implementor to the gate and nothing records a visual-verify outcome.
//
// The stage contract these tests pin:
//   - visual-verify: { verification, devServer: { cwd, command, run, unset, url, backendDeployed },
//     autonomous, screenshotsDir, spec, plan, skill, instructions }; the session writes the answer
//     { nonce, status: 'ran' | 'skipped', skipReason?, viewport, findings, notExercised,
//     backendNotDeployed, noData, screenshots } to `output` and calls the driver again.
//   - fix: { verification, findings, files, instructions }; the answer is { nonce, decisions, usage }.
//   - The phase's record is state.phases['visual-verify'] { status, skipReason, ... }.

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { BOARD, PACKAGE, REPOSITORY, SLUG, cleanup, kinds, ofKind, project, type Project, type Result, type Stage } from './driver.test-helper.ts'
import { SLOW } from './driver.integration.shared.ts'
import { homeVersionFile, stageKitHome } from './kit-home.test-helper.ts'

afterAll(cleanup)

const VERSION = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(join(PACKAGE, '..', 'package.json'), 'utf8'))).version
const SKILL_DIR = '.claude/skills/aspira-visual-verify'

/** The step skills as the global harness installs them: .kit-version for each, and visual-verify's SKILL.md, under the run's temp HOME (KIT-71 F9, F10). */
async function stageSkills(home: string, options: { versionFile?: boolean } = {}): Promise<void> {
  await stageKitHome(home, VERSION)
  await mkdir(join(home, SKILL_DIR), { recursive: true })
  await writeFile(join(home, SKILL_DIR, 'SKILL.md'), '# aspira-visual-verify\n')
  if (options.versionFile === false) await rm(homeVersionFile(home, 'visual-verify'), { force: true })
}
const PLAN_FILE = `.work/${SLUG}/plan.review/trace/plan.json`
const REPORT_FILE = (h: Project) => join(h.folder, 'visual-verify', 'report.md')

const UI_PATH = 'app/models/page.tsx'
const UI_TEST_PATH = 'app/models/page.test.tsx'
const UI_SOURCE = 'export default function Page() {\n  return null\n}\n'
const DEV = { cwd: '.', command: 'pnpm dev', url: 'http://localhost:3000' }
const GATE_AGENTS = { 'AGENTS.md': '# Project\n\nBefore every pull request, run `pnpm check`.\n' }
const USAGE = { tokens: 400, wallMs: 15000 }

type Dev = Record<string, unknown>
type BuiltOptions = {
  /** The paths the fixture plan.json changes. Default: the UI page. */
  paths?: string[]
  /** The aspira.json dev entry; null leaves it out. Default: DEV. */
  dev?: Dev | null
  mode?: 'local' | 'cloud'
  env?: Record<string, string>
  /** Extra files committed on the branch. */
  files?: Record<string, string>
  /** Extra arguments of the run start (--autonomous). */
  start?: string[]
}

/** A plan.json in planSchema's shape whose one task changes the given paths. */
function planJson(paths: readonly string[]): string {
  const changes = paths.map((path) => ({ operation: 'create', path, symbols: ['feature'], instructions: 'Add it.', evidence: ['src/app.ts:1'] }))
  return JSON.stringify({ summary: 'Build X.', tasks: [{ id: 'P1', title: 'Build X', kind: 'implementation', featureIds: ['F1'], dependsOn: [], testIds: [], changes, commands: [], outcome: 'X works.' }], tests: [], checks: [], decisions: [], gaps: [] }, null, 2)
}

/** Build at Ready: Plan, report the implementor complete, and return the stage after it. */
async function built(options: BuiltOptions = {}) {
  const dev = options.dev === undefined ? DEV : options.dev
  const h = await project({
    status: 'Ready: Plan',
    aspira: { board: BOARD, repository: REPOSITORY, ...(dev === null ? {} : { dev }) },
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.env === undefined ? {} : { env: options.env }),
    files: { ...GATE_AGENTS, ...options.files },
    kitVersion: null,
  })
  await stageSkills(h.dir)
  await h.write(PLAN_FILE, planJson(options.paths ?? [UI_PATH]))
  const implementor = await h.advance({}, await h.start(options.start))
  await h.report(implementor.stage!, 'complete')
  return { h, next: await h.advance() }
}

const finding = (grade: 'blocker' | 'major' | 'minor', title: string, files: string[] = [], extra: Record<string, unknown> = {}) => ({ grade, title, page: '/models', files, deployedBackend: false, ...extra })
/** A visual-verify answer: ran at 1280px with nothing else unless given. */
const ran = (extra: Record<string, unknown> = {}) => ({ status: 'ran', viewport: '1280px wide', findings: [], notExercised: [], backendNotDeployed: [], noData: [], screenshots: [], ...extra })
const skipped = (skipReason: string) => ({ status: 'skipped', skipReason, viewport: '1280px wide', findings: [], notExercised: [], backendNotDeployed: [], noData: [], screenshots: [] })

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The Visual verify part of a Build Summary or PR body mentions the reason after its heading. */
const names = (text: string, reason: string) => new RegExp(`visual verify[\\s\\S]*?${escaped(reason)}`, 'i').test(text)
/** Whether a text claims visual verify passed. */
const claimsPassed = (text: string) => /visual verify[^\n]*\bpassed\b/i.test(text)
const record = async (h: Project) => ((await h.state()).phases as Record<string, { status?: string; skipReason?: string } | undefined> | undefined)?.['visual-verify']
const devServerOf = (stage: Stage | null) => (stage?.devServer ?? {}) as { run?: string; url?: string; backendDeployed?: boolean }
const headOf = async (h: Project) => (await h.git('rev-parse', 'HEAD')).stdout.trim()
const pushes = async (h: Project) => (await h.gitCalls()).filter((args) => args.includes('push'))

/** Answer a verification with a blocker citing the UI page, then answer the fix stage that follows, writing the given files. */
async function fixAfter(h: Project, verify: Result, title: string, edits: Record<string, string>) {
  await h.answer(verify.stage, ran({ findings: [finding('blocker', title, [UI_PATH])] }))
  const fixStage = await h.advance()
  for (const [path, content] of Object.entries(edits)) await h.write(path, content)
  await h.answer(fixStage.stage, { decisions: [], usage: USAGE })
  return fixStage
}

describe('T4 T5 T6 F1 F12 F19: the check is skipped, with its reason recorded, before any stage', () => {
  it('skips a plan without UI as "plan without UI", goes to the gate, and names it in the Build Summary and PR body', async () => {
    const { h, next } = await built({ paths: ['src/feature.ts'] })
    await h.stop()
    const [summary, prBody, state] = [await h.summary(), await h.prBody(), await record(h)]
    expect({
      next: next.stage?.stage,
      visualVerifyStages: ofKind(h.stages, 'visual-verify').length,
      status: state?.status,
      reason: state?.skipReason,
      summary: names(summary, 'plan without UI'),
      prBody: names(prBody, 'plan without UI'),
      claims: claimsPassed(summary) || claimsPassed(prBody),
    }).toEqual({ next: 'gate', visualVerifyStages: 0, status: 'skipped', reason: 'plan without UI', summary: true, prBody: true, claims: false })
  }, SLOW)

  it('skips under --cloud, prints no visual-verify stage, and names "--cloud" in the Build Summary', async () => {
    const { h, next } = await built({ mode: 'cloud' })
    await h.stop()
    const state = await record(h)
    expect({ next: next.stage?.stage, stages: ofKind(h.stages, 'visual-verify').length, reason: state?.skipReason, named: names(await h.summary(), '--cloud') }).toEqual({ next: 'gate', stages: 0, reason: '--cloud', named: true })
  }, SLOW)

  it('skips a UI plan without an aspira.json dev entry as "no aspira.json dev entry", in the Build Summary and PR body', async () => {
    const { h, next } = await built({ dev: null })
    await h.stop()
    const [summary, prBody, state] = [await h.summary(), await h.prBody(), await record(h)]
    expect({ next: next.stage?.stage, reason: state?.skipReason, summary: names(summary, 'no aspira.json dev entry'), prBody: names(prBody, 'no aspira.json dev entry') }).toEqual({ next: 'gate', reason: 'no aspira.json dev entry', summary: true, prBody: true })
  }, SLOW)
})

describe('T7 T8 F1 F2 F3: the verify stage and the local-address check', () => {
  // NOTION_TOKEN is not set in the fixture's environment (the driver would then reach for the real
  // Notion API); the fixed credential names are stripped whether or not they are set (AVA3.1).
  it('prints the visual-verify stage before the gate, with the dev server started by an env -u line and the screenshots under the ticket folder', async () => {
    const { h, next } = await built({ env: { FIXTURE_API_KEY: 'k' } })
    const dev = devServerOf(next.stage)
    expect({
      stage: next.stage?.stage,
      verification: next.stage?.verification,
      gates: ofKind(h.stages, 'gate').length,
      starts: dev.run?.startsWith('env '),
      notion: dev.run?.includes('-u NOTION_TOKEN '),
      key: dev.run?.includes('-u FIXTURE_API_KEY '),
      ends: dev.run?.endsWith(' pnpm dev'),
      url: dev.url,
      screenshots: String(next.stage?.screenshotsDir) === join(h.folder, 'visual-verify') && String(next.stage?.screenshotsDir).endsWith('/visual-verify'),
      autonomous: next.stage?.autonomous,
    }).toEqual({ stage: 'visual-verify', verification: 1, gates: 0, starts: true, notion: true, key: true, ends: true, url: 'http://localhost:3000', screenshots: true, autonomous: false })
  }, SLOW)

  it('stops before any stage when the dev url is not a local address, naming the url in the Build Summary', async () => {
    const { h, next } = await built({ dev: { ...DEV, url: 'https://staging.example.com' } })
    const summary = await h.summary()
    expect({ end: next.stage?.stage, shown: kinds(h.stages).some((kind) => kind === 'visual-verify' || kind === 'gate'), url: summary.includes('https://staging.example.com'), local: /local|loopback/i.test(summary) }).toEqual({ end: 'end', shown: false, url: true, local: true })
  }, SLOW)
})

describe('T5 F11 F13: a placeholder dev url resolves per worktree', () => {
  const PLACEHOLDER = { cwd: '.', command: 'pnpm dev', url: 'http://{name}.localhost:{port}' }
  const ENV_FILE = '.env.development.local'
  const NO_WORKTREE = 'dev.url needs a kit worktree; run kit worktree'
  /** The name the ticket's worktree gives the url: its folder without the handle prefix, lower case. */
  const nameOf = (h: Project) => basename(h.repo).replace(/^[A-Za-z]+-/, '').toLowerCase()

  it('gives two worktrees of one project their own url and a kit dev run line, and skips neither', async () => {
    const first = await built({ dev: PLACEHOLDER, files: { [ENV_FILE]: 'PORT=3001\n' } })
    const second = await built({ dev: PLACEHOLDER, files: { [ENV_FILE]: 'PORT=3002\n' } })
    const [a, b] = [devServerOf(first.next.stage), devServerOf(second.next.stage)]
    expect({
      stages: [first.next.stage?.stage, second.next.stage?.stage],
      urls: [a.url, b.url],
      runs: [a.run?.endsWith(' kit dev') ?? false, b.run?.endsWith(' kit dev') ?? false],
    }).toEqual({ stages: ['visual-verify', 'visual-verify'], urls: [`http://${nameOf(first.h)}.localhost:3001`, `http://${nameOf(second.h)}.localhost:3002`], runs: [true, true] })
  }, SLOW)

  it('skips a checkout without a PORT line with "dev.url needs a kit worktree; run kit worktree" in the Build Summary and prints no stage', async () => {
    const { h, next } = await built({ dev: PLACEHOLDER })
    await h.stop()
    const state = await record(h)
    expect({ next: next.stage?.stage, stages: ofKind(h.stages, 'visual-verify').length, status: state?.status, reason: state?.skipReason, summary: names(await h.summary(), NO_WORKTREE) }).toEqual({ next: 'gate', stages: 0, status: 'skipped', reason: NO_WORKTREE, summary: true })
  }, SLOW)

  it('stops before any stage when the resolved url is not a local address, naming the resolved url in the Build Summary', async () => {
    const { h, next } = await built({ dev: { ...PLACEHOLDER, url: 'http://{name}.evil.com:{port}' }, files: { [ENV_FILE]: 'PORT=3001\n' } })
    const summary = await h.summary()
    expect({ end: next.stage?.stage, shown: kinds(h.stages).some((kind) => kind === 'visual-verify' || kind === 'gate'), url: summary.includes(`http://${nameOf(h)}.evil.com:3001`) }).toEqual({ end: 'end', shown: false, url: true })
  }, SLOW)
})

describe('T9 T10 T20 F1 F8 F11 F12 F19: the answer to the verify stage', () => {
  it('records major and minor findings only: major before minor, the not-exercised action apart, no fix stage, then the gate', async () => {
    const { h, next } = await built()
    await h.answer(next.stage, ran({ findings: [finding('minor', 'Icon is one pixel off'), finding('major', 'Column header is clipped')], notExercised: [{ page: '/models', action: 'Re-check all', reason: 'it accepts a third-party EULA' }] }))
    const gate = await h.advance()
    await h.stop()
    const summary = await h.summary()
    const at = (text: string) => summary.indexOf(text)
    expect({
      next: gate.stage?.stage,
      order: at('Column header is clipped') >= 0 && at('Column header is clipped') < at('Icon is one pixel off'),
      apart: at('Re-check all') > at('Icon is one pixel off'),
      asFinding: /\((?:blocker|major|minor)\)[^\n]*Re-check all/.test(summary),
      fixes: ofKind(h.stages, 'fix').length,
    }).toEqual({ next: 'gate', order: true, apart: true, asFinding: false, fixes: 0 })
  }, SLOW)

  it('names a skip reported by the session in the Build Summary, PR body and report.md, and never says passed', async () => {
    const { h, next } = await built()
    await h.answer(next.stage, skipped('no Chrome tool'))
    const gate = await h.advance()
    await h.stop()
    const [summary, prBody, report] = [await h.summary(), await h.prBody(), await readFile(REPORT_FILE(h), 'utf8').catch(() => '')]
    expect({
      next: gate.stage?.stage,
      summary: names(summary, 'no Chrome tool'),
      prBody: names(prBody, 'no Chrome tool'),
      report: report.includes('no Chrome tool'),
      claims: [summary, prBody, report].some(claimsPassed),
    }).toEqual({ next: 'gate', summary: true, prBody: true, report: true, claims: false })
  }, SLOW)

  it('stops before the gate naming the answer file and the invalid status when the answer does not parse', async () => {
    const { h, next } = await built()
    await h.answer(next.stage, { status: 'great' })
    const end = await h.advance()
    const summary = await h.summary()
    expect({ end: end.stage?.stage, gates: ofKind(h.stages, 'gate').length, file: summary.includes(basename(String(next.stage?.output))), status: summary.includes('status') }).toEqual({ end: 'end', gates: 0, file: true, status: true })
  }, SLOW)
})

describe('T11 T12 T13 T14 F9 F10 F19: blockers go to the fix stage, at most three verifications', () => {
  const onBranch = { files: { [UI_PATH]: UI_SOURCE } }

  it('lists only the cited file, commits the fix and its test locally without .work paths, never pushes, and verifies again as verification 2', async () => {
    const { h, next } = await built(onBranch)
    const fixStage = await fixAfter(h, next, 'Every price is a dash', {
      [UI_PATH]: 'export default function Page() {\n  return 1\n}\n',
      [UI_TEST_PATH]: "import { expect, it } from 'vitest'\nit('renders', () => expect(1).toBe(1))\n",
      [`.work/${SLUG}/visual-verify/shot.png`]: 'png',
    })
    const again = await h.advance()
    const subject = (await h.git('log', '-1', '--format=%s')).stdout.trim()
    const committed = (await h.git('show', '--name-only', '--format=', 'HEAD')).stdout.split('\n').filter((line) => line !== '')
    expect({
      files: fixStage.stage?.files,
      subject,
      committed: committed.includes(UI_PATH) && committed.includes(UI_TEST_PATH),
      work: committed.filter((path) => path.startsWith('.work')),
      pushes: (await pushes(h)).length,
      next: again.stage?.stage,
      verification: again.stage?.verification,
    }).toEqual({ files: [UI_PATH], subject: 'KIT-11: fix visual-verify blockers, verification 1', committed: true, work: [], pushes: 0, next: 'visual-verify', verification: 2 })
  }, SLOW)

  it('stops naming src/app.ts when the fix also changed a file the blocker does not cite: no commit, no gate', async () => {
    const { h, next } = await built(onBranch)
    const before = await headOf(h)
    await fixAfter(h, next, 'Every price is a dash', { [UI_PATH]: 'export default function Page() {\n  return 1\n}\n', 'src/app.ts': 'export const app = 2\n' })
    const end = await h.advance()
    expect({ end: end.stage?.stage, named: (await h.summary()).includes('src/app.ts'), head: await headOf(h), gates: ofKind(h.stages, 'gate').length }).toEqual({ end: 'end', named: true, head: before, gates: 0 })
  }, SLOW)

  it('stops after verification 3 with two fix stages and no gate, the blockers leading the Build Summary ahead of "Remaining findings:"', async () => {
    const { h, next } = await built(onBranch)
    await fixAfter(h, next, 'Every price is a dash', { [UI_PATH]: 'export default function Page() {\n  return 1\n}\n' })
    const second = await h.advance()
    await fixAfter(h, second, 'Every price is a dash', { [UI_PATH]: 'export default function Page() {\n  return 2\n}\n' })
    const third = await h.advance()
    await h.answer(third.stage, ran({ findings: [finding('blocker', 'Every price is a dash', [UI_PATH])] }))
    const end = await h.advance()
    const summary = await h.summary()
    const blockers = summary.indexOf('Visual verify blockers')
    const remaining = summary.indexOf('Remaining findings:')
    expect({
      verifications: [second.stage?.verification, third.stage?.verification],
      fixes: ofKind(h.stages, 'fix').length,
      end: end.stage?.stage,
      gates: ofKind(h.stages, 'gate').length,
      leads: blockers >= 0 && (remaining === -1 || blockers < remaining),
    }).toEqual({ verifications: [2, 3], fixes: 2, end: 'end', gates: 0, leads: true })
  }, SLOW)

  it.each([
    { name: 'cites no file', blocker: finding('blocker', 'Prices fail to load', []) },
    { name: 'is caused by the deployed backend', blocker: finding('blocker', 'Prices fail to load', [UI_PATH], { deployedBackend: true }) },
  ])('stops before the gate with the finding and no fix stage when a blocker $name', async ({ blocker }) => {
    const { h, next } = await built(onBranch)
    await h.answer(next.stage, ran({ findings: [blocker] }))
    const end = await h.advance()
    expect({ end: end.stage?.stage, gates: ofKind(h.stages, 'gate').length, fixes: ofKind(h.stages, 'fix').length, titled: (await h.summary()).includes('Prices fail to load') }).toEqual({ end: 'end', gates: 0, fixes: 0, titled: true })
  }, SLOW)
})

describe('T15 F21: one outcome per build', () => {
  it('does not verify again on a resume of the same build, and verifies again after a new implementor run', async () => {
    const { h, next } = await built()
    await h.answer(next.stage, ran())
    const gate = await h.advance()
    await h.answer(gate.stage, { results: ((gate.stage?.commands ?? []) as string[]).map((command) => ({ command, exitCode: 0, output: 'ok' })) })
    await h.advance()
    await h.stop()
    const verifiedBefore = ofKind(h.stages, 'visual-verify').length
    await h.advance({}, await h.start())
    const verifiedAfterResume = ofKind(h.stages, 'visual-verify').length
    // A new implementor run: the card goes back to Ready: Plan, later in time, and the implementor reports again.
    await h.stop()
    h.card.status = 'Ready: Plan'
    h.setNow('2026-10-12T10:00:00.000Z')
    const implementor = await h.advance({}, await h.start())
    await h.report(implementor.stage!, 'complete')
    const again = await h.advance()
    expect({ verifiedBefore, verifiedAfterResume, again: again.stage?.stage, verification: again.stage?.verification }).toEqual({ verifiedBefore: 1, verifiedAfterResume: 1, again: 'visual-verify', verification: 1 })
  }, SLOW)
})

describe('T16 F16, KIT-71 T37: the visual-verify skill is installed under ~/.claude at the driver version', () => {
  it.each([
    { name: 'is missing', stage: (home: string) => stageSkills(home, { versionFile: false }) },
    { name: 'names 0.0.1', stage: async (home: string) => { await stageSkills(home); await writeFile(homeVersionFile(home, 'visual-verify'), '0.0.1\n') } },
  ])('refuses the start with exit 1 naming the ~/.claude file and "run kit update" when its .kit-version $name', async ({ stage }) => {
    const h = await project({ status: 'Ready: Plan', kitVersion: null })
    await stage(h.dir)
    const started = await h.start()
    expect({
      code: started.code,
      names: started.text.includes('~/.claude/skills/aspira-visual-verify/.kit-version') && started.text.includes('run kit update') && !started.text.includes('kit init'),
      stage: started.stage,
      recorded: existsSync(join(h.stateDir, 'state.json')),
    }).toEqual({ code: 1, names: true, stage: null, recorded: false })
  }, SLOW)

  it('T37 hands the visual-verify step its SKILL.md under the temp HOME, not under the repository', async () => {
    const { h, next } = await built()
    expect({ stage: next.stage?.stage, skill: next.stage?.skill }).toEqual({ stage: 'visual-verify', skill: join(h.dir, SKILL_DIR, 'SKILL.md') })
  }, SLOW)
})

describe('T17 F2: a tracked file the dev server changed', () => {
  it('stops before the gate naming README.md and never commits it', async () => {
    const { h, next } = await built()
    await h.write('README.md', '# Fixture\n\nWritten by the dev server.\n')
    await h.answer(next.stage, ran())
    const end = await h.advance()
    expect({ end: end.stage?.stage, named: (await h.summary()).includes('README.md'), gates: ofKind(h.stages, 'gate').length, committed: (await h.filesSince(h.base)).includes('README.md') }).toEqual({ end: 'end', named: true, gates: 0, committed: false })
  }, SLOW)
})

describe('T18 T19 F12 F13 F14: sign-in under --autonomous and a backend that is not deployed', () => {
  it('passes autonomous to the stage and names an "--autonomous with sign-in needed" skip in the Build Summary', async () => {
    const { h, next } = await built({ start: ['--autonomous'] })
    await h.answer(next.stage, skipped('--autonomous with sign-in needed'))
    const gate = await h.advance()
    await h.stop()
    expect({ stage: next.stage?.stage, autonomous: next.stage?.autonomous, next: gate.stage?.stage, named: names(await h.summary(), '--autonomous with sign-in needed') }).toEqual({ stage: 'visual-verify', autonomous: true, next: 'gate', named: true })
  }, SLOW)

  it('lists a route under "backend not deployed (unverified)" in the Build Summary and PR body, and goes on to the gate', async () => {
    const { h, next } = await built({ dev: { ...DEV, backendDeployed: true } })
    await h.answer(next.stage, ran({ backendNotDeployed: [{ route: '/api/models' }] }))
    const gate = await h.advance()
    await h.stop()
    const listed = (text: string) => /backend not deployed \(unverified\)[\s\S]*\/api\/models/.test(text)
    expect({ backend: devServerOf(next.stage).backendDeployed, summary: listed(await h.summary()), prBody: listed(await h.prBody()), next: gate.stage?.stage }).toEqual({ backend: true, summary: true, prBody: true, next: 'gate' })
  }, SLOW)
})
