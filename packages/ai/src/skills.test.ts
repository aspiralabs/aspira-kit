// T14 (F12): the kit resolves its own package, never a copy in a project's node_modules. The writer,
// the self-healing and kit doctor's harness check are covered at the CLI seam in cli.test.ts (T4-T13).
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
