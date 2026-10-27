// Pins the planner's --local phase prompts (renderTaskPrompt) for the three configs an Aspira product can
// have (KIT-68 F1); the goldens under __goldens__/ were recorded at 7797a62. The extend case (F12) reads a
// client aspira.json above the repo.
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { renderTaskPrompt, type PhaseId } from './local.ts'

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

const PHASES: PhaseId[] = ['explore-1', 'research', 'planning', 'repair-1']

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
  const root = await realpath(await mkdtemp(join(tmpdir(), 'planner-harness-')))
  roots.push(root)
  const repo = join(root, 'repo')
  await mkdir(repo)
  execFileSync('git', ['init', '-q', repo])
  if (config !== null) await write(join(at === 'repo' ? repo : root, 'aspira.json'), `${JSON.stringify(config, null, 2)}\n`)
  process.chdir(repo)
  const output = (phase: string) => join(repo, '.work', 'kit-9-cart-limit', 'plan.local', 'outputs', `${phase}.json`)
  const normalize = (text: string) => text.replaceAll(root, '<root>')
  const render = (id: PhaseId) =>
    normalize(
      renderTaskPrompt({
        id,
        system: 'SYSTEM: the fixed planner system prompt.',
        prompt: 'TASK: the fixed phase prompt.',
        output: output(id),
        reads: id === 'research' || id === 'planning' ? join(repo, '.work', 'kit-9-cart-limit', 'plan.local', 'outputs', `${id}.reads.json`) : null,
        repo,
        knowledge: [join(repo, '.work', 'kit-9-cart-limit', 'plan.local', 'knowledge', 'common-patterns.md')],
        schema: z.object({ summary: z.string() }),
      }),
    )
  return { root, render }
}

const golden = (name: string) => `../../__goldens__/${name}.txt`

describe('F1: every phase prompt is byte-identical for the three configs (goldens recorded at 7797a62)', () => {
  it.each(Object.keys(CONFIGS))('renders every phase under the %s config', async (name) => {
    const { render } = await fixture(CONFIGS[name]!)
    for (const phase of PHASES) await expect(render(phase)).toMatchFileSnapshot(golden(`${phase}-${name}`))
  })
})

describe('F12: extend.planner appends the named file to the planning prompt', () => {
  it('ends the prompt with the file under a heading naming it', async () => {
    const { root, render } = await fixture({ repos: { web: { path: 'repo' } }, extend: { planner: ['extend/plan.md'] } }, 'root')
    const text = 'Plans list the client contract tests first.\n'
    await write(join(root, 'extend/plan.md'), text)
    const prompt = render('planning').trimEnd()
    expect(prompt.endsWith(text.trimEnd())).toBe(true)
    expect(prompt.slice(0, prompt.lastIndexOf(text.trim()))).toMatch(/extend\/plan\.md[^\n]*\n+$/)
  })

  it('leaves the prompts as the default golden when extend names only other stages', async () => {
    const { root, render } = await fixture({ repos: { web: { path: 'repo' } }, extend: { groomer: ['extend/g.md'] } }, 'root')
    await write(join(root, 'extend/g.md'), 'Groomer notes.\n')
    const dir = new URL('../../__goldens__/', import.meta.url)
    expect(render('planning')).toBe(await readFile(new URL('planning-none.txt', dir), 'utf8'))
  })
})
