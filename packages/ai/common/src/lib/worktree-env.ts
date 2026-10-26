// Read-only helpers for .ts consumers (visual verify, the build-feature gate, the code analyzer):
// which ticket worktree a checkout is and what the kit wrote into its app env file (KIT-67).
// The compiled kit writes <app>/.env.development.local; this module only reads it.

import { readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { z } from 'zod'

const ENV_FILE = '.env.development.local'
const config = z.object({ app: z.string().default('.'), database: z.object({ envVars: z.array(z.string()).default([]) }).optional() })

async function appEnv(root: string): Promise<{ values: Record<string, string>; envVars: string[] } | undefined> {
  try {
    const parsed = config.parse(JSON.parse(await readFile(join(root, 'aspira.json'), 'utf8')))
    const values: Record<string, string> = {}
    for (const line of (await readFile(join(root, parsed.app, ENV_FILE), 'utf8')).split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
      if (match?.[1] !== undefined && match[2] !== undefined) values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2')
    }
    return { values, envVars: parsed.database?.envVars ?? [] }
  } catch {
    return undefined
  }
}

/** The lower-case worktree name (the .worktrees/<HANDLE>-<ID> folder without its handle) and the PORT the kit wrote; null outside an isolated worktree. */
export async function worktreeIdentity(root: string): Promise<{ name: string; port: number } | null> {
  const dir = resolve(root)
  if (basename(dirname(dir)) !== '.worktrees') return null
  const folder = basename(dir)
  const name = folder.slice(folder.indexOf('-') + 1).toLowerCase()
  const port = Number((await appEnv(dir))?.values['PORT'])
  if (name === '' || !Number.isInteger(port) || port <= 0) return null
  return { name, port }
}

/** The database.envVars values from the app env file; empty when the file is missing. */
export async function worktreeDatabaseEnv(root: string): Promise<Record<string, string>> {
  const env = await appEnv(resolve(root))
  if (env === undefined) return {}
  return Object.fromEntries(env.envVars.flatMap((name) => (env.values[name] === undefined ? [] : [[name, env.values[name]]])))
}
