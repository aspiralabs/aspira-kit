// Pins the groomer's --local prompts (renderRoundPrompt, renderSummaryPrompt) for the three configs an
// Aspira product can have: no aspira.json, a board-only one, and one with every key a product uses today
// (KIT-68 F1). The goldens under __goldens__/ were recorded at 7797a62, before any harness change.
// The extend cases (F12) and the statusFlow follow-up cases (F15) read a client aspira.json above the repo.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { groomRecordSchema } from '@aspiralabs/ai/common/lib/groom-record'
import { renderRoundPrompt, renderSummaryPrompt } from './local.ts'
import { groomPaths } from './paths.ts'

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
const INSTRUCTIONS_SHA256 = '2bd685d95e357f4308b075194e6912286ad41e8442a46e89cfe6b730533eb299'

const roots: string[] = []
const cwd = process.cwd()
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-26T12:00:00.000Z'))
})
afterEach(async () => {
  vi.useRealTimers()
  process.chdir(cwd)
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true })
})

const write = async (file: string, text: string) => {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text)
}

/** A temp folder with no aspira.json above it, holding a git repo; `at` says where the aspira.json sits. */
async function fixture(config: Record<string, unknown> | null, at: 'repo' | 'root' = 'repo') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'groomer-harness-')))
  roots.push(root)
  const repo = join(root, 'repo')
  await mkdir(repo)
  execFileSync('git', ['init', '-q', repo])
  if (config !== null) await write(join(at === 'repo' ? repo : root, 'aspira.json'), `${JSON.stringify(config, null, 2)}\n`)
  process.chdir(repo)
  const folder = join(repo, '.work', 'kit-9-cart-limit')
  const paths = groomPaths(folder)
  const knowledgePath = paths.knowledge
  const knowledge = { source: 'folder' as const, path: knowledgePath, requiredFile: join(knowledgePath, 'REQUIRED.md'), files: [], digest: 'digest' }
  const record = groomRecordSchema.parse({
    decisions: [
      { id: 'Q1', question: 'Why does the cart stop at ten items?', options: ['A limit in the API', 'A limit in the UI'], recommended: 'A limit in the API', reasoning: 'The API enforces it', whyYours: 'It changes the product', branch: 'problem', facts: [], decidedBy: 'author', answer: 'A limit in the API' },
      { id: 'Q2', question: 'Who sees the message?', options: ['Shoppers', 'Staff'], recommended: 'Shoppers', reasoning: 'They hit the limit', whyYours: 'It changes who is told', branch: 'who', facts: [], decidedBy: 'open', answer: null },
    ],
    branches: [{ id: 'problem', state: 'visited' }, { id: 'who', state: 'open' }, { id: 'done', state: 'closed', reason: 'nothing to decide' }],
    round: 1,
    startedAt: '2026-10-26T12:00:00.000Z',
    open: 1,
    page: {},
    status: 'needs-author',
    facts: [{ path: 'src/cart.ts', line: 1, quote: 'LIMIT is 10' }],
    searched: ['cart limit'],
  })
  const normalize = (text: string) => text.replaceAll(root, '<root>')
  const round = (n = 1, titleOnly = false) => normalize(renderRoundPrompt({ n, output: join(paths.output, `round-${n}.json`), agentDir: join(root, 'pkg'), repo, paths, knowledge, record, titleOnly }))
  const summary = () => normalize(renderSummaryPrompt({ agentDir: join(root, 'pkg'), paths, record, repo }))
  return { root, repo, round, summary }
}

const golden = (name: string) => `./__goldens__/${name}.md`

describe('F1: the default path prompts are byte-identical for the three configs (goldens recorded at 7797a62)', () => {
  it.each(Object.keys(CONFIGS))('renders the round and summary prompts under the %s config', async (name) => {
    const { round, summary } = await fixture(CONFIGS[name]!)
    await expect(round(1)).toMatchFileSnapshot(golden(`round-1-${name}`))
    await expect(round(2)).toMatchFileSnapshot(golden(`round-2-${name}`))
    await expect(round(1, true)).toMatchFileSnapshot(golden(`round-1-title-only-${name}`))
    await expect(summary()).toMatchFileSnapshot(golden(`summary-${name}`))
  })

  it('keeps agent/instructions.md as it was at 7797a62', async () => {
    const text = await readFile(new URL('../instructions.md', import.meta.url), 'utf8')
    expect(createHash('sha256').update(text).digest('hex')).toBe(INSTRUCTIONS_SHA256)
  })
})

const EXTRA = { 'extend/style.md': '# Style\n\nUse the client voice.\n', 'extend/terms.md': 'Say "member", never "user".\n' }
const clientConfig = (extra: Record<string, unknown>) => ({ repos: { web: { path: 'repo' } }, ...extra })
async function client(extra: Record<string, unknown>) {
  const made = await fixture(clientConfig(extra), 'root')
  for (const [file, text] of Object.entries(EXTRA)) await write(join(made.root, file), text)
  return made
}

describe('F12: extend.groomer appends the named files to the round and summary prompts', () => {
  it('ends each prompt with the two files, each under a heading naming it, in listed order', async () => {
    const { round, summary } = await client({ extend: { groomer: ['extend/style.md', 'extend/terms.md'] } })
    for (const prompt of [round(1), summary()]) {
      const text = prompt.trimEnd()
      expect(text.endsWith(EXTRA['extend/terms.md'].trimEnd())).toBe(true)
      const style = text.indexOf(EXTRA['extend/style.md'].trim())
      const terms = text.indexOf(EXTRA['extend/terms.md'].trim())
      expect(style).toBeGreaterThan(-1)
      expect(terms).toBeGreaterThan(style)
      expect(text.slice(0, style)).toMatch(/extend\/style\.md[^\n]*\n+$/)
      expect(text.slice(style, terms)).toMatch(/extend\/terms\.md[^\n]*\n+$/)
    }
  })

  it('leaves the prompts as the default golden when extend names only other stages', async () => {
    const { round, summary } = await client({ extend: { planner: ['extend/style.md'] } })
    const dir = new URL('./__goldens__/', import.meta.url)
    expect(round(1)).toBe(await readFile(new URL('round-1-none.md', dir), 'utf8'))
    expect(summary()).toBe(await readFile(new URL('summary-none.md', dir), 'utf8'))
  })
})

describe('F15: statusFlow false offers the follow-up choices', () => {
  it('offers both follow-up choices in the round prompt and asks the summary for a Follow-ups heading', async () => {
    const { round, summary } = await client({ statusFlow: false })
    const text = round(1)
    expect(text).toContain('needs follow-up, blocks the build')
    expect(text).toContain('needs follow-up, build may go on')
    expect(summary()).toContain('### Follow-ups')
  })

  it('renders the T1 goldens under the three default configs and under statusFlow true', async () => {
    const dir = new URL('./__goldens__/', import.meta.url)
    for (const name of Object.keys(CONFIGS)) {
      const { round, summary } = await fixture(CONFIGS[name]!)
      expect(round(1)).toBe(await readFile(new URL(`round-1-${name}.md`, dir), 'utf8'))
      expect(summary()).toBe(await readFile(new URL(`summary-${name}.md`, dir), 'utf8'))
    }
    const { round } = await client({ statusFlow: true })
    expect(round(1)).toBe(await readFile(new URL('round-1-none.md', dir), 'utf8'))
  })
})
