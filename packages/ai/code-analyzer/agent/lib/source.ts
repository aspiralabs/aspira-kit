import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { shellQuote } from './executor.ts'

const exec = promisify(execFile)
/** Where a run's code comes from. A local `root` is the directory that was named (the analyzed project, which may sit below `gitRoot`). */
export type Source = { kind: 'local'; root: string; gitRoot: string } | { kind: 'remote'; owner: string; name: string; url: string; label: string }

const GITHUB_HTTPS = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/
const GITHUB_SSH = /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/
const SHORTHAND = /^([\w.-]+)\/([\w.-]+)$/

/**
 * Classifies what the caller typed. A local path is analyzed as itself: a subdirectory of a
 * repository (one app of several, with no root manifest) is the project, not its git root.
 * It must still be inside a git repository, which lists its files and backs `search`.
 */
export async function parseSource(input: string, cwd = process.cwd()): Promise<Source> {
  const value = input.trim()
  const url = value.match(GITHUB_HTTPS) ?? value.match(GITHUB_SSH)
  if (url) return remote(url[1]!, url[2]!)
  const info = await stat(resolve(cwd, value)).catch(() => null)
  if (info?.isDirectory()) {
    const dir = await realpath(resolve(cwd, value))
    const gitRoot = await exec('git', ['-C', dir, 'rev-parse', '--show-toplevel']).then((r) => r.stdout.trim()).catch(() => null)
    if (gitRoot === null) throw new Error(`Not a git repository: ${dir}`)
    return { kind: 'local', root: dir, gitRoot: await realpath(gitRoot) }
  }
  const short = value.match(SHORTHAND)
  if (short && !value.startsWith('.') && !value.startsWith('/')) return remote(short[1]!, short[2]!)
  throw new Error(`Not a directory or a GitHub repository: ${input}`)
}

function remote(owner: string, name: string): Source {
  return { kind: 'remote', owner, name, url: `https://github.com/${owner}/${name}.git`, label: `${owner}/${name}` }
}

export function authedUrl(source: Extract<Source, { kind: 'remote' }>, token: string | undefined): string {
  return token ? source.url.replace('https://', `https://x-access-token:${token}@`) : source.url
}

/** Runs inside the sandbox only. Shallow history is enough: the agent fixes the tip and commits once. */
export function cloneCommand(source: Extract<Source, { kind: 'remote' }>, token: string | undefined, root: string, ref?: string): string {
  return ['set -e', `rm -rf ${shellQuote(root)}`, `git clone --quiet --depth 50 ${ref ? `--branch ${shellQuote(ref)} ` : ''}${shellQuote(authedUrl(source, token))} ${shellQuote(root)}`].join('\n')
}

export const redact = (text: string, token: string | undefined): string => (token ? text.replaceAll(token, '***') : text)

export const branchName = (now = new Date()): string => `static-analysis/${now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-').toLowerCase()}`
