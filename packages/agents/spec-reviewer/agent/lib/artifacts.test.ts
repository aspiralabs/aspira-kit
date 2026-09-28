import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { writeArtifacts } from './artifacts.ts'

it('publishes direct artifacts and archives reruns without leaving a stale reviewed spec', async () => {
  const base = await mkdtemp(join(tmpdir(), 'spec-review-artifacts-'))
  const dir = join(base, 'spec.reviewed')
  await writeArtifacts(dir, { 'trace/review.json': '{"status":"ready"}', 'spec.reviewed.md': 'old candidate', 'run-analysis.md': 'old cost' })
  await writeArtifacts(dir, { 'trace/review.json': '{"status":"incomplete"}', 'trace/findings.md': 'new findings', 'run-analysis.md': 'new cost' })
  expect(await readFile(join(dir, 'run-analysis.md'), 'utf8')).toBe('new cost')
  await expect(readFile(join(dir, 'spec.reviewed.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  const history = join(dir, 'trace/history')
  const [run] = await readdir(history)
  expect(await readFile(join(history, run!, 'spec.reviewed.md'), 'utf8')).toBe('old candidate')
  expect((await readdir(base)).sort()).toEqual(['spec.reviewed'])
})

it('refuses to replace unrelated output or publish over an active writer', async () => {
  const base = await mkdtemp(join(tmpdir(), 'spec-review-output-'))
  const dir = join(base, 'custom')
  await mkdir(dir)
  await writeFile(join(dir, 'keep.md'), 'keep')
  await expect(writeArtifacts(dir, { 'trace/review.json': '{}' })).rejects.toThrow('without trace/review.json')
  expect(await readFile(join(dir, 'keep.md'), 'utf8')).toBe('keep')
  await mkdir(`${dir}.lock`)
  await expect(writeArtifacts(dir, { 'trace/review.json': '{}' })).rejects.toThrow('Another review')
})
