// visual-verify.ts is created by KIT-58 (P5): this file is its contract, written before the module.
// T1: the aspira.json `dev` entry schema and its localhost-only url check (F2). T2: the one renderer
// that lists findings by grade and the notices apart, redacting every untrusted fragment (F7, F8,
// F12, F14, F15). Nothing is mocked: a real temp repository with a .env stands in for the boundary.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { devServerSchema, localDevUrl, visualVerifyLines, visualVerifyReport, type VisualVerifyResult } from './visual-verify.ts'

const temps: string[] = []
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'visual-verify-'))
  temps.push(dir)
  return dir
}

describe('devServerSchema and localDevUrl (T1)', () => {
  it('accepts the three loopback http(s) urls', () => {
    for (const url of ['http://localhost:3000', 'https://127.0.0.1:8443/admin', 'http://[::1]:5173']) {
      expect(localDevUrl(url), url).toEqual({ ok: true })
    }
  })

  it('rejects a remote host, a private address, file: and ftp: with a reason naming the url', () => {
    for (const url of ['https://example.com', 'http://10.0.0.5:3000', 'file:///tmp/x', 'ftp://localhost']) {
      const result = localDevUrl(url)
      expect(result.ok, url).toBe(false)
      expect('reason' in result ? result.reason : '').toContain(url)
    }
  })

  it('defaults cwd to "." and backendDeployed to false', () => {
    const parsed = devServerSchema.parse({ command: 'pnpm dev', url: 'http://localhost:3000' })
    expect(parsed).toMatchObject({ cwd: '.', command: 'pnpm dev', url: 'http://localhost:3000', backendDeployed: false })
  })
})

describe('visualVerifyLines and visualVerifyReport (T2)', () => {
  const ran: VisualVerifyResult = {
    status: 'blocked',
    verifications: 1,
    viewport: '1280x800',
    findings: [
      { grade: 'minor', title: 'icon is 1px off', page: '/admin/models', files: [], deployedBackend: false },
      { grade: 'blocker', title: 'every price is a dash sk-live-fixture-123 <script>alert(1)</script>', page: '/admin/models', files: ['src/prices.ts'], deployedBackend: false },
      { grade: 'major', title: 'columns are clipped', page: '/admin/models', files: [], deployedBackend: false },
    ],
    notExercised: [
      { page: '/admin/models', action: 'Re-check all', reason: 'can accept third-party EULAs' },
      { page: '/admin/models', action: 'Delete model', reason: 'irreversible' },
    ],
    backendNotDeployed: [{ route: '/api/admin/models/recheck' }],
    noData: [{ page: '/admin/empty' }],
  }
  const skipped: VisualVerifyResult = {
    status: 'skipped',
    verifications: 0,
    skipReason: 'no Chrome tool',
    findings: [],
    notExercised: [],
    backendNotDeployed: [],
    noData: [],
  }

  async function render(result: VisualVerifyResult): Promise<{ lines: string; report: string }> {
    const repo = await tempRepo()
    await writeFile(join(repo, '.env'), 'SECRET_VALUE=sk-live-fixture-123\n')
    const lines = (await visualVerifyLines(result, repo, {})).join('\n')
    const report = await visualVerifyReport(result, ['visual-verify/models.png'], repo, {})
    return { lines, report }
  }

  it('lists findings blocker, major, minor whatever the input order', async () => {
    const { lines } = await render(ran)
    const at = (text: string) => lines.indexOf(text)
    expect(at('every price is a dash')).toBeGreaterThanOrEqual(0)
    expect(at('every price is a dash')).toBeLessThan(at('columns are clipped'))
    expect(at('columns are clipped')).toBeLessThan(at('icon is 1px off'))
  })

  it('never carries the .env secret and escapes the tag', async () => {
    const { lines, report } = await render(ran)
    for (const text of [lines, report]) {
      expect(text).not.toContain('sk-live-fixture-123')
      expect(text).not.toContain('<script>')
    }
  })

  it('lists not-exercised actions, backend not deployed (unverified) and no data apart from the findings', async () => {
    const { lines } = await render(ran)
    expect(lines).toContain('Re-check all')
    expect(lines).toContain('Delete model')
    expect(lines).toContain('backend not deployed (unverified)')
    expect(lines).toContain('/api/admin/models/recheck')
    expect(lines).toContain('no data to check')
    expect(lines).toContain('/admin/empty')
    const notices = lines.indexOf('backend not deployed (unverified)')
    expect(lines.indexOf('icon is 1px off')).toBeLessThan(notices)
  })

  it('names the skip reason and never says passed for a skipped result', async () => {
    const { lines, report } = await render(skipped)
    expect(lines).toContain('no Chrome tool')
    expect(lines.toLowerCase()).not.toContain('passed')
    expect(report.toLowerCase()).not.toContain('passed')
  })
})
