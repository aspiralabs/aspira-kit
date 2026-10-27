// KIT-68, F9: with `guidelines` in the client's aspira.json, build-feature builds the per-ticket guidelines folder
// from that folder of markdown files, with no token, no index page and no Notion call, and before each later step
// compares the folder's files (not Notion) against the snapshot: a changed file rebuilds the whole snapshot.
// The config is found by the effective reader from the repo (the client layout: aspira.json above the repo, mapping it).
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ensureKnowledge, knowledgeRecordOf } from '#build-feature/knowledge.ts'
import { emptyRunState } from '#build-feature/run-state.ts'

const temps: string[] = []
afterAll(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** A client root (not a git repo) with aspira.json {guidelines: 'rules', repos: {web}}, a git repo web/ and the rules folder. */
async function client() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'build-feature-guidelines-')))
  temps.push(root)
  const repo = join(root, 'web')
  await mkdir(repo, { recursive: true })
  execFileSync('git', ['init', '-q', repo])
  const rules = join(root, 'rules')
  await mkdir(rules)
  await writeFile(join(rules, '1-rules.md'), '**TS-004 — MUST** validate external data.\n')
  await writeFile(join(rules, '2-review.md'), '**REV-001 — MUST** read AGENTS.md.\n')
  await writeFile(join(root, 'aspira.json'), JSON.stringify({ statusFlow: false, pullRequest: false, guidelines: 'rules', repos: { web: { path: 'web' } } }))
  const folder = join(root, '.work', 'nom-4-x')
  await mkdir(folder, { recursive: true })
  return { root, repo, rules, folder }
}

/** A fetch that fails the test on any call: a guidelines run reaches no Notion API. */
function noNotion() {
  const calls: string[] = []
  const fetch = async (url: string): Promise<Response> => {
    calls.push(url)
    throw new Error(`unexpected Notion call: ${url}`)
  }
  return { calls, fetch }
}

describe('ensureKnowledge with guidelines', () => {
  it('T28 builds the folder snapshot on the first step with no token, no index page and no Notion call', async () => {
    const { repo, folder } = await client()
    const stub = noNotion()
    const result = await ensureKnowledge(emptyRunState(), { env: {}, repo, folder, now: '2026-10-26T00:00:00.000Z', fetch: stub.fetch })
    expect([result.note, result.knowledge, stub.calls]).toEqual([null, { dir: join(folder, 'knowledge'), requiredFile: join(folder, 'knowledge', 'REQUIRED.md') }, []])
    const required = await readFile(join(folder, 'knowledge', 'REQUIRED.md'), 'utf8')
    expect([required.includes('TS-004'), required.includes('REV-001')]).toEqual([true, true])
    expect(knowledgeRecordOf(result.state)).toMatchObject({ dir: join(folder, 'knowledge'), pages: expect.any(Number), rebuilds: 0 })
  })

  it('T28 detects an edited guidelines file against the folder on the second step and rebuilds the snapshot, still with no Notion call', async () => {
    const { repo, rules, folder } = await client()
    const stub = noNotion()
    const input = { env: {}, repo, folder, fetch: stub.fetch }
    const first = await ensureKnowledge(emptyRunState(), { ...input, now: '2026-10-26T00:00:00.000Z' })
    const unchanged = await ensureKnowledge(first.state, { ...input, now: '2026-10-26T01:00:00.000Z' })
    expect([unchanged.knowledge, knowledgeRecordOf(unchanged.state)?.rebuilds, knowledgeRecordOf(unchanged.state)?.builtAt]).toEqual([first.knowledge, 0, '2026-10-26T00:00:00.000Z'])
    await writeFile(join(rules, '1-rules.md'), '**TS-004 — MUST** validate external data.\n\n**TS-009 — MUST** name the boundary.\n')
    const second = await ensureKnowledge(unchanged.state, { ...input, now: '2026-10-26T02:00:00.000Z' })
    expect(second.knowledge).toEqual(first.knowledge)
    expect(await readFile(join(folder, 'knowledge', 'REQUIRED.md'), 'utf8')).toContain('TS-009')
    expect(knowledgeRecordOf(second.state)).toMatchObject({ builtAt: '2026-10-26T02:00:00.000Z', rebuilds: 1 })
    expect(stub.calls).toEqual([])
  })

  it('T28 ignores KNOWLEDGE_PAGE and a token in the environment: the guidelines folder is the only source', async () => {
    const { repo, folder } = await client()
    const stub = noNotion()
    const env = { NOTION_TOKEN: 'secret', KNOWLEDGE_PAGE: 'https://www.notion.so/00000000000000000000000000000000' }
    const result = await ensureKnowledge(emptyRunState(), { env, repo, folder, now: '2026-10-26T00:00:00.000Z', fetch: stub.fetch })
    expect([result.knowledge === null, stub.calls]).toEqual([false, []])
  })
})
