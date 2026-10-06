import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KIT_VERSION, approveIgnoredBuilds, pinned, withAllowBuilds } from './stacks/next.js'

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

  it("replaces pnpm's placeholder with true and keeps every other line", () => {
    const path = project("allowBuilds:\n  core-js-pure: set this to true or false\nminimumReleaseAgeExclude:\n  - '@aspiralabs/ui@0.5.2'\n")
    const output = 'Error: ERR_PNPM_IGNORED_BUILDS\n  Ignored build scripts: core-js-pure@3.50.0\n  help: Run "pnpm approve-builds"'
    expect(approveIgnoredBuilds(output, path)).toEqual(['core-js-pure'])
    expect(readFileSync(path, 'utf8')).toBe("allowBuilds:\n  core-js-pure: true\nminimumReleaseAgeExclude:\n  - '@aspiralabs/ui@0.5.2'\n")
  })

  it('adds names to an existing block, sorted, and leaves earlier approvals alone', () => {
    expect(withAllowBuilds('packages:\n  - apps/*\n\nallowBuilds:\n  sharp: true\n  esbuild: false\n', ['unrs-resolver', '@prisma/engines'])).toBe('packages:\n  - apps/*\n\nallowBuilds:\n  @prisma/engines: true\n  esbuild: false\n  sharp: true\n  unrs-resolver: true\n')
  })

  it('creates the file and the block when the project has neither', () => {
    const path = project(null)
    expect(approveIgnoredBuilds('Ignored build scripts: core-js-pure@3.50.0, unrs-resolver@1.12.2', path)).toEqual(['core-js-pure', 'unrs-resolver'])
    expect(readFileSync(path, 'utf8')).toBe('allowBuilds:\n  core-js-pure: true\n  unrs-resolver: true\n')
  })

  it('puts the block first in a file that has other settings but no block', () => {
    expect(withAllowBuilds("minimumReleaseAgeExclude:\n  - '@aspiralabs/kit@0.5.2'\n", ['core-js-pure'])).toBe("allowBuilds:\n  core-js-pure: true\n\nminimumReleaseAgeExclude:\n  - '@aspiralabs/kit@0.5.2'\n")
  })

  it('does nothing when the output names no ignored builds', () => {
    const path = project('packages:\n  - apps/*\n')
    expect(approveIgnoredBuilds('ERR_PNPM_FETCH_404 not found', path)).toEqual([])
    expect(readFileSync(path, 'utf8')).toBe('packages:\n  - apps/*\n')
  })
})
