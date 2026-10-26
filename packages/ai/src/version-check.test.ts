// T19-T25 (F8, F9, F10): src/version-check.ts does not exist yet (P8). This file is its contract.
//
// checkVersion({ surface, running, home, now, registry }) resolves to the notice text, or to nothing
// (a falsy value) when there is none, and never throws. `surface` is 'kit' | 'hook'; `running` is the
// running package version; `home` is the user's home directory; `now` is the injected clock, a
// function returning epoch milliseconds; `registry` is the registry base, a test-only parameter (the
// CLI and the hook always use https://npm.pkg.github.com). The packument is GET <registry>/@aspiralabs%2fai.
// The per-user cache is a JSON file under <home>/.cache/aspiralabs/ (version-check.json) shaped
// { checkedAt: <ms>, latest?: '<x.y.z>', failed?: true, notified: { kit?: <ms>, hook?: <ms> } }.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkVersion } from './version-check.js'

const TOKEN = 'test-token'
const HOUR = 3_600_000
const START = 1_800_000_000_000
const RUNNING = '0.16.0'
const NOTICE_RE = /@aspiralabs\/ai 0\.17\.0 is available \(you have 0\.16\.0\)/

type Seen = { url: string | undefined; headers: IncomingHttpHeaders }
type Reply = { status?: number; body?: string; location?: string; hang?: boolean }
type Stub = { base: string; port: number; seen: Seen[]; close: () => Promise<void> }

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((done) => server.listen(port, '127.0.0.1', done))
  return (server.address() as AddressInfo).port
}

async function stub(reply: Reply | (() => Reply), port = 0): Promise<Stub> {
  const seen: Seen[] = []
  const server = createServer((request, response) => {
    seen.push({ url: request.url, headers: request.headers })
    const r = typeof reply === 'function' ? reply() : reply
    if (r.hang) return
    if (r.location) {
      response.writeHead(r.status ?? 302, { Location: r.location })
      response.end()
      return
    }
    response.writeHead(r.status ?? 200, { 'Content-Type': 'application/json' })
    response.end(r.body ?? '')
  })
  const actual = await listen(server, port)
  const close = () =>
    new Promise<void>((done) => {
      server.closeAllConnections()
      server.close(() => done())
    })
  cleanups.push(close)
  return { base: `http://127.0.0.1:${actual}`, port: actual, seen, close }
}

const latest = (version: string): Reply => ({ body: JSON.stringify({ 'dist-tags': { latest: version } }) })

/** A port nothing listens on (ECONNREFUSED). */
async function closedPort(): Promise<number> {
  const server = createServer()
  const port = await listen(server)
  await new Promise<void>((done) => server.close(() => done()))
  return port
}

function tempHome(token: string | null = TOKEN): string {
  const home = mkdtempSync(join(tmpdir(), 'ai-version-home-'))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  if (token !== null) writeFileSync(join(home, '.npmrc'), `//npm.pkg.github.com/:_authToken=${token}\n`)
  return home
}

const cacheDir = (home: string) => join(home, '.cache', 'aspiralabs')
const cacheFile = (home: string) => join(cacheDir(home), 'version-check.json')

function writeCache(home: string, content: string): void {
  mkdirSync(cacheDir(home), { recursive: true })
  writeFileSync(cacheFile(home), content)
}

function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(join(dir, e.name)) : [join(dir, e.name)]))
}

function run(home: string, registry: string, opts: { surface?: 'kit' | 'hook'; running?: string; at?: number } = {}): Promise<string | undefined> {
  const at = opts.at ?? START
  return checkVersion({ surface: opts.surface ?? 'kit', running: opts.running ?? RUNNING, home, now: () => at, registry }) as Promise<string | undefined>
}

describe('version check', () => {
  it('T19: returns one notice with the global upgrade command, sends the bearer token and writes a 0600 cache', async () => {
    const server = await stub(latest('0.17.0'))
    const home = tempHome()
    const notice = await run(home, server.base)
    expect(notice).toMatch(NOTICE_RE)
    expect(notice).toContain('Upgrade: kit update')
    expect(notice).not.toContain('pnpm add -D')
    expect(server.seen).toHaveLength(1)
    expect(server.seen[0]!.url).toBe('/@aspiralabs%2fai')
    expect(server.seen[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`)
    const files = readdirSync(cacheDir(home)).filter((f) => f.endsWith('.json'))
    expect(files).toHaveLength(1)
    const file = join(cacheDir(home), files[0]!)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('0.17.0')
    expect(text).toContain(String(START))
  })

  it('T20: no notice for the same version, an older latest or a prerelease latest', async () => {
    for (const answer of ['0.16.0', '0.15.0', '0.17.0-beta.1']) {
      const server = await stub(latest(answer))
      expect(await run(tempHome(), server.base), answer).toBeFalsy()
    }
  })

  it('T21: asks the registry at most once per 24 hours and caches a failure with its time', async () => {
    const server = await stub(latest('0.17.0'))
    const home = tempHome()
    await run(home, server.base, { at: START })
    await run(home, server.base, { at: START + HOUR })
    expect(server.seen).toHaveLength(1)
    await run(home, server.base, { at: START + 25 * HOUR })
    expect(server.seen).toHaveLength(2)

    const port = await closedPort()
    const failHome = tempHome()
    const out = vi.spyOn(process.stdout, 'write')
    const err = vi.spyOn(process.stderr, 'write')
    const log = vi.spyOn(console, 'log')
    const first = await run(failHome, `http://127.0.0.1:${port}`, { at: START })
    expect(first).toBeFalsy()
    const revived = await stub(latest('0.17.0'), port)
    const began = Date.now()
    const second = await run(failHome, revived.base, { at: START + HOUR })
    expect(Date.now() - began).toBeLessThan(500)
    expect(second).toBeFalsy()
    expect(revived.seen).toHaveLength(0)
    expect(out).not.toHaveBeenCalled()
    expect(err).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  describe('T22: every failure is silent, bounded and leaks nothing', () => {
    it.each([
      ['offline', 'closed'],
      ['401', { status: 401, body: 'SECRET-ERROR-BODY' }],
      ['500', { status: 500, body: 'SECRET-ERROR-BODY' }],
      ['non-JSON', { body: 'SECRET-ERROR-BODY <html>' }],
    ] as const)('%s returns no notice and writes no secret', async (_name, variant) => {
      const home = tempHome()
      const base = variant === 'closed' ? `http://127.0.0.1:${await closedPort()}` : (await stub(variant)).base
      const result = await run(home, base)
      expect(result).toBeFalsy()
      expect(String(result ?? '')).not.toContain(TOKEN)
      for (const file of allFiles(home)) {
        if (file.endsWith('.npmrc')) continue
        const text = readFileSync(file, 'utf8')
        expect(text, file).not.toContain(TOKEN)
        expect(text, file).not.toContain('SECRET-ERROR-BODY')
      }
    })

    it('abandons a server that never answers within the 2 second cap', async () => {
      const server = await stub({ hang: true })
      const began = Date.now()
      const result = await run(tempHome(), server.base)
      expect(Date.now() - began).toBeLessThan(3000)
      expect(result).toBeFalsy()
    })

    it('makes no request at all with no GitHub Packages token', async () => {
      const server = await stub(latest('0.17.0'))
      const home = tempHome(null)
      writeFileSync(join(home, '.npmrc'), 'registry=https://registry.npmjs.org/\n')
      expect(await run(home, server.base)).toBeFalsy()
      expect(server.seen).toHaveLength(0)
      const bare = tempHome(null)
      expect(await run(bare, server.base)).toBeFalsy()
      expect(server.seen).toHaveLength(0)
    })
  })

  it('T23: takes no registry or token from a project .npmrc or npm_config_* and does not follow a redirect', async () => {
    const b = await stub(latest('0.17.0'))
    const a = await stub({ status: 302, location: `${b.base}/@aspiralabs%2fai` })
    const project = mkdtempSync(join(tmpdir(), 'ai-version-project-'))
    cleanups.push(() => rmSync(project, { recursive: true, force: true }))
    const bHost = b.base.replace('http://', '')
    writeFileSync(join(project, '.npmrc'), `@aspiralabs:registry=${b.base}\n//${bHost}/:_authToken=other\n`)
    vi.stubEnv('NPM_CONFIG_REGISTRY', b.base)
    vi.stubEnv('npm_config_@aspiralabs:registry', b.base)
    vi.spyOn(process, 'cwd').mockReturnValue(project)
    try {
      process.chdir(project)
    } catch {
      // chdir is unavailable in some worker kinds; the cwd spy above stands in for it
    }
    const notice = await run(tempHome(), a.base)
    expect(b.seen).toHaveLength(0)
    expect(a.seen).toHaveLength(1)
    expect(notice).toBeFalsy()
  })

  describe('T24: cache states', () => {
    const now = String(START)
    it.each([
      ['latest "latest"', JSON.stringify({ checkedAt: START, latest: 'latest', notified: {} })],
      ['latest "1.0"', JSON.stringify({ checkedAt: START, latest: '1.0', notified: {} })],
      ['a shell payload', JSON.stringify({ checkedAt: START, latest: '0.17.0; rm -rf ~', notified: {} })],
    ])('discards %s from the cache', async (_name, content) => {
      const server = await stub(latest('not-a-version'))
      const home = tempHome()
      writeCache(home, content)
      expect(await run(home, server.base, { at: START + HOUR })).toBeFalsy()
    })

    it('discards a non x.y.z latest from the registry', async () => {
      const server = await stub(latest('not-a-version'))
      expect(await run(tempHome(), server.base)).toBeFalsy()
    })

    it.each([
      ['an empty file', ''],
      ['a truncated JSON', `{"checkedAt":${now},"latest":"0.1`],
    ])('treats %s as no cache: asks once and rewrites a valid file', async (_name, content) => {
      const server = await stub(latest('0.17.0'))
      const home = tempHome()
      writeCache(home, content)
      expect(await run(home, server.base)).toMatch(NOTICE_RE)
      expect(server.seen).toHaveLength(1)
      expect(() => JSON.parse(readFileSync(cacheFile(home), 'utf8'))).not.toThrow()
      await run(home, server.base, { at: START + HOUR })
      expect(server.seen).toHaveLength(1)
    })

    it('treats a directory in place of the cache file as no cache and does not throw', async () => {
      const server = await stub(latest('0.17.0'))
      const home = tempHome()
      mkdirSync(cacheFile(home), { recursive: true })
      await expect(run(home, server.base)).resolves.toMatch(NOTICE_RE)
      expect(server.seen).toHaveLength(1)
    })

    it('lets two concurrent checks finish, notify at most once and leave a parseable cache', async () => {
      const server = await stub(latest('0.17.0'))
      const home = tempHome()
      const results = await Promise.all([run(home, server.base), run(home, server.base)])
      expect(results.filter(Boolean).length).toBeLessThanOrEqual(1)
      const files = readdirSync(cacheDir(home))
      expect(files.length).toBeGreaterThan(0)
      for (const f of files) expect(() => JSON.parse(readFileSync(join(cacheDir(home), f), 'utf8')), f).not.toThrow()
    })
  })

  it('T25: each surface notifies once per 24 hours on its own', async () => {
    const server = await stub(latest('0.17.0'))
    const home = tempHome()
    expect(await run(home, server.base, { surface: 'kit', at: START })).toMatch(NOTICE_RE)
    expect(await run(home, server.base, { surface: 'kit', at: START + HOUR })).toBeFalsy()
    expect(await run(home, server.base, { surface: 'hook', at: START + HOUR })).toMatch(NOTICE_RE)
    expect(await run(home, server.base, { surface: 'hook', at: START + 2 * HOUR })).toBeFalsy()
    expect(await run(home, server.base, { surface: 'kit', at: START + 25 * HOUR })).toMatch(NOTICE_RE)
  })
})

