// T58 (F52): notion-token.ts (notionToken) does not exist yet (P26). This file is its contract:
// notionToken({ env, projectRoot, appDir }) returns the first NOTION_TOKEN it finds, in precedence
// order: `env` itself (the process env, already carrying whatever .env files a caller's own
// tooling loaded), then `<appDir>/.env.local`, then `<projectRoot>/.env.local` — the same
// root-then-app order `kit next` resolves other project env files in (packages/kit/src/next.ts),
// with the app's value winning over the root's. It never reads an agent package's own .env.local
// (packages/ai/code-analyzer/agent/lib/knowledge.ts's agentEnv does that for other purposes;
// a token placed only there must not be found here). Returns null when none of the three carries
// one. On a hit, `source` names where it came from: 'env', 'app' or 'root'.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { notionToken } from './notion-token'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** A project root, an app directory under it, and an unrelated agent package directory, each with their own .env.local. */
async function fixture(): Promise<{ projectRoot: string; appDir: string; agentDir: string }> {
  const projectRoot = await tempDir('nt-root-')
  const appDir = join(projectRoot, 'apps', 'web')
  const agentDir = join(projectRoot, 'node_modules', '@aspiralabs', 'spec-writer', 'agent')
  await mkdir(appDir, { recursive: true })
  await mkdir(agentDir, { recursive: true })
  await writeFile(join(projectRoot, '.env.local'), 'NOTION_TOKEN=root-token\n')
  await writeFile(join(appDir, '.env.local'), 'NOTION_TOKEN=app-token\n')
  await writeFile(join(agentDir, '.env.local'), 'NOTION_TOKEN=agent-package-token\n')
  return { projectRoot, appDir, agentDir }
}

describe('notionToken precedence', () => {
  it('prefers the process env over every .env.local file, and names the source', async () => {
    const { projectRoot, appDir } = await fixture()

    const result = await notionToken({ env: { NOTION_TOKEN: 'env-token' }, projectRoot, appDir })

    expect(result).toMatchObject({ token: 'env-token', source: 'env' })
  })

  it('falls back to the app .env.local, then the root .env.local, when env carries none', async () => {
    const { projectRoot, appDir } = await fixture()

    const withApp = await notionToken({ env: {}, projectRoot, appDir })
    expect(withApp).toMatchObject({ token: 'app-token', source: 'app' })

    const rootOnly = await tempDir('nt-root-only-')
    await writeFile(join(rootOnly, '.env.local'), 'NOTION_TOKEN=root-only-token\n')
    const withRoot = await notionToken({ env: {}, projectRoot: rootOnly })
    expect(withRoot).toMatchObject({ token: 'root-only-token', source: 'root' })
  })

  it('never finds a token that exists only in an agent package .env.local', async () => {
    const projectRoot = await tempDir('nt-agent-only-root-')
    const appDir = join(projectRoot, 'apps', 'web')
    const agentDir = join(projectRoot, 'node_modules', '@aspiralabs', 'spec-writer', 'agent')
    await mkdir(appDir, { recursive: true })
    await mkdir(agentDir, { recursive: true })
    // No .env.local at the root or in the app: the only token anywhere sits in the agent package.
    await writeFile(join(agentDir, '.env.local'), 'NOTION_TOKEN=agent-package-token\n')

    const result = await notionToken({ env: {}, projectRoot, appDir })

    expect(result).toBeNull()
  })
})
