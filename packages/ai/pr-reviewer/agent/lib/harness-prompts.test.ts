// Pins the PR reviewer's --local task prompts (renderTaskPrompt) for the three configs an Aspira product can
// have (KIT-68 F1); the goldens under __goldens__/ were recorded at 7797a62. The extend case (F12) reads a
// client aspira.json above the repo.
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { renderTaskPrompt, type PlanTask } from './local.ts'
import type { PrContext } from './review.ts'

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
    models: { 'groomer.round': { model: 'opus', effort: 'high' } },
    database: { provider: 'neon', projectId: 'p-1', parentBranch: 'main', envVars: ['DATABASE_URL'] },
    webhooks: [{ provider: 'stripe', path: '/api/webhooks/stripe', events: ['checkout.session.completed'] }],
    tunnel: { zone: 'example.com' },
    dev: { command: 'pnpm dev', url: 'http://localhost:3000' },
    codebaseMaps: '.codebase-maps',
  },
}

const TASKS: PlanTask[] = [
  { id: 'round-1-ava', agent: 'ava', kind: 'turn', stage: 'seats', round: 1, prompt: 'TURN: review the diff for correctness.' },
  { id: 'verify-quinn', agent: 'quinn', kind: 'verify', stage: 'verifier', round: 1, prompt: 'VERIFY: check each raised finding.' },
  { id: 'doc-quinn', agent: 'quinn', kind: 'doc', stage: 'documents', round: 1, prompt: 'DOC: write the review.' },
  { id: 'findings-quinn', agent: 'quinn', kind: 'findings', stage: 'checks', round: 1, prompt: 'FINDINGS: write findings.md.' },
]

const roots: string[] = []
const cwd = process.cwd()
afterEach(async () => {
  process.chdir(cwd)
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true })
})

const write = async (file: string, text: string) => {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text)
}

/** A temp folder with no aspira.json above it, holding a git repo; `at` says where the aspira.json sits. */
async function fixture(config: Record<string, unknown> | null, at: 'repo' | 'root' = 'repo') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pr-reviewer-harness-')))
  roots.push(root)
  const repo = join(root, 'repo')
  await mkdir(repo)
  execFileSync('git', ['init', '-q', repo])
  if (config !== null) await write(join(at === 'repo' ? repo : root, 'aspira.json'), `${JSON.stringify(config, null, 2)}\n`)
  process.chdir(repo)
  const work = join(repo, '.work', 'kit-9-cart-limit', 'pr-review.local')
  const pr: PrContext = { label: 'aspiralabs/fixture#7', repoPath: repo, knowledgePath: join(work, 'knowledge'), knowledgeRequiredFile: join(work, 'knowledge', 'REQUIRED.md'), packet: null }
  const persona = { path: join(root, 'pkg', 'agent', 'subagents', 'ava', 'persona.md'), text: 'PERSONA: Ava reads for correctness.' }
  const normalize = (text: string) => text.replaceAll(root, '<root>')
  const render = (task: PlanTask) => normalize(renderTaskPrompt(task, join(work, 'outputs', `${task.id}.json`), persona, pr, task.kind === 'doc' ? join(work, 'review.md') : undefined))
  return { root, render }
}

const golden = (name: string) => `./__goldens__/${name}.txt`

describe('F1: every review task prompt is byte-identical for the three configs (goldens recorded at 7797a62)', () => {
  it.each(Object.keys(CONFIGS))('renders every task under the %s config', async (name) => {
    const { render } = await fixture(CONFIGS[name]!)
    for (const task of TASKS) await expect(render(task)).toMatchFileSnapshot(golden(`${task.id}-${name}`))
  })
})

describe('F12: extend.pr-reviewer appends the named file to a review task prompt', () => {
  it('ends the prompt with the file under a heading naming it', async () => {
    const { root, render } = await fixture({ repos: { web: { path: 'repo' } }, extend: { 'pr-reviewer': ['extend/review.md'] } }, 'root')
    const text = 'Reviews check the client contract first.\n'
    await write(join(root, 'extend/review.md'), text)
    const prompt = render(TASKS[0]!).trimEnd()
    expect(prompt.endsWith(text.trimEnd())).toBe(true)
    expect(prompt.slice(0, prompt.lastIndexOf(text.trim()))).toMatch(/extend\/review\.md[^\n]*\n+$/)
  })

  it('leaves the prompts as the default golden when extend names only other stages', async () => {
    const { root, render } = await fixture({ repos: { web: { path: 'repo' } }, extend: { groomer: ['extend/g.md'] } }, 'root')
    await write(join(root, 'extend/g.md'), 'Groomer notes.\n')
    const dir = new URL('./__goldens__/', import.meta.url)
    expect(render(TASKS[0]!)).toBe(await readFile(new URL('round-1-ava-none.txt', dir), 'utf8'))
  })
})
