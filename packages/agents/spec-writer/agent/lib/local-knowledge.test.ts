import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KnowledgeRequired, knowledgeConfig, loadKnowledge, snapshotKnowledge } from './local-knowledge.ts'

const REQUIRED_MD = '# Agent Instructions\n\nREV-001 Read the rules.\n\n---\n\n# Review Verification\n\nREV-002 Verify.\n'
const ROOT = 'https://www.notion.so/Engineering-0123456789abcdef0123456789abcdef'

async function tempDir(prefix: string) {
  return realpath(await mkdtemp(join(tmpdir(), prefix)))
}

async function refusal(promise: Promise<unknown>): Promise<KnowledgeRequired> {
  const error = await promise.then(() => null, (cause: unknown) => cause)
  if (!(error instanceof KnowledgeRequired)) throw new Error(`expected a KnowledgeRequired refusal, got ${String(error)}`)
  return error
}

describe('knowledgeConfig', () => {
  it('reads the pages from the agent\'s own env files, as load-knowledge would, and never the token', async () => {
    const agentDir = join(await tempDir('spec-writer-agent-'), 'spec-writer')
    await mkdir(agentDir)
    expect(await knowledgeConfig(agentDir, {})).toEqual({ root: null, required: ['Agent Instructions', 'Review Verification'], maxDepth: 3, maxPages: 80 })
    // The shared packages/agents/.env.local, as `pnpm review` loads it.
    await writeFile(join(agentDir, '..', '.env.local'), `AI_GATEWAY_API_KEY=x\nKNOWLEDGE_PAGE=${ROOT}\nNOTION_TOKEN=secret\n`)
    expect(await knowledgeConfig(agentDir, {})).toMatchObject({ root: ROOT, required: ['Agent Instructions', 'Review Verification'] })
    await writeFile(join(agentDir, '.env.development.local'), 'KNOWLEDGE_REQUIRED="Agent Instructions, Security Rules"\n')
    expect((await knowledgeConfig(agentDir, {})).required).toEqual(['Agent Instructions', 'Security Rules'])
    expect((await knowledgeConfig(agentDir, { KNOWLEDGE_REQUIRED: 'Only This' })).required).toEqual(['Only This'])
    expect(JSON.stringify(await knowledgeConfig(agentDir, {}))).not.toContain('secret')
  })
})

describe('loadKnowledge', () => {
  const config = { root: ROOT, required: ['Agent Instructions', 'Review Verification'], maxDepth: 3, maxPages: 80 }

  it('refuses a missing folder with the page list to fetch', async () => {
    const dir = join(await tempDir('spec-writer-knowledge-'), 'knowledge')
    const error = await refusal(loadKnowledge(dir, config))
    expect(error.message).toContain('REQUIRED.md')
    expect(error.plan).toMatchObject({ dir, root: ROOT, required: config.required, maxDepth: 3, maxPages: 80, files: { required: 'REQUIRED.md', index: 'INDEX.md' } })
  })

  it('refuses an empty index, a missing required page and a truncated page', async () => {
    const dir = await tempDir('spec-writer-knowledge-')
    await writeFile(join(dir, 'REQUIRED.md'), REQUIRED_MD)
    await writeFile(join(dir, 'INDEX.md'), '  \n')
    expect((await refusal(loadKnowledge(dir, config))).message).toContain('INDEX.md')
    await writeFile(join(dir, 'INDEX.md'), '# Engineering\n')
    await writeFile(join(dir, 'REQUIRED.md'), '# Agent Instructions\n\nREV-001\n')
    expect((await refusal(loadKnowledge(dir, config))).message).toContain('Review Verification')
    await writeFile(join(dir, 'REQUIRED.md'), REQUIRED_MD)
    await writeFile(join(dir, 'testing.md'), '<!-- Testing · url · fetched now · TRUNCATED by the Notion API, read the source for the rest -->\n')
    expect((await refusal(loadKnowledge(dir, config))).message).toContain('testing.md')
  })

  it('accepts a complete folder and fingerprints every file in it', async () => {
    const dir = await tempDir('spec-writer-knowledge-')
    await writeFile(join(dir, 'REQUIRED.md'), REQUIRED_MD)
    await writeFile(join(dir, 'INDEX.md'), '# Engineering\n')
    await writeFile(join(dir, 'testing.md'), '# Testing\n\nTST-001 Tests first.\n')
    const first = await loadKnowledge(dir, config)
    expect(first).toMatchObject({ source: 'folder', path: dir, requiredFile: join(dir, 'REQUIRED.md') })
    expect(first.files.map((file) => file.name)).toEqual(['INDEX.md', 'REQUIRED.md', 'testing.md'])
    await writeFile(join(dir, 'testing.md'), '# Testing\n\nTST-001 Tests last.\n')
    expect((await loadKnowledge(dir, config)).digest).not.toBe(first.digest)
  })

  it('records a --guidelines snapshot as the rules used', async () => {
    const dir = await tempDir('spec-writer-knowledge-')
    const file = join(dir, 'rules.md')
    await writeFile(file, 'REV-001 Check the spec')
    expect(await snapshotKnowledge(file)).toMatchObject({ source: 'snapshot', path: file, requiredFile: file, files: [{ name: 'rules.md' }] })
  })
})
