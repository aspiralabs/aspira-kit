// The one file list of a map: what the build parses, the manifest records and --check compares.
// Tracked plus untracked-not-ignored files (git ls-files -co --exclude-standard), never a .env* file,
// never anything under the map root, never a symlink. Contents are hashed (SHA-256), never kept.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export type ScannedFile = { path: string; hash: string }

export const hashBytes = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

export async function hashFile(absolute: string): Promise<string> {
  return hashBytes(await readFile(absolute))
}

/** A .env, .env.local, .env.production ... file: its contents are secrets and are never read. */
export const isSecretsFile = (path: string): boolean => basename(path).startsWith('.env')

/** `mapRoot` relative to the repo as a path prefix, or undefined when the map root is outside the repo. */
function insidePrefix(repo: string, mapRoot: string): string | undefined {
  const rel = relative(repo, mapRoot)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return rel === '' ? '' : undefined
  return rel.split('\\').join('/')
}

export async function scanFiles(repo: string, mapRoot: string): Promise<ScannedFile[]> {
  const listing = await exec('git', ['-C', repo, 'ls-files', '-z', '-co', '--exclude-standard'], { maxBuffer: 256 * 1024 * 1024 })
  const prefix = insidePrefix(repo, mapRoot)
  const listed = [...new Set(listing.stdout.split('\0').filter(Boolean))].sort()
  const kept = listed.filter((path) => !isSecretsFile(path) && (prefix === undefined || (prefix !== '' && path !== prefix && !path.startsWith(`${prefix}/`))))
  const out: ScannedFile[] = []
  for (let i = 0; i < kept.length; i += 64) {
    const chunk = await Promise.all(
      kept.slice(i, i + 64).map(async (path): Promise<ScannedFile | undefined> => {
        const absolute = join(repo, path)
        const info = await lstat(absolute).catch(() => undefined)
        if (info === undefined || !info.isFile()) return undefined
        return { path, hash: await hashFile(absolute) }
      }),
    )
    for (const entry of chunk) if (entry !== undefined) out.push(entry)
  }
  return out
}

/** Repo-relative paths git reports as changed or untracked now (the manifest's dirty set), after the same exclusions. */
export async function dirtyFiles(repo: string, mapRoot: string): Promise<string[]> {
  const status = await exec('git', ['-C', repo, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { maxBuffer: 256 * 1024 * 1024 })
  const prefix = insidePrefix(repo, mapRoot)
  const paths: string[] = []
  const parts = status.stdout.split('\0').filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? ''
    const code = entry.slice(0, 2)
    paths.push(entry.slice(3))
    if (code.includes('R') || code.includes('C')) i++ // the next part is the rename's origin
  }
  return [...new Set(paths)].filter((path) => !isSecretsFile(path) && (prefix === undefined || (prefix !== '' && path !== prefix && !path.startsWith(`${prefix}/`)))).sort()
}
