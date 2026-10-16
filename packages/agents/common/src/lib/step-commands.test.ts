// T16 (F23): step-commands.ts does not exist yet (P16). It is the one place that turns a ticket ID,
// a branch, a set of changed paths and a PR body file into the literal shell commands a progress
// note's Next action shows. Every value that reaches a shell (the card title, a path) is untrusted:
// a title is free text a human typed on the board, and a path comes from the code-analyzer's own
// rounds.json. This test runs the built commands for real, through `sh -c`, with `git` and `gh`
// replaced by fakes that record their argv and do nothing else, to prove the quoting holds even
// when sh actually parses the string (TEST-007: real system boundary, not a string-equality guess
// at what a shell would do with it).

import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isTicketId, step8Commands } from './step-commands'

const exec = promisify(execFile)

// A card title crafted to break naive interpolation: command substitution, a backtick pair, a
// double quote, a single quote (the character shellQuote's own escape must handle) and a literal
// newline, all inside one field.
const TITLE = "a $(touch pwned) `id` \"q\" 's and a\nnewline"

let cwd: string
let bin: string
let callDir: string

const FAKE = (name: string) => ['#!/bin/sh', 'n=0', `while [ -e "$CALL_DIR/${name}-$n" ]; do n=$((n+1)); done`, `printf '%s\\0' "$@" > "$CALL_DIR/${name}-$n"`, 'exit 0', ''].join('\n')

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'step-commands-cwd-'))
  bin = await mkdtemp(join(tmpdir(), 'step-commands-bin-'))
  callDir = await mkdtemp(join(tmpdir(), 'step-commands-calls-'))
  await writeFile(join(bin, 'git'), FAKE('git'), { mode: 0o755 })
  await writeFile(join(bin, 'gh'), FAKE('gh'), { mode: 0o755 })
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
  await rm(bin, { recursive: true, force: true })
  await rm(callDir, { recursive: true, force: true })
})

/** Every call the fakes recorded, in filename order, as their argv array (NUL-separated, so an embedded newline in an argument is never mistaken for a new line of output). */
async function calls(prefix: 'git' | 'gh'): Promise<string[][]> {
  const names = (await readdir(callDir)).filter((name) => name.startsWith(`${prefix}-`)).sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]))
  const out: string[][] = []
  for (const name of names) {
    const raw = await readFile(join(callDir, name))
    out.push(raw.toString('utf8').split('\0').slice(0, -1))
  }
  return out
}

async function run(command: string) {
  await exec('sh', ['-c', command], { cwd, env: { PATH: `${bin}:${process.env.PATH ?? ''}`, CALL_DIR: callDir } }).catch(() => undefined)
}

describe('isTicketId (T16)', () => {
  it('accepts an uppercase-prefix, hyphen, digits id and rejects anything else', () => {
    expect(isTicketId('KIT-2')).toBe(true)
    expect(isTicketId('kit-2')).toBe(false)
    expect(isTicketId('KIT-2;rm')).toBe(false)
  })
})

describe('step8Commands (T16)', () => {
  const PATHS = ['apps/web/a b.ts', 'apps/web/$(touch pwned).ts', '/etc/passwd', '../x.ts']
  const BRANCH = 'feat/kit-2-x'
  const PR_BODY_FILE = '.work/kit-2-x/pr-body.md'

  it('refuses a ticket id that does not match ^[A-Z]+-\\d+$, building no command', () => {
    for (const bad of ['kit-2', 'KIT-2;rm']) {
      const result = step8Commands({ id: bad, title: TITLE }, BRANCH, PATHS, PR_BODY_FILE)
      expect(result.ok).toBe(false)
    }
  })

  it('excludes the absolute path and the ".." path, naming them for Open issues', () => {
    const result = step8Commands({ id: 'KIT-2', title: TITLE }, BRANCH, PATHS, PR_BODY_FILE)
    if (!result.ok) throw new Error('expected step8Commands to build commands for a valid ticket id')
    expect(result.excluded.sort()).toEqual(['../x.ts', '/etc/passwd'].sort())
  })

  it('never stages a .env* file at any depth (the files redact.ts reads as secret-bearing), naming each one for Open issues', async () => {
    const secrets = ['.env', '.env.local', '.env.example', 'apps/web/.env', 'apps/web/.env.production.local', '.envrc']
    const kept = ['apps/web/env.ts', 'apps/web/.env-docs/y.ts', 'docs/dot.env.md']
    const result = step8Commands({ id: 'KIT-2', title: 'a title' }, BRANCH, [...secrets, ...kept], PR_BODY_FILE)
    if (!result.ok) throw new Error('expected step8Commands to build commands for a valid ticket id')
    expect(result.excluded.sort()).toEqual([...secrets].sort())
    for (const command of result.commands) await run(command)
    const add = (await calls('git')).find((argv) => argv[0] === 'add')
    expect(add?.slice((add?.indexOf('--') ?? -1) + 1)).toEqual(kept)
  })

  it('with only .env* files changed, builds no git add at all', () => {
    const result = step8Commands({ id: 'KIT-2', title: 'a title' }, BRANCH, ['.env.local', 'apps/api/.env'], PR_BODY_FILE)
    if (!result.ok) throw new Error('expected step8Commands to build commands for a valid ticket id')
    expect(result.commands.some((command) => command.includes('git add'))).toBe(false)
    expect(result.excluded.sort()).toEqual(['.env.local', 'apps/api/.env'])
  })

  it('every command runs safely through sh -c: no file named pwned is ever created', async () => {
    const result = step8Commands({ id: 'KIT-2', title: TITLE }, BRANCH, PATHS, PR_BODY_FILE)
    if (!result.ok) throw new Error('expected step8Commands to build commands for a valid ticket id')
    for (const command of result.commands) await run(command)
    const files = await readdir(cwd)
    expect(files).not.toContain('pwned')
  })

  it('git add receives exactly the two safe, repo-relative paths after "--"; git commit cites the ticket id', async () => {
    const result = step8Commands({ id: 'KIT-2', title: TITLE }, BRANCH, PATHS, PR_BODY_FILE)
    if (!result.ok) throw new Error('expected step8Commands to build commands for a valid ticket id')
    for (const command of result.commands) await run(command)
    const git = await calls('git')
    const add = git.find((argv) => argv[0] === 'add')
    const commit = git.find((argv) => argv[0] === 'commit')
    const afterDashDash = add?.slice((add?.indexOf('--') ?? -1) + 1)
    expect(afterDashDash).toEqual(['apps/web/a b.ts', 'apps/web/$(touch pwned).ts'])
    expect(commit).toEqual(['commit', '-m', 'KIT-2: static analysis'])
  })

  it('gh receives the literal, unmangled title as one argv element, newline and all', async () => {
    const result = step8Commands({ id: 'KIT-2', title: TITLE }, BRANCH, PATHS, PR_BODY_FILE)
    if (!result.ok) throw new Error('expected step8Commands to build commands for a valid ticket id')
    for (const command of result.commands) await run(command)
    const gh = await calls('gh')
    const create = gh.find((argv) => argv.includes('--title'))
    const title = create?.[(create?.indexOf('--title') ?? -1) + 1]
    expect(title).toBe(TITLE)
  })
})
