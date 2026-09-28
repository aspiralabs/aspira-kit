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
