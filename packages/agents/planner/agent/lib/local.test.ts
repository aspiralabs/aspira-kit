import { execFile } from 'node:child_process'
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { DEFAULT_REQUIRED, MAX_DEPTH, MAX_PAGES } from '@aspiralabs/agent-common/lib/knowledge'
import { expect, it } from 'vitest'
import { files, spec, validPlan } from './fixtures.test-helper.ts'
import { runLocal, type LocalPending, type LocalResult } from './local.ts'
import { planningInstructions, researchInstructions, system } from './prompts.ts'

const exec = promisify(execFile)
const PACKAGE_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const ROOT = 'https://app.notion.com/p/11111111111111111111111111111111'
const INSTRUCTIONS = 'https://app.notion.com/p/22222222222222222222222222222222'
const TOPIC_A = 'https://app.notion.com/p/33333333333333333333333333333333'
const TOPIC_B = 'https://app.notion.com/p/44444444444444444444444444444444'
const RULES = 'REV-001 Inspect source evidence'

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'planner-local-')))
  const repo = join(dir, 'repo')
  await mkdir(join(repo, 'src'), { recursive: true })
  await mkdir(join(repo, 'tests'), { recursive: true })
  for (const [path, text] of files) await writeFile(join(repo, path), text)
  await exec('git', ['init', '-q', repo])
  await exec('git', ['-C', repo, 'add', '.'])
  await exec('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'])
  const specPath = join(dir, 'feature', 'spec.reviewed', 'spec.reviewed.md')
  await mkdir(dirname(specPath), { recursive: true })
  await writeFile(specPath, spec)
  const outputDir = join(dir, 'out', 'plan.review')
  return { dir, repo, specPath, outputDir, work: `${outputDir}.local`, knowledge: `${outputDir}.local/knowledge` }
}

const header = (title: string, url: string) => `<!-- ${title} · ${url} · fetched 2026-10-05T00:00:00.000Z -->\n\n`

/** What the session writes from Notion: the index, the required pages, then the topics they route to. */
async function writeKnowledge(knowledge: string, topics = true) {
  await mkdir(knowledge, { recursive: true })
  await writeFile(join(knowledge, 'INDEX.md'), `${header('Engineering', ROOT)}<page url="${INSTRUCTIONS}">Agent Instructions</page>\n`)
  await writeFile(join(knowledge, 'REQUIRED.md'), [
    '<!-- Required reading · 2 pages · fetched 2026-10-05T00:00:00.000Z -->', '', '---', '', '# Agent Instructions', '', `<!-- ${INSTRUCTIONS} -->`, '',
    `| Any code change | <mention-page url="${TOPIC_A}"/> |`, `| API work | <page url="${TOPIC_B}">API Design</page> |`, '', '---', '', '# Review Verification', '', '<!-- https://app.notion.com/p/55555555555555555555555555555555 -->', '', RULES, '',
  ].join('\n'))
  if (!topics) return
  await writeFile(join(knowledge, 'testing-standards.md'), `${header('Testing Standards', TOPIC_A)}TEST-001 Write the failing test first.\n`)
  await writeFile(join(knowledge, 'api-design.md'), `${header('API Design', TOPIC_B)}API-001 Version every route.\n`)
}

const env = { KNOWLEDGE_PAGE: ROOT }
function pending(result: LocalResult): LocalPending {
  if (!result.pending) throw new Error(`expected a pending stage, got ${result.status}`)
  return result
}

it('refuses to start without knowledge, and prints the knowledge stage before any model stage', async () => {
  const f = await fixture()
  await expect(runLocal({ specPath: f.specPath, repoPath: f.repo, outputDir: f.outputDir }, { env: {} })).rejects.toThrow('KNOWLEDGE_PAGE')
  const first = pending(await runLocal({ specPath: f.specPath, repoPath: f.repo, outputDir: f.outputDir }, { env }))
  expect(first.stage).toBe('knowledge')
  expect(first.tasks).toEqual([])
  await expect(readdir(join(f.work, 'outputs'))).rejects.toThrow()
  await expect(runLocal({ specPath: f.specPath, repoPath: f.repo, outputDir: f.outputDir, finish: true }, { env })).rejects.toThrow('knowledge')
  // A truncated required page is not knowledge either.
  await writeKnowledge(f.knowledge)
  await writeFile(join(f.knowledge, 'REQUIRED.md'), `${await readFile(join(f.knowledge, 'REQUIRED.md'), 'utf8')}\nTRUNCATED by the Notion API\n`)
  const truncated = pending(await runLocal({ specPath: f.specPath, repoPath: f.repo, outputDir: f.outputDir }, { env }))
  expect(truncated.stage).toBe('knowledge')
  expect(truncated.knowledge?.problems.join(' ')).toContain('REQUIRED.md')
})

it('lists the pages the agent\'s own knowledge configuration loads: index, required, then the topics they route to', async () => {
  const f = await fixture()
  const byDefault = pending(await runLocal({ specPath: f.specPath, repoPath: f.repo, outputDir: f.outputDir }, { env }))
  expect(byDefault.knowledge?.config).toEqual({ page: ROOT, required: DEFAULT_REQUIRED, maxDepth: MAX_DEPTH, maxPages: MAX_PAGES })
  expect(byDefault.knowledge?.pages.map((page) => [page.role, page.title])).toEqual([['index', 'Engineering index (KNOWLEDGE_PAGE)'], ...DEFAULT_REQUIRED.map((title) => ['required', title])])
  const custom = pending(await runLocal({ specPath: f.specPath, repoPath: f.repo, outputDir: f.outputDir }, { env: { ...env, KNOWLEDGE_REQUIRED: 'Alpha, Beta' } }))
  expect(custom.knowledge?.config.required).toEqual(['Alpha', 'Beta'])
  await writeKnowledge(f.knowledge, false)
  const topics = pending(await runLocal({ specPath: f.specPath, repoPath: f.repo, outputDir: f.outputDir }, { env }))
  expect(topics.stage).toBe('knowledge')
  expect(topics.knowledge?.pages.map((page) => [page.role, page.url])).toEqual([['topic', TOPIC_A], ['topic', TOPIC_B]])
  await writeKnowledge(f.knowledge)
  expect(pending(await runLocal({ specPath: f.specPath, repoPath: f.repo, outputDir: f.outputDir }, { env })).stage).toBe('research')
})

it('writes prompt files from the live agent files, so editing the agent changes them', async () => {
  const f = await fixture()
  await writeKnowledge(f.knowledge)
  const research = pending(await runLocal({ specPath: f.specPath, repoPath: f.repo, outputDir: f.outputDir }, { env }))
  expect(research.stage).toBe('research')
  const prompt = await readFile(research.tasks[0]!.prompt, 'utf8')
  expect(prompt).toContain(`## System\n\n${system}\n`)
  expect(prompt).toContain(`REQUIRED GUIDELINES:\n${await readFile(join(f.knowledge, 'REQUIRED.md'), 'utf8')}`)
  expect(prompt).toContain(`\n\n${researchInstructions}\n`)
  expect(prompt).toContain(join(f.knowledge, 'api-design.md'))
  const router = await readFile(research.router, 'utf8')
  expect(router).toContain(await readFile(join(PACKAGE_DIR, 'agent/instructions.md'), 'utf8'))

  // A copy of the agent with edited instruction files: the next prompt files follow the edit.
  const edited = join(f.dir, 'agent-copy')
  await cp(join(PACKAGE_DIR, 'agent'), join(edited, 'agent'), { recursive: true })
  await writeFile(join(edited, 'agent/lib/prompts.ts'), (await readFile(join(PACKAGE_DIR, 'agent/lib/prompts.ts'), 'utf8')).replace('Finish with submit_research.', 'Finish with submit_research. EDITED RESEARCH RULE.'))
  await writeFile(join(edited, 'agent/instructions.md'), 'EDITED ROUTER RULE.\n')
  const again = pending(await runLocal({ specPath: f.specPath, repoPath: f.repo, outputDir: f.outputDir }, { env, packageDir: edited }))
  expect(await readFile(again.tasks[0]!.prompt, 'utf8')).toContain('EDITED RESEARCH RULE.')
  expect(await readFile(again.router, 'utf8')).toContain('EDITED ROUTER RULE.')
  expect(await readFile(again.router, 'utf8')).not.toContain('You route planner requests.')
})

it('validates outputs against the agent schemas, refuses a mid-run knowledge change, and exports like the agent', async () => {
  const f = await fixture()
  await writeKnowledge(f.knowledge)
  const research = pending(await runLocal({ specPath: f.specPath, repoPath: f.repo, outputDir: f.outputDir }, { env }))
  const task = research.tasks[0]!
  await writeFile(task.output, JSON.stringify({ facts: 'not a list' }))
  const retry = pending(await runLocal({ specPath: f.specPath, repoPath: f.repo, outputDir: f.outputDir }, { env }))
  expect(retry.tasks[0]).toMatchObject({ id: 'research', retry: true })
  expect(retry.tasks[0]!.error).toBeTruthy()
  expect(await readdir(join(f.work, 'outputs'))).toContain('research.rejected-1.json')

  const evidence = { facts: ['src/items.ts:1 establishes save'], checks: [{ rule: 'REV-001', evidence: 'src/items.ts:1' }], gaps: [], decisions: [] }
  await writeFile(task.output, JSON.stringify(evidence))
  const planning = pending(await runLocal({ specPath: f.specPath, repoPath: f.repo, outputDir: f.outputDir }, { env }))
  expect(planning.stage).toBe('planning')
  const planPrompt = await readFile(planning.tasks[0]!.prompt, 'utf8')
  expect(planPrompt).toContain(`\n\nRESEARCH:\n${JSON.stringify(evidence)}\n\n${planningInstructions}\n`)

  const original = await readFile(join(f.knowledge, 'api-design.md'), 'utf8')
  await writeFile(join(f.knowledge, 'api-design.md'), `${original}API-002 Added mid-run.\n`)
  await expect(runLocal({ specPath: f.specPath, repoPath: f.repo, outputDir: f.outputDir }, { env })).rejects.toThrow('knowledge changed')
  await writeFile(join(f.knowledge, 'api-design.md'), original)

  await writeFile(planning.tasks[0]!.output, JSON.stringify(validPlan()))
  const done = await runLocal({ specPath: f.specPath, repoPath: f.repo, outputDir: f.outputDir }, { env })
  if (done.pending) throw new Error('expected export')
  expect(done.status).toBe('ready')
  expect((await readdir(f.outputDir)).sort()).toEqual(['plan.reviewed.md', 'run-analysis.md', 'trace'])
  const knowledge = JSON.parse(await readFile(join(f.outputDir, 'trace/knowledge.json'), 'utf8')) as { source: string; pages: { url: string }[] }
  expect(knowledge.source).toBe('notion')
  expect(knowledge.pages.map((page) => page.url)).toEqual(expect.arrayContaining([ROOT, INSTRUCTIONS, TOPIC_A, TOPIC_B]))
  expect(await readFile(join(f.outputDir, 'trace/knowledge/api-design.md'), 'utf8')).toBe(original)
  const review = JSON.parse(await readFile(join(f.outputDir, 'trace/review.json'), 'utf8')) as { mode: string; status: string }
  expect(review).toMatchObject({ mode: 'local', status: 'ready' })
  await expect(access(f.work)).rejects.toThrow()
})

it('takes a --guidelines snapshot instead of Notion, and --finish exports a missing stage as incomplete', async () => {
  const f = await fixture()
  const snapshot = join(f.dir, 'REQUIRED.md')
  await writeFile(snapshot, RULES)
  const research = pending(await runLocal({ specPath: f.specPath, repoPath: f.repo, outputDir: f.outputDir, guidelinesPath: snapshot }, { env: {} }))
  expect(research.stage).toBe('research')
  await writeFile(research.tasks[0]!.output, JSON.stringify({ facts: [], checks: [{ rule: 'REV-001', evidence: 'src/items.ts:1' }], gaps: [], decisions: [] }))
  const done = await runLocal({ specPath: f.specPath, repoPath: f.repo, outputDir: f.outputDir, guidelinesPath: snapshot, finish: true }, { env: {} })
  if (done.pending) throw new Error('expected export')
  expect(done.status).toBe('incomplete')
  expect(done.problems).toContain('planning: no output was produced in the session')
  expect(done.problems).toContain('No structured plan produced')
  expect(JSON.parse(await readFile(join(f.outputDir, 'trace/knowledge.json'), 'utf8'))).toMatchObject({ source: 'snapshot', snapshot })
})
