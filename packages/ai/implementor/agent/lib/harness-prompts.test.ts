// Pins the implementor's --local prompt files (the orchestrator's plan and parallelize prompts, the worker
// briefs) for the three configs an Aspira product can have (KIT-68 F1); the goldens under __goldens__/ were
// recorded at 7797a62. The extend case (F11) reads a client aspira.json above the repo. runLocal runs on the
// fake deps its own suite uses: a copy of the agent's files and a knowledge folder written by hand.
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { runLocal, type LocalResult } from './local.ts'

const BOARD = 'https://www.notion.so/Feature-Board-0123456789abcdef0123456789abcdef'
const PAGE = 'https://www.notion.so/Page-0123456789abcdef0123456789abcdef'
const CONFIGS: Record<string, Record<string, unknown> | null> = {
  none: null,
  board: { board: BOARD },
  full: {
    board: BOARD,
    releases: PAGE,
    app: 'app',
    knowledge: PAGE,
    gates: [{ command: 'pnpm lint' }, { cwd: 'app', command: 'pnpm test' }],
    models: { 'implementor.verification': { model: 'opus', effort: 'high' } },
    database: { provider: 'neon', projectId: 'p-1', parentBranch: 'main', envVars: ['DATABASE_URL'] },
    webhooks: [{ provider: 'stripe', path: '/api/webhooks/stripe', events: ['checkout.session.completed'] }],
    tunnel: { zone: 'example.com' },
    dev: { command: 'pnpm dev', url: 'http://localhost:3000' },
    codebaseMaps: '.codebase-maps',
  },
}

const exec = promisify(execFile)
const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '../..')
const PROCEDURE = 'agent/skills/aspira-implementor/SKILL.md'
const INSTRUCTIONS = 'agent/instructions.md'

const id = (n: number) => `3e73e59b2258${String(n).padStart(20, '0')}`
const url = (n: number) => `https://app.notion.com/p/${id(n)}`
const header = (title: string, n: number) => `<!-- ${title} · ${url(n)} · fetched 2026-10-05T00:00:00.000Z -->\n\n`
const INDEX = url(1)


const temps: string[] = []
const cwd = process.cwd()
afterEach(async () => {
  process.chdir(cwd)
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

const write = async (file: string, text: string) => {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text)
}

// A fixed commit time, so the commit ids in the prompts are the same on every run.
const FIXED = { GIT_AUTHOR_DATE: '2026-10-26T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-26T12:00:00Z' }

/** A temp folder with no aspira.json above it: the agent's files, a git repo with a spec, and the knowledge folder. */
async function fixture(config: Record<string, unknown> | null, at: 'repo' | 'root' = 'repo') {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'implementor-harness-')))
  temps.push(dir)
  const pkg = join(dir, 'pkg')
  await mkdir(join(pkg, 'agent/skills/aspira-implementor'), { recursive: true })
  await cp(join(PACKAGE, PROCEDURE), join(pkg, PROCEDURE))
  await cp(join(PACKAGE, INSTRUCTIONS), join(pkg, INSTRUCTIONS))
  const repo = join(dir, 'repo')
  await exec('git', ['init', '-q', '-b', 'feat/cart', repo])
  const git = (...args: string[]) => exec('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { env: { ...process.env, ...FIXED } })
  await git('config', 'init.defaultBranch', 'main')
  await mkdir(join(repo, 'specs/cart'), { recursive: true })
  await mkdir(join(repo, 'src'))
  await writeFile(join(repo, 'AGENTS.md'), '# Project\n')
  await writeFile(join(repo, 'specs/cart/spec.md'), '# Cart\n\n- [ ] F1: totals\n- [ ] F2: badge\n')
  await writeFile(join(repo, 'src/price.ts'), 'export const price = 1\n')
  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'cart', dependencies: { zod: '4.5.4' } }))
  if (config !== null) await write(join(at === 'repo' ? repo : dir, 'aspira.json'), `${JSON.stringify(config, null, 2)}\n`)
  await git('add', '.')
  await git('commit', '-qm', 'init')
  process.chdir(repo)
  const env = { KNOWLEDGE_PAGE: INDEX }
  const spec = join(repo, 'specs/cart/spec.md')
  const work = join(repo, 'specs/cart/implementation')
  const knowledge = join(work, 'implementation.local/knowledge')
  await writeKnowledge(knowledge)
  const step = () => runLocal({ source: spec }, { packageDir: pkg, env })
  const normalize = (text: string) => text.replaceAll(dir, '<root>').replace(/\b[0-9a-f]{40}\b/g, '<sha>')
  return { dir, work, step, normalize }
}

async function writeKnowledge(dir: string, options: { topics?: boolean } = {}) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'INDEX.md'), `${header('Engineering', 1)}<page url="${url(2)}">Agent Instructions</page>\n`)
  await writeFile(
    join(dir, 'agent-instructions.md'),
    `${header('Agent Instructions', 2)}TS-001 MUST be typed.\n<table header-row="true">\n<tr><td>Any code change</td><td><mention-page url="${url(10)}"/>, <mention-page url="${url(11)}"/></td></tr>\n</table>\nLessons go to <mention-page url="${url(99)}"/>.\n`,
  )
  await writeFile(join(dir, 'review-verification.md'), `${header('Review Verification', 3)}REV-001 read gotchas.\n`)
  if (options.topics !== false) {
    await writeFile(join(dir, 'common-patterns.md'), `${header('Common Patterns', 10)}CP-001 small functions.\n`)
    await writeFile(join(dir, 'testing-standards.md'), `${header('Testing Standards', 11)}TEST-001 tests first.\n`)
    await writeFile(join(dir, 'approved-technologies.md'), `${header('Approved Technologies', 12)}| Name | Status |\n| --- | --- |\n| Zod | Adopt |\n| MSW | Trial |\n`)
  }
}

function pending(result: LocalResult) {
  if (!result.pending) throw new Error(`expected a pending stage, got ${JSON.stringify(result)}`)
  return result
}

const plan = {
  summary: 'Cart totals and badge.',
  tests: [
    { id: 'T1', kind: 'unit', path: 'src/price.test.ts', featureIds: ['F1'], setup: 's', action: 'a', assertions: ['x'] },
    { id: 'T2', kind: 'unit', path: 'src/badge.test.ts', featureIds: ['F2'], setup: 's', action: 'a', assertions: ['y'] },
  ],
  tasks: [
    { id: 'P1', title: 'price tests', kind: 'tests', featureIds: ['F1'], dependsOn: [], testIds: ['T1'], changes: [{ operation: 'create', path: 'src/price.test.ts', symbols: ['t'], instructions: 'i', evidence: ['e'] }], commands: ['vitest src/price.test.ts'], outcome: 'red' },
    { id: 'P2', title: 'badge tests', kind: 'tests', featureIds: ['F2'], dependsOn: [], testIds: ['T2'], changes: [{ operation: 'create', path: 'src/badge.test.ts', symbols: ['t'], instructions: 'i', evidence: ['e'] }], commands: ['vitest src/badge.test.ts'], outcome: 'red' },
    { id: 'P3', title: 'price', kind: 'implementation', featureIds: ['F1'], dependsOn: ['P1'], testIds: ['T1'], changes: [{ operation: 'modify', path: 'src/price.ts', symbols: ['price'], instructions: 'i', evidence: ['src/price.ts:1'] }], commands: ['vitest src/price.test.ts'], outcome: 'green' },
    { id: 'P4', title: 'badge', kind: 'implementation', featureIds: ['F2'], dependsOn: ['P2'], testIds: ['T2'], changes: [{ operation: 'create', path: 'src/badge.ts', symbols: ['badge'], instructions: 'i', evidence: ['src/price.ts:1'] }], commands: ['vitest src/badge.test.ts'], outcome: 'green' },
    { id: 'P5', title: 'verify', kind: 'verification', featureIds: ['F1', 'F2'], dependsOn: ['P3', 'P4'], testIds: [], changes: [], commands: ['pnpm test'], outcome: 'all green' },
  ],
  checks: [],
  decisions: [],
  gaps: [],
}


const LANES = { waves: [{ lanes: [{ id: 'A', tasks: ['P1', 'P3'], worker: true, writeScope: ['src/price.test.ts', 'src/price.ts'], rules: ['TS-001 MUST be typed.'] }, { id: 'B', tasks: ['P2', 'P4'], worker: true, writeScope: ['src/badge.test.ts', 'src/badge.ts'], rules: [] }] }, { lanes: [{ id: 'V', tasks: ['P5'], worker: false, writeScope: [] }] }] }

/** The prompt files runLocal writes up to the first wave: the plan and parallelize orchestrator prompts and both worker briefs. */
async function prompts(made: Awaited<ReturnType<typeof fixture>>): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const read = async (result: LocalResult) => {
    for (const task of pending(result).tasks) out[task.id] = made.normalize(await readFile(task.prompt, 'utf8'))
    return pending(result)
  }
  await read(await made.step())
  await mkdir(made.work, { recursive: true })
  await writeFile(join(made.work, 'plan.json'), JSON.stringify(plan))
  await writeFile(join(made.work, 'plan.md'), '# Plan\n')
  const par = await read(await made.step())
  await writeFile(par.tasks[0]!.output, JSON.stringify(LANES))
  await read(await made.step())
  return out
}

const golden = (name: string) => `../../__goldens__/${name}.txt`

describe('F1: the orchestrator and worker prompt files are byte-identical for the three configs (goldens recorded at 7797a62)', () => {
  it.each(Object.keys(CONFIGS))('writes the prompt files under the %s config', async (name) => {
    const written = await prompts(await fixture(CONFIGS[name]!))
    expect(Object.keys(written)).toEqual(['plan', 'parallelize', 'wave-1-A', 'wave-1-B'])
    for (const [id, text] of Object.entries(written)) await expect(text).toMatchFileSnapshot(golden(`${id}-${name}`))
  })
})

describe('F11: extend.implementor appends the named file to the orchestrator and worker prompts', () => {
  it('ends both prompts with the file under a heading naming it', async () => {
    const made = await fixture({ repos: { web: { path: 'repo' } }, extend: { implementor: ['extend/build.md'] } }, 'root')
    const text = 'Builds run the client contract suite first.\n'
    await write(join(made.dir, 'extend/build.md'), text)
    const written = await prompts(made)
    for (const id of ['plan', 'parallelize', 'wave-1-A', 'wave-1-B']) {
      const prompt = written[id]!.trimEnd()
      expect(prompt.endsWith(text.trimEnd())).toBe(true)
      expect(prompt.slice(0, prompt.lastIndexOf(text.trim()))).toMatch(/extend\/build\.md[^\n]*\n+$/)
    }
  })

  it('leaves the prompts as the default golden when extend names only other stages', async () => {
    const made = await fixture({ repos: { web: { path: 'repo' } }, extend: { groomer: ['extend/g.md'] } }, 'root')
    await write(join(made.dir, 'extend/g.md'), 'Groomer notes.\n')
    const written = await prompts(made)
    expect(written['wave-1-A']).toBe(await readFile(new URL('../../__goldens__/wave-1-A-none.txt', import.meta.url), 'utf8'))
  })
})
