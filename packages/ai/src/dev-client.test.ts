// T44 (F19, F14): `kit dev` inside a client repo's ticket worktree, as the built dist/cli.js run as a child process.
// The worktree holds no aspira.json: the client root's repos entry for web supplies dev, and the command runs in the
// worktree with the credentials removed from its environment (the Notion token is never exported to a repo's commands).

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url))

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

// The dev command: records where it ran and whether the credentials reached it.
const DEV_ENV = `const { writeFileSync } = require('node:fs')
writeFileSync(process.env.REC_DIR + '/dev-env.json', JSON.stringify({ cwd: process.cwd(), notion: process.env.NOTION_TOKEN ?? null, notionKey: process.env.NOTION_API_KEY ?? null, marker: process.env.CLIENT_MARKER ?? null }))
`

/** A non-git client root mapping web/, and web/'s ticket worktree, which carries no aspira.json. */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ai-dev-client-')))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const web = join(root, 'web')
  mkdirSync(web)
  writeFileSync(join(root, 'aspira.json'), JSON.stringify({ statusFlow: false, pullRequest: false, repos: { web: { path: 'web', dev: { cwd: '.', command: 'node dev-env.js' } } } }))
  writeFileSync(join(web, 'dev-env.js'), DEV_ENV)
  writeFileSync(join(web, '.gitignore'), '.env.development.local\n.aspira/\n.worktrees/\n')
  git(web, 'init', '-q', '-b', 'main')
  git(web, 'add', '-A')
  git(web, 'commit', '-q', '-m', 'initial')
  const worktree = join(web, '.worktrees', 'FEATURE-WEB-1')
  git(web, 'worktree', 'add', '-q', '-b', 'feat/web-1', worktree)
  const record = mkdtempSync(join(tmpdir(), 'ai-dev-client-rec-'))
  cleanups.push(() => rmSync(record, { recursive: true, force: true }))
  return { root, worktree, record }
}

function kitDev(cwd: string, record: string): Promise<{ code: number | null; output: string }> {
  const home = mkdtempSync(join(tmpdir(), 'ai-dev-client-home-'))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, REC_DIR: record, NOTION_TOKEN: 'ntn_parent_secret', NOTION_API_KEY: 'ntn_parent_key', CLIENT_MARKER: 'kept' }
  for (const key of ['KIT_REEXEC', 'ASPIRA_KIT_REEXEC', 'PORT']) delete env[key]
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, 'dev'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.on('exit', (code) => done({ code, output }))
  })
}

describe('T44 F19 F14: kit dev in a client worktree', () => {
  it("runs web's dev command in the worktree and the command's env has no NOTION_TOKEN", async () => {
    const f = fixture()
    const outcome = await kitDev(f.worktree, f.record)
    const file = join(f.record, 'dev-env.json')
    const seen = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { cwd: string; notion: string | null; notionKey: string | null; marker: string | null }) : null
    expect({
      ran: seen !== null,
      cwd: seen?.cwd,
      notion: seen?.notion,
      notionKey: seen?.notionKey,
      // Only credentials are removed; the rest of the environment reaches the command.
      marker: seen?.marker,
      output: seen === null ? outcome.output : '',
    }).toEqual({ ran: true, cwd: f.worktree, notion: null, notionKey: null, marker: 'kept', output: '' })
  })
})
