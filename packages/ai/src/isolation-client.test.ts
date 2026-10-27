// T43 (F19, F14): isolation in a client repo's ticket worktree. The worktree holds no aspira.json, so plan() reads the
// client root's repos entry for web (database, tunnel, webhooks), and every command the kit runs for it (cloudflared,
// stripe) runs with NOTION_TOKEN and the other credentials removed from the environment it inherits.
// cloudflared and stripe are fake executables first on PATH, driven through the real processRunner; the Neon seam is
// an in-memory stand-in (the HTTP boundary is not what this pins).

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isolate, processRunner, stripeSeam, tunnelSeam, type IsolationSeams, type NeonSeam } from './isolation.js'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

const NOW = Date.parse('2026-10-26T00:00:00Z')
const PROJECT = 'proj-1'

const FAKE_CLOUDFLARED = `#!${process.execPath}
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.REC_FILE, JSON.stringify({ bin: 'cloudflared', args, notion: process.env.NOTION_TOKEN ?? null, notionKey: process.env.NOTION_API_KEY ?? null }) + '\\n')
if (args[0] === 'tunnel' && args[1] === 'list') console.log('[]')
else if (args[0] === 'tunnel' && args[1] === 'create') console.log('Created tunnel ' + args[2] + ' with id 00000000-0000-4000-8000-000000000001')
`

const FAKE_STRIPE = `#!${process.execPath}
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.REC_FILE, JSON.stringify({ bin: 'stripe', args, notion: process.env.NOTION_TOKEN ?? null, notionKey: process.env.NOTION_API_KEY ?? null }) + '\\n')
if (args[1] === 'list') console.log(JSON.stringify({ object: 'list', data: [], has_more: false }))
else if (args[1] === 'create') console.log(JSON.stringify({ id: 'we_1', object: 'webhook_endpoint', secret: 'whsec_1' }))
`

type Recorded = { bin: string; args: string[]; notion: string | null; notionKey: string | null }

function sh(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t.test', '-c', 'user.name=t', ...args], { cwd })
}

const web = {
  path: 'web',
  database: { provider: 'neon', projectId: PROJECT, parentBranch: 'dev', envVars: ['DATABASE_URL'] },
  tunnel: { zone: 'client.example' },
  webhooks: [{ provider: 'stripe', path: '/api/webhooks/stripe', events: ['checkout.session.completed'] }],
}

describe('T43 F19 F14: isolation in a client worktree', () => {
  it("covers web's database, tunnel and webhooks from the repos entry, and no command env holds NOTION_TOKEN", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ai-isolation-client-')))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const repo = join(root, 'web')
    const home = join(root, 'home')
    const bin = join(root, 'bin')
    const rec = join(root, 'rec.jsonl')
    for (const dir of [repo, home, bin]) mkdirSync(dir)
    writeFileSync(join(bin, 'cloudflared'), FAKE_CLOUDFLARED)
    writeFileSync(join(bin, 'stripe'), FAKE_STRIPE)
    chmodSync(join(bin, 'cloudflared'), 0o755)
    chmodSync(join(bin, 'stripe'), 0o755)
    writeFileSync(join(root, 'aspira.json'), JSON.stringify({ statusFlow: false, pullRequest: false, repos: { web } }))
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    writeFileSync(join(repo, '.gitignore'), '.env.development.local\n.env.local\n.aspira/\n.work/\n.worktrees/\n')
    writeFileSync(join(repo, 'package.json'), '{"name":"web","private":true}\n')
    sh(repo, 'add', '-A')
    sh(repo, 'commit', '-q', '-m', 'initial')
    const worktree = join(repo, '.worktrees', 'FEATURE-WEB-1')
    sh(repo, 'worktree', 'add', '-q', '-b', 'feat/web-1', worktree)

    const created: string[] = []
    const neon: NeonSeam = {
      listBranches: async () => [
        { id: 'br-main', name: 'main', default: true },
        { id: 'br-dev', name: 'dev', default: false, parentId: 'br-main' },
      ],
      createBranch: async (projectId, spec) => {
        created.push(`${projectId}:${spec.name}`)
        return { id: 'br-1', pooled: 'postgresql://o:p@pooled.test/app', direct: 'postgresql://o:p@direct.test/app' }
      },
      deleteBranch: async () => {},
    }
    const seams: IsolationSeams = {
      neon,
      tunnel: tunnelSeam({ run: processRunner('cloudflared'), apiToken: 'cf-token' }),
      stripe: stripeSeam({ run: processRunner('stripe') }),
      portBusy: async () => false,
    }

    const saved = { PATH: process.env.PATH, REC_FILE: process.env.REC_FILE, NOTION_TOKEN: process.env.NOTION_TOKEN, NOTION_API_KEY: process.env.NOTION_API_KEY }
    cleanups.push(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    })
    process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`
    process.env.REC_FILE = rec
    process.env.NOTION_TOKEN = 'ntn_process_secret'
    process.env.NOTION_API_KEY = 'ntn_process_key'

    const lines: string[] = []
    const result = await isolate({ main: repo, worktree, ticket: 'WEB-1', seams, now: () => NOW, env: { STRIPE_SECRET_KEY: 'sk_test_x', NOTION_TOKEN: 'ntn_process_secret' }, home, log: (line) => lines.push(line) })

    const calls: Recorded[] = existsSync(rec)
      ? readFileSync(rec, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as Recorded)
      : []
    const used = (bin: string, ...prefix: string[]) => calls.some((call) => call.bin === bin && prefix.every((word, i) => call.args[i] === word))
    expect({
      result,
      database: created,
      tunnel: used('cloudflared', 'tunnel', 'create'),
      webhooks: used('stripe', 'webhook_endpoints', 'create'),
      leaked: calls.filter((call) => call.notion !== null || call.notionKey !== null).length,
      log: lines.join('\n').includes('NOTION'),
    }).toEqual({
      result: { ok: true, recreated: false },
      database: [`${PROJECT}:wt/web-1`],
      tunnel: true,
      webhooks: true,
      leaked: 0,
      log: false,
    })
  })
})
