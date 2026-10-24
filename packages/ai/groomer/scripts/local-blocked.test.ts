// The groomer --local driver (scripts/local.ts) run as a real child process, the way groomer.sh runs
// it (amaro as the type-stripping hook, then Node's own stripping): a run with no guidelines and no
// NOTION_TOKEN to fetch them with ends blocked and exits 1 (F5, F52, A2). Before this, runLocal's
// blocked result fell through to the generic print and the driver exited 0. Nothing here reaches
// Notion (TEST-003): NOTION_TOKEN, NOTION_API_KEY and AI_GATEWAY_API_KEY are stripped from the env.

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { renderTicketMd } from '@aspiralabs/ai/common/lib/ticket'

const exec = promisify(execFile)
const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..')
const DRIVER = join(PACKAGE, 'scripts', 'local.ts')
const LOADER = join(PACKAGE, 'node_modules', 'amaro', 'dist', 'register-strip.mjs')
const BOARD = 'https://app.notion.com/p/3e93e59b225881bba552f8e336ad08ad'

const temps: string[] = []
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** ticket.md as the session's resolve action would have written it, current as of now. */
const ticketMd = () =>
  renderTicketMd({ id: 'KIT-9', title: 'Cart limit', url: 'https://www.notion.so/kit-9', status: 'Grooming', type: 'Feature', area: [], idea: 'Let shoppers see why the cart stops at ten items.', pulledAt: new Date().toISOString(), pages: {} })

async function drive(root: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const { NOTION_TOKEN: _token, NOTION_API_KEY: _key, AI_GATEWAY_API_KEY: _gateway, KNOWLEDGE_PAGE: _page, ...env } = process.env
  return exec(process.execPath, ['--import', LOADER, '--experimental-strip-types', DRIVER, '--repo', root, '--ticket', 'KIT-9'], { cwd: root, env }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: { code?: number; stdout?: string; stderr?: string }) => ({ code: typeof error.code === 'number' ? error.code : -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }),
  )
}

it('ends blocked with exit 1 when there are no guidelines and no NOTION_TOKEN, naming NOTION_TOKEN', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'groomer-local-blocked-')))
  temps.push(dir)
  const root = join(dir, 'repo')
  await exec('git', ['init', '-q', root])
  await writeFile(join(root, 'aspira.json'), JSON.stringify({ board: BOARD }))
  const folder = join(root, '.work', 'kit-9-cart-limit')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'idea.md'), 'Let shoppers see why the cart stops at ten items.\n')

  // The board stage first: resolve, then mark. Each call the "session" leaves ticket.md current.
  for (const action of ['resolve', 'mark']) {
    await writeFile(join(folder, 'ticket.md'), ticketMd())
    const board = await drive(root)
    expect(board.code).toBe(0)
    expect(JSON.parse(board.stdout)).toMatchObject({ pending: true, stage: 'board', actions: [expect.objectContaining({ action })] })
  }
  await writeFile(join(folder, 'ticket.md'), ticketMd())
  const blocked = await drive(root)
  expect(blocked.code).toBe(1)
  expect(JSON.parse(blocked.stdout)).toMatchObject({ pending: false, status: 'blocked', reason: expect.stringContaining('NOTION_TOKEN') })
  expect(blocked.stderr).toContain('groomer local: blocked')
})
