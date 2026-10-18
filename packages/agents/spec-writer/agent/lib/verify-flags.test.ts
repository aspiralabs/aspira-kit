// T21 (F24): "Only the implementor's --verify accepts --pr-url; every other skill's --verify rejects
// the flag with a usage error and touches no board property" (plan P21). The spec writer is the
// sibling under test: its driver (scripts/local.ts) takes no --pr-url option at all, so passing one
// with --verify must fail argument parsing before any board work starts. Seam: scripts/local.ts as a
// real child process (TEST-005), observed through its exit code and stdout/stderr.

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { renderTicketMd, workFolderName } from '@aspiralabs/agent-common/lib/ticket'
import { afterEach, expect, it } from 'vitest'

const exec = promisify(execFile)
const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '../..')
const DRIVER = join(PACKAGE, 'scripts/local.ts')

const temps: string[] = []
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'spec-writer-verify-flags-'))
  temps.push(dir)
  const root = join(dir, 'repo')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'aspira.json'), `${JSON.stringify({ board: 'https://app.notion.com/p/3e93e59b225881bba552f8e336ad08ad', repository: 'aspiralabs/kit' }, null, 2)}\n`)
  const folder = join(root, '.work', workFolderName({ id: 'KIT-2', title: 'Every skill writes a progress note' }))
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(folder, 'ticket.md'),
    renderTicketMd({ id: 'KIT-2', title: 'Every skill writes a progress note', url: 'https://app.notion.com/p/kit-2-0000000000000000000000000002', status: 'In Review: Spec', type: 'Feature', area: [], pulledAt: new Date().toISOString(), idea: 'Build it.', pages: {} }),
  )
  return root
}

it('--verify --pr-url exits 2 with a usage error naming --pr-url and prints no board action', async () => {
  const root = await project()
  const { NOTION_TOKEN: _token, NOTION_API_KEY: _key, AI_GATEWAY_API_KEY: _gateway, ...rest } = process.env
  const outcome = await exec(process.execPath, ['--experimental-strip-types', DRIVER, '--repo', root, '--ticket', 'KIT-2', '--verify', '--pr-url', 'https://github.com/aspiralabs/kit/pull/7'], { cwd: root, env: rest }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: { code?: number; stdout?: string; stderr?: string }) => ({ code: typeof error.code === 'number' ? error.code : -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }),
  )
  expect({ exit: outcome.code, namesFlag: outcome.stderr.includes('--pr-url'), stdout: outcome.stdout.trim() }).toEqual({ exit: 2, namesFlag: true, stdout: '' })
})
