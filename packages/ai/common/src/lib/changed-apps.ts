// Which app directories a build touched, and which of those the code analyzer already finished
// for this ticket and this implementor head (F21): what Step 7 (static analysis) and Step 8 (open
// the pull request) of the Playbook pick between.

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { readRunStatus } from './run-status.ts'

const exec = promisify(execFile)

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: repo })
  return stdout.trim()
}

/** The nearest ancestor directory of `path` (repo-relative) that holds a `package.json`, or `.` for the repository root. */
async function appDirOf(repo: string, path: string): Promise<string> {
  let dir = dirname(path)
  while (dir !== '.' && dir !== '/' && dir !== '') {
    try {
      await readFile(join(repo, dir, 'package.json'), 'utf8')
      return dir
    } catch {
      dir = dirname(dir)
    }
  }
  return '.'
}

/** The app directories a build touched: every path `git diff --name-only <base>...HEAD` lists, mapped to its nearest ancestor `package.json` directory (`.` for the root), `.work/` paths dropped, unique, in `localeCompare` order. */
export async function changedApps(repo: string, base: string): Promise<string[]> {
  const output = await git(repo, ['diff', '--name-only', `${base}...HEAD`])
  const paths = output.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('.work/'))
  const apps = new Set<string>()
  for (const path of paths) apps.add(await appDirOf(repo, path))
  return [...apps].toSorted((a, b) => a.localeCompare(b))
}

/** One app's rounds.json, read loosely: a missing or unparsable file reads as not analyzed. */
async function roundsOf(repo: string, app: string): Promise<{ status?: string; ticket?: string; head?: string } | undefined> {
  const text = await readFile(join(repo, app, '.static-analysis', 'rounds.json'), 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as { status?: string; ticket?: string; head?: string }
  } catch {
    return undefined
  }
}

/** Whether `maybeAncestor` is `head` itself or a real ancestor of it. */
async function isAtOrBefore(repo: string, maybeAncestor: string, head: string): Promise<boolean> {
  if (maybeAncestor === head) return true
  try {
    await exec('git', ['merge-base', '--is-ancestor', maybeAncestor, head], { cwd: repo })
    return true
  } catch {
    return false
  }
}

/**
 * Which of `apps` the code analyzer has already finished, for this exact ticket and implementor
 * head: its `.static-analysis/rounds.json` names this ticket, reads `ready` (old words included,
 * through `readRunStatus`), and was written at the implementor head or a later commit.
 */
export async function analyzedApps(repo: string, apps: readonly string[], context: { ticket: string; head: string }): Promise<string[]> {
  const out: string[] = []
  for (const app of apps) {
    const record = await roundsOf(repo, app)
    if (record === undefined || record.ticket !== context.ticket || record.head === undefined) continue
    const read = record.status === undefined ? null : readRunStatus(record.status)
    if (read?.status !== 'ready') continue
    if (await isAtOrBefore(repo, context.head, record.head)) out.push(app)
  }
  return out
}
