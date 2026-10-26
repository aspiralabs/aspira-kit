// KIT-69 T36 (F30, F31): the live run on a real repository, skipped unless CODEBASE_MAP_LIVE_REPO names
// one on this machine (dependencies installed). The final verification runs it on an Aspira Next.js
// product and on BATTALION/loantrack-web (with codebaseMaps in BATTALION/aspira.json).
//   CODEBASE_MAP_LIVE_REPO      the repository to map (its working directory is the cwd of the run)
//   CODEBASE_MAP_LIVE_TARGET    a module of that repository other files import through the @/ alias
//   CODEBASE_MAP_LIVE_MAP_ROOT  optional: the folder the map must land in (the harness layout); when set
//                               the run must also leave `git status --porcelain` unchanged
// The run is the installed kit's own command: node <this package>/dist/cli.js map-codebase.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import type { Packet } from './fixture.test-helper.ts'

const exec = promisify(execFile)
const REPO = process.env.CODEBASE_MAP_LIVE_REPO
const TARGET = process.env.CODEBASE_MAP_LIVE_TARGET
const MAP_ROOT = process.env.CODEBASE_MAP_LIVE_MAP_ROOT
const KIT = fileURLToPath(new URL('../../dist/cli.js', import.meta.url))

const run = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
  try {
    const done = await exec('node', [KIT, ...args], { cwd: REPO, maxBuffer: 64 * 1024 * 1024, timeout: 900_000 })
    return { code: 0, ...done }
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string }
    return { code: typeof failed.code === 'number' ? failed.code : 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' }
  }
}
const status = async (): Promise<string> => (await exec('git', ['-C', REPO!, 'status', '--porcelain'])).stdout

describe.skipIf(REPO === undefined || TARGET === undefined)('F30, F31: a live repository', () => {
  it('T36: the map records @/ imports as internal edges, the brief lists the target’s importers, and a harness map leaves the repo untouched', async () => {
    const before = await status()
    const built = await run(['map-codebase'])
    const brief = await run(['map-codebase', 'brief', TARGET!, '--json'])
    const packet = JSON.parse(brief.stdout) as Packet
    console.log(`live map: ${built.stdout.trim()}\nimpact of ${TARGET}: ${packet.impact.length} paths, e.g. ${packet.impact.slice(0, 3).join(', ')}`)
    expect({
      built: built.code,
      briefed: brief.code,
      importers: packet.impact.length > 0,
      map: MAP_ROOT === undefined ? true : existsSync(join(MAP_ROOT, 'map', 'manifest.json')),
      untouched: MAP_ROOT === undefined ? true : (await status()) === before,
    }).toEqual({ built: 0, briefed: 0, importers: true, map: true, untouched: true })
  }, 1_200_000)
})
