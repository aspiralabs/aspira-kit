// Pins the spec writer's --local phase prompts (renderPhasePrompt) in write and review mode for the three
// configs an Aspira product can have (KIT-68 F1); the goldens under __goldens__/ were recorded at 7797a62.
// The extend case (F12) reads a client aspira.json above the repo; the spec writer's entry also applies to
// the spec review it runs.
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { lenses } from '@aspiralabs/ai/spec-reviewer/lib/review'
import { renderPhasePrompt } from './local.ts'

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

const PHASES = ['explore:app', 'draft', 'research', ...Object.keys(lenses), 'synthesis']
const MODES = ['write', 'review'] as const

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
  const root = await realpath(await mkdtemp(join(tmpdir(), 'spec-writer-harness-')))
  roots.push(root)
  const repo = join(root, 'repo')
  await mkdir(repo)
  execFileSync('git', ['init', '-q', repo])
  if (config !== null) await write(join(at === 'repo' ? repo : root, 'aspira.json'), `${JSON.stringify(config, null, 2)}\n`)
  process.chdir(repo)
  const knowledge = { source: 'folder' as const, path: join(repo, '.work', 'kit-9-cart-limit', 'spec.local', 'knowledge') }
  const output = (phase: string) => join(repo, '.work', 'kit-9-cart-limit', 'spec.local', 'outputs', `${phase.replaceAll(':', '-')}.json`)
  const normalize = (text: string) => text.replaceAll(root, '<root>')
  const render = (phase: string, mode: 'write' | 'review') => normalize(renderPhasePrompt(phase, 'TASK: the fixed phase prompt.', output(phase), repo, knowledge, mode))
  return { root, render }
}

const golden = (name: string) => `./__goldens__/${name}.md`

describe('F1: every phase prompt is byte-identical for the three configs (goldens recorded at 7797a62)', () => {
  it.each(Object.keys(CONFIGS))('renders every phase in write and review mode under the %s config', async (name) => {
    const { render } = await fixture(CONFIGS[name]!)
    for (const mode of MODES) {
      for (const phase of PHASES) await expect(render(phase, mode)).toMatchFileSnapshot(golden(`${mode}-${phase.replaceAll(':', '-')}-${name}`))
    }
  })
})

describe('F12: extend[spec-writer] appends the named file to the write and review prompts', () => {
  it('ends both modes with the file under a heading naming it', async () => {
    const { root, render } = await fixture({ repos: { web: { path: 'repo' } }, extend: { 'spec-writer': ['extend/spec.md'] } }, 'root')
    const text = 'Specs name the client contract first.\n'
    await write(join(root, 'extend/spec.md'), text)
    for (const mode of MODES) {
      for (const phase of ['draft', 'synthesis']) {
        const prompt = render(phase, mode).trimEnd()
        expect(prompt.endsWith(text.trimEnd())).toBe(true)
        expect(prompt.slice(0, prompt.lastIndexOf(text.trim()))).toMatch(/extend\/spec\.md[^\n]*\n+$/)
      }
    }
  })

  it('leaves the prompts as the default golden when extend names only other stages', async () => {
    const { root, render } = await fixture({ repos: { web: { path: 'repo' } }, extend: { planner: ['extend/plan.md'] } }, 'root')
    await write(join(root, 'extend/plan.md'), 'Plan notes.\n')
    const dir = new URL('./__goldens__/', import.meta.url)
    expect(render('draft', 'write')).toBe(await readFile(new URL('write-draft-none.md', dir), 'utf8'))
  })
})
