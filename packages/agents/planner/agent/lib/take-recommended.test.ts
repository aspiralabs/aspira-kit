// T9: --take-recommended at the planner's --local export seam (agent/lib/local.ts runLocal). With
// the flag, every decision mergeDecisions leaves open (KIT-11 F10) is taken as the agent's: recorded
// decidedBy 'agent' with its recommended option, so export status is 'ready' instead of
// 'needs-author'. Without the flag, behavior is unchanged (regression). A decision the agent took
// stays the agent's on a later export that reads its own tick back from trace/decisions.md: it is
// never promoted to the author's, the way a real tick would be (applyAnswers, plan.ts:102-108).
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { files, spec, validPlan } from './fixtures.test-helper.ts'
import { runLocal, type LocalInput, type LocalPending, type LocalResult } from './local.ts'

const exec = promisify(execFile)
const ROOT = 'https://app.notion.com/p/11111111111111111111111111111111'
const INSTRUCTIONS = 'https://app.notion.com/p/22222222222222222222222222222222'
const TOPIC_A = 'https://app.notion.com/p/33333333333333333333333333333333'
const TOPIC_B = 'https://app.notion.com/p/44444444444444444444444444444444'
const RULES = 'REV-001 Inspect source evidence'

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'planner-take-recommended-')))
  const repo = join(dir, 'repo')
  await mkdir(join(repo, 'src'), { recursive: true })
  await mkdir(join(repo, 'tests'), { recursive: true })
  for (const [path, text] of files) await writeFile(join(repo, path), text)
  await exec('git', ['init', '-q', repo])
  await exec('git', ['-C', repo, 'add', '.'])
  await exec('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'])
  const specPath = join(dir, 'feature', 'spec.reviewed', 'spec.reviewed.md')
  await mkdir(join(dir, 'feature', 'spec.reviewed'), { recursive: true })
  await writeFile(specPath, spec)
  const outputDir = join(dir, 'out', 'plan.review')
  return { dir, repo, specPath, outputDir, work: `${outputDir}.local`, knowledge: `${outputDir}.local/knowledge` }
}

const header = (title: string, url: string) => `<!-- ${title} · ${url} · fetched 2026-10-05T00:00:00.000Z -->\n\n`

/** What the session writes from Notion: the index, the required pages, then the topics they route to. */
async function writeKnowledge(knowledge: string) {
  await mkdir(knowledge, { recursive: true })
  await writeFile(join(knowledge, 'INDEX.md'), `${header('Engineering', ROOT)}<page url="${INSTRUCTIONS}">Agent Instructions</page>\n`)
  await writeFile(join(knowledge, 'REQUIRED.md'), [
    '<!-- Required reading · 2 pages · fetched 2026-10-05T00:00:00.000Z -->', '', '---', '', '# Agent Instructions', '', `<!-- ${INSTRUCTIONS} -->`, '',
    `| Any code change | <mention-page url="${TOPIC_A}"/> |`, `| API work | <page url="${TOPIC_B}">API Design</page> |`, '', '---', '', '# Review Verification', '', '<!-- https://app.notion.com/p/55555555555555555555555555555555 -->', '', RULES, '',
  ].join('\n'))
  await writeFile(join(knowledge, 'testing-standards.md'), `${header('Testing Standards', TOPIC_A)}TEST-001 Write the failing test first.\n`)
  await writeFile(join(knowledge, 'api-design.md'), `${header('API Design', TOPIC_B)}API-001 Version every route.\n`)
}

const env = { KNOWLEDGE_PAGE: ROOT }
function pending(result: LocalResult): LocalPending {
  if (!result.pending) throw new Error(`expected a pending stage, got ${result.status}`)
  return result
}

/** Two decisions in the decisionSchema shape (plan.ts T9): neither the author nor the agent has answered either yet. */
const decisionA = { question: 'Do saved items expire?', options: ['Keep forever', 'Expire after 30 days'], recommended: 'Keep forever', reasoning: 'cookbooks already keep everything until removed', whyYours: 'it decides what members pay storage for' }
const decisionB = { question: 'Who can see a saved list?', options: ['Share with the team', 'Keep it private'], recommended: 'Share with the team', reasoning: 'shared editing is the norm', whyYours: 'it changes what members expect to be private' }

/** Drives a fixture through research and planning with the two decisions above, to export. */
async function exportWithDecisions(input: LocalInput, env: Record<string, string>) {
  const research = pending(await runLocal(input, { env }))
  await writeFile(research.tasks[0]!.output, JSON.stringify({ facts: ['src/items.ts:1 establishes save'], checks: [{ rule: 'REV-001', evidence: 'src/items.ts:1' }], gaps: [], decisions: [decisionA, decisionB] }))
  const planning = pending(await runLocal(input, { env }))
  await writeFile(planning.tasks[0]!.output, JSON.stringify(validPlan()))
  const done = await runLocal(input, { env })
  if (done.pending) throw new Error('expected an export')
  return done
}

it('takes every open decision as the agent\'s recommended option with --take-recommended, so the plan exports ready', async () => {
  const f = await fixture()
  await writeKnowledge(f.knowledge)
  const input: LocalInput & { takeRecommended: boolean } = { specPath: f.specPath, repoPath: f.repo, outputDir: f.outputDir, takeRecommended: true }
  const done = await exportWithDecisions(input, env)

  expect(done.status).toBe('ready')
  expect(done.decisions).toHaveLength(2)
  for (const decision of done.decisions) expect(decision).toMatchObject({ decidedBy: 'agent', answer: decision.recommended })

  const review = JSON.parse(await readFile(join(f.outputDir, 'trace/review.json'), 'utf8')) as { status: string; decisions: { decidedBy: string; answer: string; recommended: string }[] }
  expect(review.status).toBe('ready')
  for (const decision of review.decisions) expect(decision).toMatchObject({ decidedBy: 'agent', answer: decision.recommended })

  const decisionsMd = await readFile(join(f.outputDir, 'trace/decisions.md'), 'utf8')
  expect(decisionsMd.match(/Tick another option to reverse it\./g)).toHaveLength(2)
})

it('leaves every decision open without --take-recommended (regression)', async () => {
  const f = await fixture()
  await writeKnowledge(f.knowledge)
  const input: LocalInput = { specPath: f.specPath, repoPath: f.repo, outputDir: f.outputDir }
  const done = await exportWithDecisions(input, env)

  expect(done.status).toBe('needs-author')
  expect(done.decisions).toHaveLength(2)
  for (const decision of done.decisions) expect(decision).toMatchObject({ decidedBy: 'open', answer: null })
})

it('keeps an agent-taken decision as the agent\'s on a second --take-recommended export, never promoting its own tick to the author\'s', async () => {
  const f = await fixture()
  await writeKnowledge(f.knowledge)
  const input: LocalInput & { takeRecommended: boolean } = { specPath: f.specPath, repoPath: f.repo, outputDir: f.outputDir, takeRecommended: true }
  const first = await exportWithDecisions(input, env)
  expect(first.status).toBe('ready')

  // A second export of the same spec, reading the first run's trace/decisions.md back as its answers.
  const second = await exportWithDecisions(input, env)
  expect(second.status).toBe('ready')
  for (const decision of second.decisions) expect(decision.decidedBy).toBe('agent')
  expect(second.decisions.some((decision) => decision.decidedBy === 'author')).toBe(false)
})
