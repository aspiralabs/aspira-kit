// T14 (F12): the kit resolves its own package, never a copy in a project's node_modules. The writer,
// the self-healing and kit doctor's harness check are covered at the CLI seam in cli.test.ts (T4-T13).
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { AI_PACKAGE, aiPackageDir, aiVersion, kitPackageDir } from './skills.js'

/** The running package's own version. */
const KIT_VERSION = (JSON.parse(readFileSync(join(dirname(dirname(fileURLToPath(import.meta.url))), 'package.json'), 'utf8')) as { version: string }).version

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('aiPackageDir', () => {
  it('T14: ignores a copy under the project node_modules and answers with the running kit', () => {
    const app = realpathSync(mkdtempSync(join(tmpdir(), 'kit-skills-')))
    dirs.push(app)
    const copy = join(app, 'node_modules', '@aspiralabs', 'ai')
    mkdirSync(copy, { recursive: true })
    writeFileSync(join(copy, 'package.json'), JSON.stringify({ name: AI_PACKAGE, version: '0.1.0' }))
    // The app folder is the working directory; the argument is passed through a cast so the case holds
    // whether or not the function still takes the app directory.
    const resolve = aiPackageDir as (appDir?: string) => string | undefined
    const version = aiVersion as (appDir?: string) => string | undefined
    const before = process.cwd()
    process.chdir(app)
    try {
      expect(resolve(app)).toBe(kitPackageDir())
      expect(version(app)).toBe(KIT_VERSION)
      expect(version(app)).not.toBe('0.1.0')
    } finally {
      process.chdir(before)
    }
  })
})

describe('skill paths in the kit source', () => {
  it('T39: no tracked packages/ai file outside tests and fixtures names .claude/skills/aspira- without the ~/ prefix', () => {
    const root = dirname(dirname(fileURLToPath(import.meta.url)))
    const tracked = execFileSync('git', ['ls-files', '-z', '--', '.'], { cwd: root, encoding: 'utf8' }).split('\0').filter((file) => file !== '')
    const skipped = /(^|\/)CHANGELOG\.md$|(\.test\.ts|\.test-helper\.ts|\.integration\.shared\.ts)$|(^|\/)(fixtures?|node_modules)\//
    const text = /\.(ts|tsx|js|mjs|sh|md|json|yml|yaml)$/
    const offenders: string[] = []
    for (const file of tracked) {
      if (skipped.test(file) || !text.test(file)) continue
      readFileSync(join(root, file), 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (/(?<!~\/)\.claude\/skills\/aspira-/.test(line)) offenders.push(`${file}:${String(index + 1)}`)
        })
    }
    expect(offenders).toEqual([])
  })
})
