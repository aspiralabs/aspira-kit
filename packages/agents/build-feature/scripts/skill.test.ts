// The launcher skill/aspira-build-feature/scripts/build-feature.sh (seam S6) driven with a PATH shim
// that records any node or claude call, the skill's SKILL.md, and the agents README that documents
// the skill-only exception. NOTION_TOKEN is emptied, so no path through the launcher reaches Notion.
// KIT-11 plan P5: T13, T40, T41.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const launcher = join(root, 'skill/aspira-build-feature/scripts/build-feature.sh')
const skill = join(root, 'skill/aspira-build-feature/SKILL.md')
const agentsReadme = join(root, '..', 'README.md')

const temps: string[] = []
afterAll(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** A project with aspira.json, and a bin directory whose node and claude only record that they ran. */
async function sandbox() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'build-feature-skill-')))
  temps.push(dir)
  const repo = join(dir, 'repo')
  const bin = join(dir, 'bin')
  const capture = join(dir, 'calls')
  await mkdir(repo)
  await mkdir(bin)
  await exec('git', ['init', '-q', repo])
  await writeFile(join(repo, 'aspira.json'), JSON.stringify({ board: 'https://app.notion.com/p/3e93e59b225881bba552f8e336ad08ad' }))
  for (const name of ['node', 'claude']) await writeFile(join(bin, name), `#!/bin/bash\necho "${name} $*" >> "$CAPTURE"\necho '{}'\n`, { mode: 0o755 })
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture, BUILD_FEATURE_AGENT_DIR: '', NOTION_TOKEN: '', NOTION_API_KEY: '' }
  return { repo, env, calls: () => readFile(capture, 'utf8').catch(() => '') }
}

const run = (args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
  exec('bash', [launcher, ...args], { cwd, env }).then(
    ({ stdout, stderr }) => ({ code: 0, output: `${stdout}${stderr}` }),
    (error: { code?: number; stdout?: string; stderr?: string }) => ({ code: typeof error.code === 'number' ? error.code : -1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }),
  )

describe('T13 F2 (KIT-51): the launcher runs with or without --cloud', () => {
  it('runs the driver for local with --cloud, passing --cloud through', async () => {
    const { repo, env, calls } = await sandbox()
    const outcome = await run(['local', 'KIT-11', '--cloud'], repo, env)
    const line = (await calls()).split('\n').find((entry) => entry.startsWith('node ')) ?? ''
    expect({ code: outcome.code, driver: line.includes('scripts/local.ts KIT-11'), cloud: line.split(' ').includes('--cloud') }).toEqual({ code: 0, driver: true, cloud: true })
  })

  it('runs the driver for local without a mode flag (each step in this session), passing no --cloud', async () => {
    const { repo, env, calls } = await sandbox()
    const outcome = await run(['local', 'KIT-11'], repo, env)
    const line = (await calls()).split('\n').find((entry) => entry.startsWith('node ')) ?? ''
    expect({ code: outcome.code, refused: /with --cloud/i.test(outcome.output), driver: line.includes('scripts/local.ts KIT-11'), cloud: line.split(' ').includes('--cloud') }).toEqual({ code: 0, refused: false, driver: true, cloud: false })
  })

  it('refuses start, status and wait: the run itself is always this session, and never invokes the driver', async () => {
    const { repo, env, calls } = await sandbox()
    const outcomes = [await run(['start', 'KIT-11'], repo, env), await run(['wait', 'KIT-11'], repo, env)]
    expect({ failed: outcomes.map(({ code }) => code !== 0 && code !== 127), work: existsSync(join(repo, '.work')), calls: await calls() }).toEqual({ failed: [true, true], work: false, calls: '' })
  })
})

describe('T40 F44 F5: SKILL.md is mechanics only', () => {
  it('says it is the one /aspira-* skill that orchestrates other skills and links From Idea to Release and Agent Instructions', async () => {
    const text = await readFile(skill, 'utf8').catch(() => '')
    expect({
      orchestrates: /the one `?\/aspira-\*`? skill that orchestrates other skills instead of launching an agent/i.test(text),
      fromIdeaToRelease: text.includes('https://app.notion.com/p/3e83e59b225881f7ac5aeab5d353beea'),
      agentInstructions: text.includes('https://app.notion.com/p/3e73e59b2258813d9eece6ed89171bd3'),
    }).toEqual({ orchestrates: true, fromIdeaToRelease: true, agentInstructions: true })
  })

  it('copies no step command and no Board rule sentence', async () => {
    const text = await readFile(skill, 'utf8').catch(() => null)
    const copied = ['/aspira-groomer', '/aspira-spec-writer', '/aspira-spec-reviewer', '/aspira-planner', '/aspira-implementor', '/aspira-code-analyzer', '/aspira-pr-reviewer', 'Only a human moves a card into a Ready column', 'No agent does this', 'Stop when nothing critical or high is left']
    expect({ exists: text !== null, copied: copied.filter((phrase) => text?.includes(phrase) === true) }).toEqual({ exists: true, copied: [] })
  })
})

describe('T41 F47: the agents README links the ADR', () => {
  it('links an Architecture Decision Records entry for --take-recommended and the skill-only package exception', async () => {
    const paragraphs = (await readFile(agentsReadme, 'utf8')).split(/\n\s*\n/)
    const adr = paragraphs.filter((paragraph) => /Architecture Decision Record/i.test(paragraph) && /https:\/\/app\.notion\.com\/p\/[0-9a-f]{32}/.test(paragraph))
    expect({ takeRecommended: adr.some((paragraph) => paragraph.includes('--take-recommended')), skillOnly: adr.some((paragraph) => /skill-only/i.test(paragraph)) }).toEqual({ takeRecommended: true, skillOnly: true })
  })
})
