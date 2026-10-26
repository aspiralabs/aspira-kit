// T30-T31 (F1, F7, F26): `kit db migrate --name <n>` as the built dist/cli.js run as a child process, in a
// git worktree fixture. The system boundaries are faked: a node:http mock of the Neon API (the branch list of
// the project; the CLI reaches it through NEON_API_BASE_URL) and a fake `prisma` executable first on PATH that
// records its argv and the database variables it saw. Nothing talks to a live service.
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const PROJECT_ID = 'proj-1'
const BRANCH = 'wt/scoop-7'
const POOLED = 'postgres://u:p@ep-branch-pooler.neon.test/db?sslmode=require'
const DIRECT = 'postgres://u:p@ep-branch.neon.test/db?sslmode=require'
const SHARED = 'postgres://shared.example/dev'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

const temp = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `ai-dbmigrate-${name}-`))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function neonMock(branches: string[]): Promise<string> {
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0] ?? ''
    if (request.method === 'GET' && path.endsWith(`/projects/${PROJECT_ID}/branches`)) {
      const list = branches.map((name, i) => ({ id: `br-${i}`, name, default: name === 'main', project_id: PROJECT_ID }))
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ branches: list }))
      return
    }
    response.writeHead(404, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ message: 'not found' }))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  cleanups.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      }),
  )
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v2`
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

type Fixture = { worktree: string; bin: string; record: string; rec: (name: string) => string }

/** A repository with a FEATURE-SCOOP-7 worktree; `schema` is the Prisma datasource block; `envFile` the worktree's env file. */
function fixture(opts: { schema?: string; envFile?: string | null; prisma?: string } = {}): Fixture {
  const main = temp('main')
  const schema =
    opts.schema ??
    `datasource db {\n  provider  = "postgresql"\n  url       = env("DATABASE_URL")\n  directUrl = env("DIRECT_URL")\n}\n`
  mkdirSync(join(main, 'prisma'))
  writeFileSync(join(main, 'prisma', 'schema.prisma'), schema)
  writeFileSync(join(main, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', private: true }))
  writeFileSync(join(main, '.gitignore'), '.env.development.local\n.aspira/\n.worktrees/\n')
  writeFileSync(
    join(main, 'aspira.json'),
    JSON.stringify({
      board: 'https://www.notion.so/Board-0123456789abcdef0123456789abcdef',
      database: { provider: 'neon', projectId: PROJECT_ID, parentBranch: 'dev', envVars: ['DATABASE_URL', { name: 'DIRECT_URL', pooled: false }] },
    }),
  )
  git(main, 'init', '-q', '-b', 'main')
  git(main, 'add', '-A')
  git(main, 'commit', '-q', '-m', 'initial')
  const worktree = join(main, '.worktrees', 'FEATURE-SCOOP-7')
  git(main, 'worktree', 'add', '-q', '-b', 'feat/scoop-7', worktree)
  const envFile = opts.envFile === undefined ? `DATABASE_URL=${POOLED}\nDIRECT_URL=${DIRECT}\nPORT=3001\nASPIRA_WORKTREE=scoop-7\n` : opts.envFile
  if (envFile !== null) writeFileSync(join(worktree, '.env.development.local'), envFile)

  const records = temp('records')
  const bin = temp('bin')
  const file = join(bin, 'prisma')
  writeFileSync(
    file,
    opts.prisma ??
      `#!${process.execPath}
const { appendFileSync } = require('node:fs')
appendFileSync(process.env.REC_DIR + '/prisma.jsonl', JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: { DATABASE_URL: process.env.DATABASE_URL, DIRECT_URL: process.env.DIRECT_URL, SHADOW_URL: process.env.SHADOW_URL } }) + '\\n')
`,
  )
  chmodSync(file, 0o755)
  return { worktree, bin, record: records, rec: (name) => join(records, name) }
}

type Call = { argv: string[]; cwd: string; env: Record<string, string | undefined> }
const prismaCalls = (f: Fixture): Call[] =>
  existsSync(f.rec('prisma.jsonl'))
    ? readFileSync(f.rec('prisma.jsonl'), 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Call)
    : []

// Async on purpose: the Neon mock lives in this process, so a blocking spawnSync would starve it.
async function kit(f: Fixture, base: string, args: string[]): Promise<{ code: number | null; out: string }> {
  const home = temp('home')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: [f.bin, process.env.PATH].join(':'),
    REC_DIR: f.record,
    NEON_API_KEY: 'test-key',
    NEON_API_BASE_URL: base,
    // The shared dev database a fall-through would reach.
    DATABASE_URL: SHARED,
    DIRECT_URL: SHARED,
    SHADOW_URL: SHARED,
  }
  for (const key of ['NOTION_TOKEN', 'NOTION_API_KEY', 'KIT_REEXEC', 'ASPIRA_KIT_REEXEC']) delete env[key]
  // stdin is a pipe, never a TTY (F26).
  const child = spawn(process.execPath, [CLI, ...args], { cwd: f.worktree, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()))
  child.stdin.end()
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
  const code = await new Promise<number | null>((done) => child.on('close', (status) => done(status)))
  clearTimeout(timer)
  return { code, out }
}

const MIGRATE = ['db', 'migrate', '--name', 'add_x']

describe('kit db migrate', () => {
  it('T30: runs prisma migrate dev --name add_x on the branch values and exits 0', async () => {
    const f = fixture()
    const result = await kit(f, await neonMock(['main', 'dev', BRANCH]), MIGRATE)
    expect(result.code).toBe(0)
    const calls = prismaCalls(f)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.argv.slice(0, 2)).toEqual(['migrate', 'dev'])
    expect(calls[0]!.argv).toContain('--name')
    expect(calls[0]!.argv[calls[0]!.argv.indexOf('--name') + 1]).toBe('add_x')
    expect(calls[0]!.argv).not.toContain('--force')
    expect(calls[0]!.argv).not.toContain('reset')
    expect(calls[0]!.env.DATABASE_URL).toBe(POOLED)
    expect(calls[0]!.env.DIRECT_URL).toBe(DIRECT)
  })

  it('T30: exits 1 and never invokes prisma when the worktree has no branch URL', async () => {
    const f = fixture({ envFile: null })
    const result = await kit(f, await neonMock(['main', 'dev', BRANCH]), MIGRATE)
    expect(result.code).toBe(1)
    expect(result.out).toMatch(/branch/i)
    expect(prismaCalls(f)).toEqual([])
  })

  it('T30: exits 1 and never invokes prisma when the env file lacks the ASPIRA_WORKTREE marker, even if a branch of the folder name exists', async () => {
    const f = fixture({ envFile: `DATABASE_URL=${POOLED}\nDIRECT_URL=${DIRECT}\nPORT=3001\n` })
    const result = await kit(f, await neonMock(['main', 'dev', BRANCH]), MIGRATE)
    expect(result.code).toBe(1)
    expect(result.out).toContain('ASPIRA_WORKTREE')
    expect(prismaCalls(f)).toEqual([])
  })

  it('T30: exits 1 saying the branch expired and to rerun kit worktree when Neon no longer lists it', async () => {
    const f = fixture()
    const result = await kit(f, await neonMock(['main', 'dev']), MIGRATE)
    expect(result.code).toBe(1)
    expect(result.out).toMatch(/expired/i)
    expect(result.out).toContain('kit worktree')
    expect(prismaCalls(f)).toEqual([])
  })

  it('T30: exits 1 naming an env() variable of the datasource that database.envVars does not list', async () => {
    const f = fixture({
      schema: `datasource db {\n  provider          = "postgresql"\n  url               = env("DATABASE_URL")\n  directUrl         = env("DIRECT_URL")\n  shadowDatabaseUrl = env("SHADOW_URL")\n}\n`,
    })
    const result = await kit(f, await neonMock(['main', 'dev', BRANCH]), MIGRATE)
    expect(result.code).toBe(1)
    expect(result.out).toContain('SHADOW_URL')
    expect(prismaCalls(f)).toEqual([])
  })

  it("T30: a prisma refusal exits 1 with prisma's message, and prisma is never given --force or reset", async () => {
    const f = fixture({
      prisma: `#!${process.execPath}
const { appendFileSync } = require('node:fs')
appendFileSync(process.env.REC_DIR + '/prisma.jsonl', JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: {} }) + '\\n')
console.error('Prisma Migrate has detected that the environment is non-interactive, which is not supported.')
process.exit(1)
`,
    })
    const result = await kit(f, await neonMock(['main', 'dev', BRANCH]), MIGRATE)
    expect(result.code).toBe(1)
    expect(result.out).toContain('Prisma Migrate has detected that the environment is non-interactive')
    const calls = prismaCalls(f)
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.argv).not.toContain('--force')
      expect(call.argv).not.toContain('reset')
    }
  })

  it('T31: completes with exit 0 from a child process whose stdin is a pipe, the migration name given on the command line', async () => {
    const f = fixture()
    const result = await kit(f, await neonMock(['main', 'dev', BRANCH]), MIGRATE)
    expect(result.code).toBe(0)
    const calls = prismaCalls(f)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.argv).toContain('--name')
    expect(calls[0]!.argv).toContain('add_x')
  })
})
