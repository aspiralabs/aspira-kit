import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KIT_VERSION, approveIgnoredBuilds, pinned, withOnlyBuiltDependencies } from './stacks/next.js'

describe('pinned', () => {
  it('pins every @aspiralabs package to the kit version and leaves others alone', () => {
    expect(pinned('@aspiralabs/ui', '0.5.0')).toBe('@aspiralabs/ui@0.5.0')
    expect(pinned('@aspiralabs/agents', '0.5.0')).toBe('@aspiralabs/agents@0.5.0')
    expect(pinned('eslint', '0.5.0')).toBe('eslint')
    expect(pinned('@aspiralabs/ui', undefined)).toBe('@aspiralabs/ui')
  })

  it('reads the kit version from this package', () => {
    const own = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(KIT_VERSION).toBe(own.version)
  })
})

describe('approveIgnoredBuilds', () => {
  const project = (yaml: string | null) => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-builds-'))
    const path = join(dir, 'pnpm-workspace.yaml')
    if (yaml !== null) writeFileSync(path, yaml)
    return path
  }

  it('approves exactly the packages pnpm named, merged with what the workspace file already approves', () => {
    const path = project('packages:\n  - apps/*\n\nonlyBuiltDependencies:\n  - sharp\n\nminimumReleaseAgeExclude:\n  - "@aspiralabs/ui@0.5.1"\n')
    const output = 'Error: ERR_PNPM_IGNORED_BUILDS\n  Ignored build scripts: core-js-pure@3.50.0, esbuild@0.25.0\n  help: Run "pnpm approve-builds"'
    expect(approveIgnoredBuilds(output, path)).toEqual(['core-js-pure', 'esbuild'])
    expect(readFileSync(path, 'utf8')).toBe('packages:\n  - apps/*\n\nonlyBuiltDependencies:\n  - core-js-pure\n  - esbuild\n  - sharp\n\nminimumReleaseAgeExclude:\n  - "@aspiralabs/ui@0.5.1"\n')
  })

  it('creates the file and the list when the project has neither, and handles scoped names', () => {
    const path = project(null)
    expect(approveIgnoredBuilds('Ignored build scripts: @prisma/engines@6.0.0', path)).toEqual(['@prisma/engines'])
    expect(readFileSync(path, 'utf8')).toBe('onlyBuiltDependencies:\n  - @prisma/engines\n')
  })

  it('appends the list to a file that has other settings but no list', () => {
    expect(withOnlyBuiltDependencies('minimumReleaseAgeExclude:\n  - "@aspiralabs/kit@0.5.1"\n', ['core-js-pure'])).toBe('minimumReleaseAgeExclude:\n  - "@aspiralabs/kit@0.5.1"\n\nonlyBuiltDependencies:\n  - core-js-pure\n')
  })

  it('does nothing when the output names no ignored builds', () => {
    const path = project('packages:\n  - apps/*\n')
    expect(approveIgnoredBuilds('ERR_PNPM_FETCH_404 not found', path)).toEqual([])
    expect(readFileSync(path, 'utf8')).toBe('packages:\n  - apps/*\n')
  })
})
