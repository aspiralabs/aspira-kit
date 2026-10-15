// T6 (plan.json P1, F11): "A search of agent-common, every agent package and build-feature for
// complete, clean, confirmed, stopped, partial, nothing-detected and failed used as a run status
// returns no hit outside the F7 read mapping and its tests. Records that are not a run status
// under the Run record rule ... are exempt and listed by name in the search's exemption list."
//
// This is a real search over the TypeScript and shell sources on disk (no fixtures, no mocking:
// the sources themselves are the thing under test), restricted to the three shapes the spec
// names: a quoted status literal, a comparison against a status/runStatus/--run-status value, and
// a status enum/array entry. `NOT_RUN_STATUS` (run-status.ts, added by P14) is the exemption list
// this test reads; it fails to import until then, which is itself the expected failure before
// P14's rename lands.
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NOT_RUN_STATUS } from './run-status.ts'

/** The seven words the rename retires as a run status (Decisions Q3, Q3.1; F1, F11). */
const OLD_WORDS = ['complete', 'clean', 'confirmed', 'stopped', 'partial', 'nothing-detected', 'failed'] as const

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..')
/** The packages the spec's F11 and Blast radius name: agent-common, every agent package, build-feature. */
const SEARCH_DIRS = ['packages/agents/common/src', 'packages/agents/groomer', 'packages/agents/spec-writer', 'packages/agents/spec-reviewer', 'packages/agents/planner', 'packages/agents/implementor', 'packages/agents/code-analyzer', 'packages/agents/pr-reviewer', 'packages/agents/agents', 'packages/agents/build-feature/src'].map((dir) => join(ROOT, dir))
const SOURCE_EXTENSIONS = ['.ts', '.sh']
const SKIPPED_DIR_NAMES = new Set(['node_modules', 'dist', '.git', 'coverage'])

type Hit = { file: string; line: number; text: string; word: string }

async function listSourceFiles(dir: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    if (SKIPPED_DIR_NAMES.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await listSourceFiles(full)))
    else if (SOURCE_EXTENSIONS.includes(entry.name.slice(entry.name.lastIndexOf('.'))) && !entry.name.endsWith('.test.ts')) files.push(full)
  }
  return files
}

/** A word used as a quoted string literal (`'complete'`, `"complete"`), or in an unquoted status assignment or flag (`status=complete`, `status: complete`, `--run-status complete`). Not a bare mention in prose. */
function wordHits(line: string, word: string): boolean {
  const quoted = new RegExp(`['"\`]${word}['"\`]`)
  const assigned = new RegExp(`(?:--run-status[ =]|\\bstatus\\s*[:=]\\s*)${word}(?![A-Za-z0-9_-])`, 'i')
  return quoted.test(line) || assigned.test(line)
}

async function findHits(): Promise<Hit[]> {
  const hits: Hit[] = []
  for (const dir of SEARCH_DIRS) {
    for (const file of await listSourceFiles(dir)) {
      const text = await readFile(file, 'utf8')
      const lines = text.split('\n')
      for (const [index, line] of lines.entries()) {
        for (const word of OLD_WORDS) {
          if (wordHits(line, word)) hits.push({ file, line: index + 1, text: line.trim(), word })
        }
      }
    }
  }
  return hits
}

describe('old run-status words (T6, F11)', () => {
  it('names each exempt record by file and symbol', () => {
    expect(NOT_RUN_STATUS.length).toBeGreaterThan(0)
    for (const exempt of NOT_RUN_STATUS) {
      expect(exempt.file.length).toBeGreaterThan(0)
      expect(exempt.symbol.length).toBeGreaterThan(0)
    }
  })

  it('finds no hit outside run-status.ts (the F7 mapping) and the exemption list', async () => {
    const hits = await findHits()
    const exemptFiles = new Set(NOT_RUN_STATUS.map((exempt) => exempt.file))
    const outside = hits.filter((hit) => {
      const name = relative(ROOT, hit.file).replaceAll('\\', '/')
      if (name.endsWith('run-status.ts')) return false
      return ![...exemptFiles].some((exempt) => name.endsWith(exempt))
    })
    expect(outside, outside.map((hit) => `${relative(ROOT, hit.file)}:${hit.line} (${hit.word}): ${hit.text}`).join('\n')).toEqual([])
  })
})
