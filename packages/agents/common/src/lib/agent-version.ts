// Which build of an agent ran: its package name and version, where it was loaded from, and whether
// that is an installed package (under node_modules) or a kit source checkout. The --local drivers
// print it with every step and write it into the export's trace, so a report always says which
// agent version produced it.

import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The agent package that is running. */
export type AgentVersion = { name: string; version: string; path: string; installed: boolean }

/** The file name the version is recorded under, in an export's trace/ (or its root when there is no trace/). */
export const AGENT_VERSION_FILE = 'agent-version.json'

/** Read the package at `packageDir` (a path or a file URL, as `new URL('..', import.meta.url)`). */
export async function agentVersion(packageDir: string | URL): Promise<AgentVersion> {
  const dir = (typeof packageDir === 'string' ? packageDir : fileURLToPath(packageDir)).replace(/(.)\/+$/, '$1')
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
  const name = typeof manifest.name === 'string' ? manifest.name : '(unnamed)'
  const version = typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  return { name, version, path: dir, installed: /(^|\/)node_modules\//.test(`${dir}/`) }
}

/** Write the version into an export: `<dir>/trace/agent-version.json` when the export has a trace/, else `<dir>/agent-version.json`. Returns the file written, or null when `dir` does not exist. */
export async function recordAgentVersion(dir: string, agent: AgentVersion): Promise<string | null> {
  if (!(await stat(dir).then((s) => s.isDirectory(), () => false))) return null
  const trace = join(dir, 'trace')
  const file = join((await stat(trace).then((s) => s.isDirectory(), () => false)) ? trace : dir, AGENT_VERSION_FILE)
  await writeFile(file, `${JSON.stringify({ ...agent, recordedAt: new Date().toISOString() }, null, 2)}\n`)
  return file
}
