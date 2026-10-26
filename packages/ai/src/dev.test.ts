// T32 (F12): `kit dev` as the built dist/cli.js run as a child process, in git fixtures. The dev command is a
// small node script that records the PORT it saw and its pid; cloudflared is a fake executable first on PATH that
// records its args and pid and stays up until signalled. Records land in REC_DIR.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url))

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

const temp = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `ai-dev-${name}-`))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

/** A port nothing listens on right now. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((done) => server.close(() => done()))
  return port
}

const DEV_SERVER = `const { writeFileSync } = require('node:fs')
writeFileSync(process.env.REC_DIR + '/dev.json', JSON.stringify({ port: process.env.PORT, argv: process.argv.slice(2), pid: process.pid }))
if (process.argv.includes('once')) process.exit(0)
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
setInterval(() => {}, 1000)
`

const FAKE_CLOUDFLARED = `#!${process.execPath}
const { writeFileSync } = require('node:fs')
writeFileSync(process.env.REC_DIR + '/cloudflared.json', JSON.stringify({ args: process.argv.slice(2), pid: process.pid }))
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
setInterval(() => {}, 1000)
`

type Dev = { command?: string; script?: string }
type Fixture = { dir: string; record: string; bin: string; port: number }

/** isolated: a FEATURE-SCOOP-7 worktree with PORT and a tunnel config; otherwise the main checkout, which has neither. */
async function fixture(opts: { isolated: boolean; dev?: Dev; command?: string }): Promise<Fixture> {
  const main = temp('main')
  const port = await freePort()
  const command = opts.dev?.command ?? opts.command ?? 'node dev-server.js'
  writeFileSync(join(main, 'dev-server.js'), DEV_SERVER)
  writeFileSync(
    join(main, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', private: true, scripts: { dev: opts.dev?.script ?? 'node dev-server.js' } }),
  )
  writeFileSync(join(main, '.gitignore'), '.env.development.local\n.aspira/\n.worktrees/\n')
  writeFileSync(
    join(main, 'aspira.json'),
    JSON.stringify({
      board: 'https://www.notion.so/Board-0123456789abcdef0123456789abcdef',
      dev: { cwd: '.', command, url: 'http://{name}.localhost:{port}' },
      webhooks: [{ provider: 'stripe', path: '/api/webhooks/stripe', events: ['checkout.session.completed'] }],
    }),
  )
  git(main, 'init', '-q', '-b', 'main')
  git(main, 'add', '-A')
  git(main, 'commit', '-q', '-m', 'initial')
  let dir = main
  if (opts.isolated) {
    dir = join(main, '.worktrees', 'FEATURE-SCOOP-7')
    git(main, 'worktree', 'add', '-q', '-b', 'feat/scoop-7', dir)
    writeFileSync(join(dir, '.env.development.local'), `PORT=${port}\nASPIRA_WORKTREE=scoop-7\n`)
    mkdirSync(join(dir, '.aspira'))
    writeFileSync(join(dir, '.aspira', 'cloudflared.yml'), 'tunnel: 00000000-0000-0000-0000-000000000000\ningress:\n  - service: http_status:404\n')
  }
  const bin = temp('bin')
  const file = join(bin, 'cloudflared')
  writeFileSync(file, FAKE_CLOUDFLARED)
  chmodSync(file, 0o755)
  return { dir, record: temp('records'), bin, port }
}

function startKit(f: Fixture): { child: ChildProcess; output: () => string; exited: Promise<number | null> } {
  const home = temp('home')
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, PATH: [f.bin, process.env.PATH].join(':'), REC_DIR: f.record }
  for (const key of ['NOTION_TOKEN', 'NOTION_API_KEY', 'KIT_REEXEC', 'ASPIRA_KIT_REEXEC', 'PORT']) delete env[key]
  const child = spawn(process.execPath, [CLI, 'dev'], { cwd: f.dir, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let text = ''
  child.stdout?.on('data', (chunk: Buffer) => (text += chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => (text += chunk.toString()))
  const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)))
  cleanups.push(() => {
    if (child.exitCode === null) child.kill('SIGKILL')
  })
  return { child, output: () => text, exited }
}

async function waitFor(condition: () => boolean, what: string, timeout = 20_000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`)
    await new Promise((done) => setTimeout(done, 50))
  }
}

const read = <T>(f: Fixture, name: string): T => JSON.parse(readFileSync(join(f.record, name), 'utf8')) as T
const has = (f: Fixture, name: string): boolean => existsSync(join(f.record, name))
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

type DevRecord = { port?: string; argv: string[]; pid: number }
type TunnelRecord = { args: string[]; pid: number }

async function running(f: Fixture) {
  const kit = startKit(f)
  await waitFor(() => has(f, 'dev.json') && has(f, 'cloudflared.json'), 'dev server and cloudflared to start')
  return { ...kit, dev: read<DevRecord>(f, 'dev.json'), tunnel: read<TunnelRecord>(f, 'cloudflared.json') }
}

describe('kit dev', () => {
  it('T32: starts dev.command on the worktree PORT and cloudflared tunnel run with the worktree config', async () => {
    const f = await fixture({ isolated: true })
    const run = await running(f)
    expect(run.dev.port).toBe(String(f.port))
    expect(run.tunnel.args.slice(0, 2)).toEqual(['tunnel', 'run'])
    const at = run.tunnel.args.indexOf('--config')
    expect(at).toBeGreaterThan(-1)
    expect(run.tunnel.args[at + 1]).toMatch(/(^|\/)\.aspira\/cloudflared\.yml$/)
    run.child.kill('SIGINT')
    await run.exited
  })

  it('T32: stops the dev process too when cloudflared exits', async () => {
    const f = await fixture({ isolated: true })
    const run = await running(f)
    process.kill(run.tunnel.pid, 'SIGTERM')
    await run.exited
    await waitFor(() => !alive(run.dev.pid), 'the dev process to stop')
  })

  it('T32: SIGINT stops kit dev, the dev process and cloudflared', async () => {
    const f = await fixture({ isolated: true })
    const run = await running(f)
    run.child.kill('SIGINT')
    await run.exited
    await waitFor(() => !alive(run.dev.pid) && !alive(run.tunnel.pid), 'both processes to stop')
  })

  it('T32: refuses a dev.command that pins -p, without starting anything', async () => {
    const f = await fixture({ isolated: true, dev: { command: 'node dev-server.js -p 3000' } })
    const kit = startKit(f)
    expect(await kit.exited).not.toBe(0)
    expect(kit.output()).toMatch(/-p|--port/)
    expect(has(f, 'dev.json')).toBe(false)
    expect(has(f, 'cloudflared.json')).toBe(false)
  })

  it('T32: refuses a package script that pins --port, without starting anything', async () => {
    const f = await fixture({ isolated: true, dev: { command: 'npm run dev', script: 'node dev-server.js --port 3000' } })
    const kit = startKit(f)
    expect(await kit.exited).not.toBe(0)
    expect(kit.output()).toMatch(/-p|--port/)
    expect(has(f, 'dev.json')).toBe(false)
    expect(has(f, 'cloudflared.json')).toBe(false)
  })

  it('T32: exits 1 naming the port when PORT is held by another process', async () => {
    const f = await fixture({ isolated: true })
    const holder = createServer()
    await new Promise<void>((done) => holder.listen(f.port, '127.0.0.1', done))
    cleanups.push(() => new Promise<void>((done) => holder.close(() => done())))
    const kit = startKit(f)
    expect(await kit.exited).toBe(1)
    expect(kit.output()).toContain(String(f.port))
    expect(has(f, 'dev.json')).toBe(false)
  })

  it('T32: outside an isolated worktree runs dev.command unchanged, without cloudflared', async () => {
    const f = await fixture({ isolated: false, command: 'node dev-server.js once' })
    const kit = startKit(f)
    expect(await kit.exited).toBe(0)
    const dev = read<DevRecord>(f, 'dev.json')
    expect(dev.argv).toEqual(['once'])
    expect(dev.port).toBeUndefined()
    expect(has(f, 'cloudflared.json')).toBe(false)
  })
})
