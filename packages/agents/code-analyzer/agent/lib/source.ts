import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { shellQuote } from './executor.ts'

const exec = promisify(execFile)
export type Source = { kind: 'local'; root: string } | { kind: 'remote'; owner: string; name: string; url: string; label: string }

const GITHUB_HTTPS = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/
const GITHUB_SSH = /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/
const SHORTHAND = /^([\w.-]+)\/([\w.-]+)$/

/** Classifies what the caller typed. Local paths are resolved to their git root here, on the host. */
export async function parseSource(input: string, cwd = process.cwd()): Promise<Source> {
  const value = input.trim()
  const url = value.match(GITHUB_HTTPS) ?? value.match(GITHUB_SSH)
  if (url) return remote(url[1]!, url[2]!)
  const info = await stat(resolve(cwd, value)).catch(() => null)
  if (info?.isDirectory()) {
    const root = await exec('git', ['-C', resolve(cwd, value), 'rev-parse', '--show-toplevel']).then((r) => r.stdout.trim()).catch(() => null)
    if (root === null) throw new Error(`Not a git repository: ${resolve(cwd, value)}`)
    return { kind: 'local', root }
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
