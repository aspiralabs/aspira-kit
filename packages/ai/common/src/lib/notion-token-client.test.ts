// T42 (F19): on a client run the Notion token comes from the process env, then the client root's .env.local, and
// never from a client repo's own .env.local. The root a caller passes is the one the effective reader returns for
// the repo it works in (the client root, not the repo), with no appDir.

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readEffectiveAspira } from './aspira-config.ts'
import { notionToken } from './notion-token'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()))
})

/** A non-git client root with aspira.json mapping web/, a .env.local with a token, and web/ (a git repo) with another. */
async function client(): Promise<{ root: string; repo: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nt-client-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const repo = join(root, 'web')
  await mkdir(repo)
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  await writeFile(join(root, 'aspira.json'), JSON.stringify({ statusFlow: false, pullRequest: false, repos: { web: { path: 'web' } } }))
  await writeFile(join(root, '.env.local'), 'NOTION_TOKEN=client-token\n')
  await writeFile(join(repo, '.env.local'), 'NOTION_TOKEN=repo-token\n')
  return { root, repo }
}

describe('T42 F19: notionToken on a client run', () => {
  it('returns the env token when env carries one, and the client root token when it does not', async () => {
    const { root, repo } = await client()
    const projectRoot = readEffectiveAspira(repo).root
    expect(projectRoot).toBe(root)

    const fromEnv = await notionToken({ env: { NOTION_TOKEN: 'env-token' }, projectRoot: projectRoot ?? repo })
    const fromRoot = await notionToken({ env: {}, projectRoot: projectRoot ?? repo })

    expect({ fromEnv, fromRoot }).toEqual({
      fromEnv: { token: 'env-token', source: 'env' },
      fromRoot: { token: 'client-token', source: 'root' },
    })
  })

  it('never returns the repo token, even from inside the repo', async () => {
    const { repo } = await client()
    const projectRoot = readEffectiveAspira(repo).root
    const found = await notionToken({ env: {}, projectRoot: projectRoot ?? repo })
    expect(found?.token).not.toBe('repo-token')
  })
})
