// worktree-env.ts is created by KIT-67 (P2): this file is its contract, written before the module.
// T3: the read-only helpers that tell a .ts consumer which ticket worktree it runs in, on which
// PORT, and which database variables the kit wrote for it. Nothing is mocked: real temp
// directories laid out as a main checkout with .worktrees/<HANDLE>-<ID>/ stand in for the boundary.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { worktreeDatabaseEnv, worktreeIdentity } from './worktree-env.ts'

const temps: string[] = []
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

const AUTH = JSON.stringify({ app: 'web', database: { provider: 'neon', projectId: 'p', parentBranch: 'dev', envVars: ['DATABASE_URL'] } })

/** A checkout at `root` with aspira.json and the app folder; the env file only when given. */
async function checkout(root: string, envFile?: string): Promise<string> {
  await mkdir(join(root, 'web'), { recursive: true })
  await writeFile(join(root, 'aspira.json'), AUTH)
  if (envFile !== undefined) await writeFile(join(root, 'web', '.env.development.local'), envFile)
  return root
}

async function main(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'worktree-env-'))
  temps.push(dir)
  return dir
}

describe('worktree identity (T3, F10, F13)', () => {
  it('reads the lower-case name without the handle prefix and the PORT of a ticket worktree', async () => {
    const root = await checkout(join(await main(), '.worktrees', 'FEATURE-SCOOP-7'), 'PORT=3003\nDATABASE_URL=postgres://branch\n')
    const identity = await worktreeIdentity(root)
    expect({ name: identity?.name, port: identity?.port }).toEqual({ name: 'scoop-7', port: 3003 })
  })

  it('yields no port for a checkout without an env file, so callers treat it as not isolated', async () => {
    const root = await checkout(await main())
    expect((await worktreeIdentity(root))?.port).toBeUndefined()
  })

  it('yields no port when the env file has no PORT line', async () => {
    const root = await checkout(join(await main(), '.worktrees', 'FEATURE-SCOOP-7'), 'DATABASE_URL=postgres://branch\n')
    expect((await worktreeIdentity(root))?.port).toBeUndefined()
  })
})

const POOLED_AUTH = JSON.stringify({
  app: 'web',
  database: { provider: 'neon', projectId: 'p', parentBranch: 'dev', envVars: ['DATABASE_URL', { name: 'DIRECT_URL', pooled: false }] },
})

describe('worktree database variables (T3, F10)', () => {
  it('returns the database.envVars values from the app env file', async () => {
    const root = await checkout(join(await main(), '.worktrees', 'FEATURE-SCOOP-7'), 'PORT=3003\nDATABASE_URL=postgres://branch\nOTHER=x\n')
    expect(await worktreeDatabaseEnv(root)).toEqual({ DATABASE_URL: 'postgres://branch' })
  })

  it('returns no variables for a checkout without an env file', async () => {
    const root = await checkout(await main())
    expect(await worktreeDatabaseEnv(root)).toEqual({})
  })

  it('reads both URLs when database.envVars mixes a name and a { name, pooled } entry', async () => {
    const root = join(await main(), '.worktrees', 'FEATURE-SCOOP-7')
    await mkdir(join(root, 'web'), { recursive: true })
    await writeFile(join(root, 'aspira.json'), POOLED_AUTH)
    await writeFile(join(root, 'web', '.env.development.local'), 'PORT=3003\nDATABASE_URL=postgres://pooled\nDIRECT_URL=postgres://direct\n')
    expect(await worktreeIdentity(root)).toEqual({ name: 'scoop-7', port: 3003 })
    expect(await worktreeDatabaseEnv(root)).toEqual({ DATABASE_URL: 'postgres://pooled', DIRECT_URL: 'postgres://direct' })
  })

  it('refuses, rather than falling back to the shared database, when a worktree aspira.json cannot be read', async () => {
    const root = join(await main(), '.worktrees', 'FEATURE-SCOOP-7')
    await mkdir(join(root, 'web'), { recursive: true })
    await writeFile(join(root, 'aspira.json'), '{ not json')
    await writeFile(join(root, 'web', '.env.development.local'), 'PORT=3003\n')
    await expect(worktreeDatabaseEnv(root)).rejects.toThrow(/aspira\.json/)
  })
})
