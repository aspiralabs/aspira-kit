// NOVA1.1: the cloud review's Run notes take the codebase map line from the helper, so opt-in off precedes cloud run.
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { cloudRunNotes } from '../export-review.ts'

const BLAST = 'Blast radius check skipped: the spec is not available in a cloud clone'

it('says opt-in off when the project never opted in, and cloud run when it did', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'export-review-')))
  expect(await cloudRunNotes(dir)).toEqual(['Codebase map: not used (opt-in off)', BLAST])
  await writeFile(join(dir, 'aspira.json'), JSON.stringify({ useCodebaseMap: false }))
  expect(await cloudRunNotes(dir)).toEqual(['Codebase map: not used (opt-in off)', BLAST])
  await writeFile(join(dir, 'aspira.json'), JSON.stringify({ useCodebaseMap: true }))
  expect(await cloudRunNotes(dir)).toEqual(['Codebase map: not used (cloud run)', BLAST])
})
