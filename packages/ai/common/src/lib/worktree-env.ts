// Read-only helpers for .ts consumers (visual verify, the build-feature gate, the code analyzer):
// which ticket worktree a checkout is and what the kit wrote into its app env file (KIT-67).
// The compiled kit writes <app>/.env.development.local; this module only reads it.

import { readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { readEffectiveAspira } from './aspira-config.ts'

const ENV_FILE = '.env.development.local'
const envVar = z.union([z.string(), z.looseObject({ name: z.string() })])
const config = z.looseObject({ app: z.string().default('.'), database: z.looseObject({ envVars: z.array(envVar).default([]) }).optional() })

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

/** The app env values and database.envVars names; undefined when aspira.json or the env file is absent. An aspira.json that cannot be read throws, so no caller falls back to the shared database. */
async function appEnv(root: string): Promise<{ values: Record<string, string>; envVars: string[] } | undefined> {
  let parsed: z.infer<typeof config>
  try {
    const effective = readEffectiveAspira(root)
    if (effective.file === undefined) return undefined
    parsed = config.parse(effective.config)
  } catch (error) {
    throw new Error(`aspira.json in ${root} cannot be read (${error instanceof Error ? error.message : String(error)}); refusing to run against the shared database`)
  }
  let text: string
  try {
    text = await readFile(join(root, parsed.app, ENV_FILE), 'utf8')
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
  const values: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined) values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2')
  }
  return { values, envVars: (parsed.database?.envVars ?? []).map((entry) => (typeof entry === 'string' ? entry : entry.name)) }
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
