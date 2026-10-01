import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { allowedPath, evidencePacket, repository } from './repository.ts'

it('selects referenced source and direct dependencies, and marks incomplete excerpts', () => {
  const files = new Map([
    ['apps/web/components/item-card.tsx', "import { value } from '@/lib/value'\nfetch('/api/items?own=true')\nexport const Card = value"],
    ['apps/web/app/api/items/route.ts', 'const query = "SELECT * FROM items LIMIT 10"'],
    ['apps/web/lib/value.ts', 'export const value = 1'],
    ['prisma/schema.prisma', 'model Item {}'],
    ['apps/web/auth.config.ts', "const policy = ['/api/unrelated']"],
    ['apps/web/app/api/unrelated/route.ts', 'IRRELEVANT POLICY ROUTE'],
    ['unrelated.ts', 'DO NOT SELECT THIS'],
  ])
  const packet = evidencePacket('Reuse `ItemCard`.', files)
  expect(packet).toContain('SOURCE apps/web/components/item-card.tsx')
  expect(packet).toContain('1: export const value = 1')
  expect(packet).toContain('model Item {}')
  expect(packet).toContain('SOURCE apps/web/app/api/items/route.ts')
  expect(packet).toContain('observed result bounds:')
  expect(packet).not.toContain('DO NOT SELECT THIS')
  expect(packet).not.toContain('IRRELEVANT POLICY ROUTE')
  files.set('prisma/schema.prisma', 'x'.repeat(50_000))
  expect(evidencePacket('', files)).toContain('PACKET EXCERPT TRUNCATED')
})

it('keeps bare words from flooding the packet and puts exact target paths first', () => {
  const files = new Map<string, string>()
  // Forty large route pages that a bare `page` reference would match by suffix.
  for (let i = 0; i < 40; i++) files.set(`apps/web/app/(app)/area-${i}/page.tsx`, `NOISE PAGE ${i}\n${'x'.repeat(3_000)}`)
  files.set('apps/web/lib/api/api-fetcher.ts', 'export const TARGET_FETCHER = 1')
  files.set('apps/mobile/app/meal-plan.tsx', 'export const TARGET_MOBILE = 1')
  files.set('apps/web/app/api/v1/users/[id]/cookbooks/route.ts', 'export const TARGET_ROUTE = 1')
  const spec = [
    'The fetcher sends `page` and reads `q`, `sort` and `limit`.',
    '**Files:** `apps/web/lib/api/api-fetcher.ts`; `apps/mobile/app/meal-plan.tsx`; `apps/web/app/api/v1/users/[id]/cookbooks/route.ts`.',
  ].join('\n')
  const packet = evidencePacket(spec, files)
  expect(packet).toContain('TARGET_FETCHER')
  expect(packet).toContain('TARGET_MOBILE')
  expect(packet).toContain('TARGET_ROUTE')
  expect(packet).not.toContain('NOISE PAGE')
  // A full path is still selected, and comes before looser matches, when it shares a basename with many files.
  files.set('apps/web/app/(app)/recipes/page.tsx', 'export const TARGET_PAGE = 1')
  const ordered = evidencePacket('See `ItemCard` and `apps/web/app/(app)/recipes/page.tsx`.', new Map([...files, ['apps/web/components/item-card.tsx', 'export const CARD = 1']]))
  expect(ordered).toContain('TARGET_PAGE')
  expect(ordered).not.toContain('NOISE PAGE')
  expect(ordered.indexOf('TARGET_PAGE')).toBeLessThan(ordered.indexOf('export const CARD'))
})

it('shares the packet budget so a large file cannot crowd out small targets', () => {
  const files = new Map<string, string>()
  const names = ['a', 'b', 'c'].map((n) => `apps/web/big-${n}.tsx`)
  for (const name of names) files.set(name, `BIG ${name}\n${'y'.repeat(60_000)}`)
  files.set('apps/web/small-route.ts', 'export const SMALL_TARGET = 1')
  const packet = evidencePacket(`Files: ${names.map((n) => `\`${n}\``).join(', ')}, \`apps/web/small-route.ts\`.`, files)
  expect(packet).toContain('SMALL_TARGET')
  for (const name of names) expect(packet).toContain(`SOURCE ${name}`)
  expect(packet).toContain('PACKET EXCERPT TRUNCATED')
  expect(packet.length).toBeLessThan(120_000)
})

it('blocks secret files and symlinks outside the root from the readable snapshot', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'spec-review-test-'))
  const root = join(parent, 'repo')
  await mkdir(root)
  const exec = promisify(execFile)
  await exec('git', ['init', root])
  await writeFile(join(root, 'feature.ts'), 'export const feature = true\n')
  await writeFile(join(root, '.env.local'), 'SECRET=hidden')
  await writeFile(join(parent, 'external.txt'), 'OUTSIDE')
  await symlink(join(parent, 'external.txt'), join(root, 'escape.ts'))
  await exec('git', ['-C', root, 'add', '.'])
  await exec('git', ['-C', root, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'fixture'])
  const repo = await repository(root)
  const options = { toolCallId: 'test', messages: [], context: {} }
  const read = await repo.tools.read_files.execute!({ files: [{ path: '../external.txt', start: 1, lines: 10 }, { path: 'escape.ts', start: 1, lines: 10 }, { path: '.env.local', start: 1, lines: 10 }] }, options)
  expect(JSON.stringify(read)).not.toContain('OUTSIDE')
  expect(JSON.stringify(read)).not.toContain('SECRET=')
  expect(JSON.stringify(read)).toContain('Not in readable snapshot')
  expect(allowedPath('nested/.env')).toBe(false)
  expect(allowedPath('credentials.json')).toBe(false)
  expect(allowedPath('.npmrc')).toBe(false)
  expect(allowedPath('docs/spec.debate.10-v2-run5/conversation.md')).toBe(false)
  expect(allowedPath('docs/spec.reviewed/findings.md')).toBe(false)
  expect(allowedPath('docs/spec.reviewed.history/run-a/findings.md')).toBe(false)
})
