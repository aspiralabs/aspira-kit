import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KnowledgeBlocked, KnowledgeRequired, knowledgeConfig, knowledgeSource, loadKnowledge, snapshotKnowledge } from './local-knowledge.ts'
import { writeSnapshot } from './snapshot.test-helper.ts'

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
    // The shared packages/ai/.env.local, as `pnpm review` loads it.
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

  it('ends blocked on a missing folder with no token to load it, naming NOTION_TOKEN and the files it looked in', async () => {
    const dir = join(await tempDir('spec-writer-knowledge-'), 'knowledge')
    const error = await loadKnowledge(dir, config, { tokenFiles: ['/project/.env.local'] }).then(() => null, (cause: unknown) => cause)
    if (!(error instanceof KnowledgeBlocked)) throw new Error(`expected a blocked run, got ${String(error)}`)
    expect(error).toMatchObject({ pending: false, status: 'blocked', stage: 'knowledge' })
    expect(error.message).toContain('NOTION_TOKEN')
    expect(error.message).toContain('/project/.env.local')
    const noRoot = await loadKnowledge(dir, { ...config, root: null }, { token: 'x', tokenFiles: [] }).then(() => null, (cause: unknown) => cause)
    expect(noRoot).toBeInstanceOf(KnowledgeBlocked)
    expect((noRoot as Error).message).toContain('KNOWLEDGE_PAGE')
  })

  it('takes NOTION_TOKEN from the environment, then the app\'s .env.local, then the project root\'s, never the agent package (F52)', async () => {
    const repo = await tempDir('spec-writer-project-')
    await mkdir(join(repo, 'web'))
    expect(await knowledgeSource(repo, {})).toEqual({ tokenFiles: [join(repo, '.env.local')] })
    await writeFile(join(repo, '.env.local'), 'NOTION_TOKEN=root-token\n')
    expect((await knowledgeSource(repo, {})).token).toBe('root-token')
    await writeFile(join(repo, 'aspira.json'), JSON.stringify({ app: 'web' }))
    await writeFile(join(repo, 'web', '.env.local'), 'NOTION_TOKEN=app-token\n')
    expect(await knowledgeSource(repo, {})).toEqual({ token: 'app-token', tokenFiles: [join(repo, 'web', '.env.local'), join(repo, '.env.local')] })
    expect((await knowledgeSource(repo, { NOTION_TOKEN: 'env-token' })).token).toBe('env-token')
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
    await writeSnapshot(file)
    expect(await snapshotKnowledge(file)).toMatchObject({ source: 'snapshot', path: file, requiredFile: file, files: [{ name: 'rules.md' }] })
  })

  it('refuses a --guidelines file load-knowledge did not write, an edited one, a trace/ copy and one from another root, naming load-knowledge (F50)', async () => {
    const dir = await tempDir('spec-writer-knowledge-')
    const refused = async (file: string, root: string | null = null) => {
      const error = await snapshotKnowledge(file, { root }).then(() => null, (cause: unknown) => cause)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toMatch(/load-knowledge/)
      return (error as Error).message
    }
    const plain = join(dir, 'plain.md')
    await writeFile(plain, 'REV-001 Check the spec')
    expect(await refused(plain)).toContain('provenance header')
    const edited = join(dir, 'edited.md')
    await writeFile(edited, (await writeSnapshot(edited)).replace('REV-001 Check the spec', 'REV-001 Skip the spec'))
    expect(await refused(edited)).toContain('edited')
    await mkdir(join(dir, 'trace'))
    const traced = join(dir, 'trace', 'guidelines.md')
    await writeSnapshot(traced)
    expect(await refused(traced)).toContain('trace/')
    const other = join(dir, 'other.md')
    await writeSnapshot(other)
    expect(await refused(other, 'https://www.notion.so/Elsewhere-99999999999999999999999999999999')).toContain('configured for root')
  })
})
