// Pins the code analyzer's model-fix prompts (fixPrompt, systemPrompt) for the three configs an Aspira product can
// have (KIT-68 F1); the goldens under __goldens__/ were recorded at 7797a62.
// There is no extend entry for this stage.
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Batch } from './diagnostics.ts'
import { fixPrompt, systemPrompt } from './fixer.ts'

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

/** A temp folder with no aspira.json above it, holding a git repo; an aspira.json at the repo root when the config has one. */
async function fixture(config: Record<string, unknown> | null) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'code-analyzer-harness-')))
  roots.push(root)
  const repo = join(root, 'repo')
  await mkdir(repo)
  execFileSync('git', ['init', '-q', repo])
  if (config !== null) await write(join(repo, 'aspira.json'), `${JSON.stringify(config, null, 2)}\n`)
  process.chdir(repo)
  const knowledgeDir = join(repo, '.work', 'kit-9-cart-limit', 'analyzer.local', 'knowledge')
  const knowledge = { path: knowledgeDir, requiredFile: join(knowledgeDir, 'REQUIRED.md'), required: '# Agent Instructions\n\nTS-004 No suppressions.\n' }
  const batch: Batch = {
    files: ['src/cart.ts'],
    diagnostics: [
      { tool: 'eslint', file: 'src/cart.ts', line: 3, column: 7, message: "'LIMIT' is assigned a value but never used.", rule: 'no-unused-vars', severity: 'error' },
      { tool: 'tsc', file: 'src/cart.ts', line: 9, column: null, message: "Type 'string' is not assignable to type 'number'.", rule: null, severity: 'error' },
    ],
  }
  const excerpts = ['FILE src/cart.ts (3 lines, complete)\n1: import x from "x"\n2: \n3: const LIMIT = 10']
  const normalize = (text: string) => text.replaceAll(root, '<root>')
  const render = () => ({ fix: normalize(fixPrompt({ instructions: '# Project\n\nUse pnpm.\n', batch, excerpts, knowledge })), system: normalize(systemPrompt) })
  return { root, render }
}

const golden = (name: string) => `./__goldens__/${name}.md`

describe('F1: the model-fix prompts are byte-identical for the three configs (goldens recorded at 7797a62)', () => {
  it.each(Object.keys(CONFIGS))('renders fixPrompt and systemPrompt under the %s config', async (name) => {
    const { render } = await fixture(CONFIGS[name]!)
    const { fix, system } = render()
    await expect(fix).toMatchFileSnapshot(golden(`fix-${name}`))
    await expect(system).toMatchFileSnapshot(golden(`system-${name}`))
  })
})
