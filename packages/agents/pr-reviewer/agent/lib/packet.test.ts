import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AREA_RULES, MAX_FULL_FILE_CHARS, MAX_SYMBOLS_PER_FILE, areaOf, buildPacket, hunksFor, indexEntries, packetTokens, splitPatch, symbolOf, truncateForRead } from './packet.ts'
import { SEATS, openingPrompt, sharedPrefix, turnPrompt, verifyPrompt, type PrContext } from './review.ts'

const lines = (n: number, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n'

// A fixture PR across the areas: an API route, a migration, a web component, a mobile screen, a
// test, docs, config, and a deleted file.
const PATCH = [
  'diff --git a/apps/web/app/api/v1/search/route.ts b/apps/web/app/api/v1/search/route.ts',
  '--- a/apps/web/app/api/v1/search/route.ts',
  '+++ b/apps/web/app/api/v1/search/route.ts',
  '@@ -10,3 +10,8 @@ export const GET = betterRoute(async (req) => {',
  '   const q = url.searchParams.get(\'q\')',
  '+  const cursor = parseCursor(url)',
  '+export function parseCursor(url: URL): Cursor | null {',
  '+  return null',
  '+}',
  '+export const CURSOR_NAMESPACE = \'search\'',
  '-export type Legacy = string',
  '   return ok(q)',
  'diff --git a/apps/web/prisma/migrations/20261001_cursor/migration.sql b/apps/web/prisma/migrations/20261001_cursor/migration.sql',
  '--- /dev/null',
  '+++ b/apps/web/prisma/migrations/20261001_cursor/migration.sql',
  '@@ -0,0 +1,2 @@',
  '+CREATE INDEX "Recipe_createdAt_id_idx" ON "Recipe"("createdAt", "id");',
  '+ALTER TABLE "Recipe" ADD COLUMN "ratingCount" INTEGER;',
  'diff --git a/apps/web/components/recipe/recipe-card.tsx b/apps/web/components/recipe/recipe-card.tsx',
  '--- a/apps/web/components/recipe/recipe-card.tsx',
  '+++ b/apps/web/components/recipe/recipe-card.tsx',
  '@@ -5,2 +5,3 @@ export function RecipeCard({ recipe }: Props) {',
  '   const title = recipe.title',
  '+  const nested = compute(title)',
  '   return <Card>{title}</Card>',
  'diff --git a/apps/mobile/app/(tabs)/explore.tsx b/apps/mobile/app/(tabs)/explore.tsx',
  '--- a/apps/mobile/app/(tabs)/explore.tsx',
  '+++ b/apps/mobile/app/(tabs)/explore.tsx',
  '@@ -1,2 +1,3 @@',
  ' import { View } from \'react-native\'',
  '+export default function ExploreScreen() {',
  ' const styles = StyleSheet.create({})',
  'diff --git a/apps/web/lib/api/cursor.test.ts b/apps/web/lib/api/cursor.test.ts',
  '--- /dev/null',
  '+++ b/apps/web/lib/api/cursor.test.ts',
  '@@ -0,0 +1,2 @@',
  '+describe(\'cursor\', () => {',
  '+  it(\'round-trips\', () => {})',
  'diff --git a/docs/plans/nom-4/spec.md b/docs/plans/nom-4/spec.md',
  '--- a/docs/plans/nom-4/spec.md',
  '+++ b/docs/plans/nom-4/spec.md',
  '@@ -1,1 +1,2 @@',
  ' # NOM-4',
  '+## Cursor pagination',
  'diff --git a/apps/web/package.json b/apps/web/package.json',
  '--- a/apps/web/package.json',
  '+++ b/apps/web/package.json',
  '@@ -3,1 +3,1 @@',
  '-  "version": "1.0.0",',
  '+  "version": "1.1.0",',
  'diff --git a/gone.ts b/gone.ts',
  'deleted file mode 100644',
  '--- a/gone.ts',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-export const gone = true',
  '',
].join('\n')
const CHANGED = ['apps/web/app/api/v1/search/route.ts', 'apps/web/prisma/migrations/20261001_cursor/migration.sql', 'apps/web/components/recipe/recipe-card.tsx', 'apps/mobile/app/(tabs)/explore.tsx', 'apps/web/lib/api/cursor.test.ts', 'docs/plans/nom-4/spec.md', 'apps/web/package.json', 'gone.ts']
const REQUIRED = '# Agent Instructions\n\nREV-001 Read the rules.\n'

const fixture = () => buildPacket({ label: 'o/n#1', description: '# Cursor paging\n\n- Base: main (abc1234)\n', patch: PATCH, changed: CHANGED, required: REQUIRED })

/** A hunk line: `@@`, or a `+`/`-` followed by code. An index line starts with `- ` (a list dash and a space). */
const HUNK_LINE = /^(@@|[+-](?![ -]|$))/m

describe('areaOf', () => {
  it('tags by path, tests and e2e before the app they live in, config and docs before code, mobile before web-ui', () => {
    const cases: [string, string][] = [
      ['apps/web/e2e/search-pagination.spec.ts', 'e2e'],
      ['apps/mobile/__tests__/screens/meal-plan.test.tsx', 'test'],
      ['apps/web/tests/integration/search-pagination.test.ts', 'test'],
      ['apps/web/tests/msw.ts', 'test'],
      ['apps/web/prisma/migrations/20261001_cursor/migration.sql', 'db-migration'],
      ['apps/web/prisma/schema.prisma', 'db-migration'],
      ['infra/app.tf', 'infra'],
      ['.github/workflows/ci.yml', 'infra'],
      ['apps/web/package.json', 'config'],
      ['apps/web/pnpm-lock.yaml', 'config'],
      ['apps/web/eslint.config.mjs', 'config'],
      ['AGENTS.md', 'docs'],
      ['docs/plans/nom-4/spec.md', 'docs'],
      ['apps/web/app/api/v1/search/route.ts', 'api'],
      ['apps/web/lib/api/cursor.ts', 'api'],
      ['apps/mobile/app/(tabs)/explore.tsx', 'mobile'],
      ['apps/mobile/lib/api.ts', 'mobile'],
      ['apps/web/components/recipe/recipe-card.tsx', 'web-ui'],
      ['apps/web/app/(app)/recipes/page.tsx', 'web-ui'],
      ['apps/web/lib/auth/session.ts', 'lib'],
      ['apps/web/types/search.ts', 'lib'],
    ]
    for (const [path, area] of cases) expect(areaOf(path), path).toBe(area)
    expect(AREA_RULES.map(([, area]) => area)).toEqual(['e2e', 'test', 'db-migration', 'infra', 'config', 'docs', 'api', 'mobile', 'web-ui'])
  })
})

describe('symbolOf', () => {
  it('reads declarations and routes, not statements', () => {
    expect(symbolOf('export async function GET(req: Request) {')).toBe('GET')
    expect(symbolOf('export default function ExploreScreen() {')).toBe('ExploreScreen')
    expect(symbolOf('export const GET = betterRoute(async (req) => {')).toBe('GET')
    expect(symbolOf('export class CursorError extends Error {')).toBe('CursorError')
    expect(symbolOf('export type Cursor = { id: string }')).toBe('Cursor')
    expect(symbolOf('export interface Props {')).toBe('Props')
    expect(symbolOf('export { a, b as c }')).toBe('a, c')
    expect(symbolOf("router.get('/recipes/:id', handler)")).toBe('GET /recipes/:id')
    expect(symbolOf('const styles = StyleSheet.create({')).toBe('styles')
    expect(symbolOf("describe('cursor', () => {")).toBe('describe cursor')
    expect(symbolOf('type Props = {')).toBe('Props')
    // Nested locals are not symbols; a hunk header's context is read as a declaration even when indented.
    expect(symbolOf('      const parsed = schema.safeParse(next)')).toBeNull()
    expect(symbolOf('      const parsed = schema.safeParse(next)', { nested: true })).toBe('parsed')
    expect(symbolOf('  return ok(q)')).toBeNull()
    expect(symbolOf('import { View } from \'react-native\'')).toBeNull()
  })
  it('reads SQL, Prisma, YAML, JSON and Markdown', () => {
    expect(symbolOf('CREATE INDEX "Recipe_createdAt_id_idx" ON "Recipe"("createdAt", "id");')).toBe('INDEX Recipe_createdAt_id_idx')
    expect(symbolOf('ALTER TABLE "Recipe" ADD COLUMN "ratingCount" INTEGER;')).toBe('TABLE Recipe')
    expect(symbolOf('CREATE TABLE IF NOT EXISTS public.cursor_cache (')).toBe('TABLE public.cursor_cache')
    expect(symbolOf('model Recipe {')).toBe('model Recipe')
    // `enum X {` reads the same in TypeScript and Prisma; the name is what matters.
    expect(symbolOf('enum Visibility {')).toBe('Visibility')
    expect(symbolOf('jobs:')).toBe('jobs')
    expect(symbolOf('  steps:')).toBeNull()
    expect(symbolOf('  "version": "1.1.0",')).toBe('version')
    expect(symbolOf('## Cursor pagination')).toBe('Cursor pagination')
  })
})

describe('indexEntries', () => {
  it('counts added and deleted lines per file and lists the symbols its hunks touch, in order, without repeats', () => {
    const entries = indexEntries(PATCH, CHANGED)
    expect(entries[0]).toEqual({ path: 'apps/web/app/api/v1/search/route.ts', additions: 5, deletions: 1, area: 'api', symbols: ['GET', 'parseCursor', 'CURSOR_NAMESPACE', 'Legacy'], moreSymbols: 0 })
    expect(entries[1]).toMatchObject({ area: 'db-migration', additions: 2, deletions: 0, symbols: ['INDEX Recipe_createdAt_id_idx', 'TABLE Recipe'] })
    // The hunk header names the enclosing component; the nested local inside it is not a symbol.
    expect(entries[2]).toMatchObject({ area: 'web-ui', symbols: ['RecipeCard'] })
    expect(entries[3]).toMatchObject({ area: 'mobile', symbols: ['ExploreScreen'] })
    expect(entries[4]).toMatchObject({ area: 'test', symbols: ['describe cursor'] })
    expect(entries[5]).toMatchObject({ area: 'docs', symbols: ['Cursor pagination'] })
    expect(entries[6]).toMatchObject({ area: 'config', additions: 1, deletions: 1, symbols: ['version'] })
    expect(entries[7]).toMatchObject({ path: 'gone.ts', area: 'lib', additions: 0, deletions: 1, symbols: ['gone'] })
  })
  it('caps the symbols per file and counts the rest', () => {
    const many = ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -1,0 +1,20 @@', ...Array.from({ length: 20 }, (_, i) => `+export const s${i} = ${i}`)].join('\n')
    const [entry] = indexEntries(many, ['x.ts'])
    expect(entry!.symbols).toHaveLength(MAX_SYMBOLS_PER_FILE)
    expect(entry!.moreSymbols).toBe(20 - MAX_SYMBOLS_PER_FILE)
  })
})

describe('buildPacket', () => {
  it('holds the required reading, the pull request and one index line per changed file, and nothing of the diff itself', () => {
    const packet = fixture()
    expect(packet.text).toContain('# Review packet: o/n#1')
    expect(packet.text).toContain(REQUIRED.trim())
    expect(packet.text).toContain('# Cursor paging')
    expect(packet.text).toContain('## Changed files (8 files, +13/-3; api 1, config 1, db-migration 1, docs 1, lib 1, mobile 1, test 1, web-ui 1)')
    expect(packet.text).toContain('- `apps/web/app/api/v1/search/route.ts` +5/-1 · api · GET, parseCursor, CURSOR_NAMESPACE, Legacy\n')
    expect(packet.text).toContain('- `gone.ts` +0/-1 · lib · gone\n')
    expect(packet.text).not.toMatch(HUNK_LINE)
    expect(packet.text).not.toContain('return null')
    expect(packet.text).not.toContain('```')
    expect(packet).toMatchObject({ files: 8, areas: { api: 1, 'db-migration': 1, 'web-ui': 1, mobile: 1, test: 1, docs: 1, config: 1, lib: 1 } })
    expect(packet.chars).toBe(packet.text.length)
    expect(packet.tokens).toBe(packetTokens(packet.chars))
  })

  it('says it is an index and how to fetch by lens', () => {
    const text = fixture().text
    expect(text).toContain('It is an index of the change, not the change')
    expect(text).toContain('fetch their hunks with one `read_diff(paths)` call')
    expect(text).toContain('do not fetch what you will not review')
  })

  it('is deterministic', () => {
    expect(fixture().text).toBe(fixture().text)
  })

  it('on nomnomzz PR #3 (68 files, 12,448 changed lines) stays under 15,000 tokens, required reading included', () => {
    const dir = join(import.meta.dirname, '..', '..', 'fixtures', 'nom-4-pr3')
    const patch = readFileSync(join(dir, 'pr.patch'), 'utf8')
    const description = readFileSync(join(dir, 'pr.md'), 'utf8')
    const changed = [...splitPatch(patch).keys()]
    expect(changed).toHaveLength(68)
    // A required reading the size of the org's two required pages, about 4,000 tokens.
    const required = `# Agent Instructions\n\n${lines(260, 'REV-000 — MUST check one more thing about the diff before writing a finding, and quote the search')}`
    const packet = buildPacket({ label: 'aspiralabs/nomnomzz#3', description, patch, changed, required })
    expect(packetTokens(required.length)).toBeGreaterThan(3_500)
    expect(packet.files).toBe(68)
    expect(packet.tokens).toBeLessThan(15_000)
    expect(packet.text).not.toMatch(HUNK_LINE)
    expect(packet.text).toContain('- `apps/web/app/api/v1/search/route.ts` +')
    expect(packet.text).toContain('· api · ')
    expect(packet.text).toContain('- `apps/mobile/app/(tabs)/explore.tsx` +')
    expect(Object.keys(packet.areas).sort()).toEqual(['api', 'config', 'docs', 'e2e', 'lib', 'mobile', 'test', 'web-ui'])
    // The same patch as a whole would be the old packet: far over.
    expect(packetTokens(patch.length)).toBeGreaterThan(150_000)
  })

  it('is at the start of the shared prefix and in no seat turn, so it is sent once per session', () => {
    const packet = fixture()
    const pr: PrContext = { label: 'o/n#1', repoPath: '/workspace/repo', packet: packet.text }
    const prefix = sharedPrefix(pr)
    expect(prefix.startsWith(packet.text)).toBe(true)
    expect(prefix.slice(0, packet.text.length)).toBe(pr.packet)
    for (const turn of [...SEATS.map((seat) => openingPrompt(seat, pr)), ...SEATS.map((seat) => turnPrompt(seat, 2, pr)), verifyPrompt(1, pr)]) expect(turn).not.toContain('# Review packet')
    expect(sharedPrefix({ ...pr, packet: null })).not.toContain('# Review packet')
  })
})

describe('hunksFor (read_diff)', () => {
  it('returns each requested file\'s section of the patch, a pointer for a path the diff does not change, and cuts a large one', () => {
    const [route, missing] = hunksFor(PATCH, ['apps/web/app/api/v1/search/route.ts', 'nope.ts'])
    expect(route).toMatchObject({ path: 'apps/web/app/api/v1/search/route.ts', truncated: false })
    expect(route!.hunks).toContain('diff --git a/apps/web/app/api/v1/search/route.ts')
    expect(route!.hunks).toContain('+export function parseCursor(url: URL): Cursor | null {')
    expect(route!.hunks).not.toContain('migration.sql')
    expect(missing).toEqual({ path: 'nope.ts', error: 'not in the diff: nope.ts. The index in the packet lists every changed path; copy one from there.' })
    const big = ['diff --git a/big.ts b/big.ts', '--- a/big.ts', '+++ b/big.ts', '@@ -1,0 +1,3000 @@', ...Array.from({ length: 3000 }, (_, i) => `+const x${i} = ${'y'.repeat(20)}`)].join('\n')
    const [cut] = hunksFor(big, ['big.ts'])
    expect(cut!.truncated).toBe(true)
    expect(cut!.hunks!.length).toBeLessThanOrEqual(MAX_FULL_FILE_CHARS + 200)
    expect(cut!.hunks).toMatch(/… truncated at [\d,]+ of [\d,]+ characters of this file's hunks\. read_files the file at HEAD for the rest, or search within it\.\n$/)
  })
})

describe('truncateForRead', () => {
  it('returns a small file whole, numbered, and cuts a large file at a line boundary with a pointer', () => {
    expect(truncateForRead('export const a = 2\nexport const b = 3\n')).toEqual({ text: '1 | export const a = 2\n2 | export const b = 3\n', lines: 2, truncated: false })
    const read = truncateForRead(lines(3000, 'const x ='))
    expect(read.truncated).toBe(true)
    expect(read.lines).toBe(3000)
    expect(read.text.length).toBeLessThanOrEqual(MAX_FULL_FILE_CHARS + 200)
    expect(read.text).toMatch(/\n… truncated at [\d,]+ characters; the file has 3,000 lines\. Use search to find the lines you need, then read_file for that range\.\n$/)
  })
})
