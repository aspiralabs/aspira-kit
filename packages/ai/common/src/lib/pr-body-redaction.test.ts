// T34 (F42, SEC-010; spec.reviewed.md S1-4): implementation.md's red output can carry whatever a
// failing test printed, including a secret from the repository's own .env files. renderPrBody must
// redact every evidence fragment — scoped to the app aspira.json names, through the widened
// redact(text, repo, { app }) that P13 moves into agent-common — before it is woven into the body,
// and the --local Step 8 note then writes that body to `.work/<id>-<slug>/pr-body.md` verbatim.
// This test renders the body and writes it the same way, then reads the file back, so the bytes on
// disk — not just the in-memory string — are proven never to carry the secret (TEST-003, TEST-007:
// nothing here is mocked; a real temp repository and a real file write stand in for the boundary).

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { renderPrBody } from './pr-body'

let repo: string | undefined

afterEach(async () => {
  if (repo !== undefined) await rm(repo, { recursive: true, force: true })
  repo = undefined
})

const ticket = { id: 'KIT-2', title: 'Every skill writes a progress note', url: 'https://app.notion.com/p/kit-2-0000000000000000000000000002' }
const DB_URL = 'postgres://user:hunter2xyz@db'

describe('renderPrBody redacts implementation.md evidence before it reaches pr-body.md (T34)', () => {
  it('writes [redacted] in pr-body.md where the red output held the app’s .env value, never the raw value', async () => {
    repo = await mkdtemp(join(tmpdir(), 'pr-body-redact-'))
    await writeFile(join(repo, 'aspira.json'), JSON.stringify({ board: 'https://www.notion.so/board', app: 'apps/web' }))
    await mkdir(join(repo, 'apps', 'web'), { recursive: true })
    await writeFile(join(repo, 'apps', 'web', '.env.local'), `DB_URL=${DB_URL}\n`)

    const implementationMd = [
      '# Implementation',
      '',
      '## Tasks',
      '',
      '| Task | Features | Lane/wave | Status | Commit | Red → green evidence |',
      '| --- | --- | --- | --- | --- | --- |',
      '| P1 | F1 | wave 1 | done | abc1111 | red |',
      '',
      '### P1 — red → green evidence',
      '',
      '- red: `pnpm --filter apps/web exec vitest run src/db.test.ts`',
      '',
      '```text',
      `connection failed: ${DB_URL}`,
      '```',
      '',
    ].join('\n')

    const body = await renderPrBody({ ticket, implementationMd, changedFiles: ['apps/web/src/db.ts'], analyzers: [], repo, app: 'apps/web' })

    const folder = join(repo, '.work', 'kit-2-every-skill')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'pr-body.md'), body)

    const written = await readFile(join(folder, 'pr-body.md'), 'utf8')
    expect({ redacted: written.includes('[redacted]'), leaked: written.includes('hunter2xyz') }).toEqual({ redacted: true, leaked: false })
  })
})
