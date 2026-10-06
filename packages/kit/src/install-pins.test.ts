import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KIT_VERSION, approveIgnoredBuilds, pinned } from './stacks/next.js'

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
  const project = (pkg: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-builds-'))
    const path = join(dir, 'package.json')
    writeFileSync(path, JSON.stringify(pkg))
    return path
  }

  it('approves exactly the packages pnpm named, merged with what the project already approves', () => {
    const path = project({ name: 'x', pnpm: { onlyBuiltDependencies: ['sharp'] } })
    const output = 'Error: ERR_PNPM_IGNORED_BUILDS\n  Ignored build scripts: core-js-pure@3.50.0, esbuild@0.25.0\n  help: Run "pnpm approve-builds"'
    expect(approveIgnoredBuilds(output, path)).toEqual(['core-js-pure', 'esbuild'])
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as { pnpm: { onlyBuiltDependencies: string[] } }
    expect(pkg.pnpm.onlyBuiltDependencies).toEqual(['core-js-pure', 'esbuild', 'sharp'])
  })

  it('handles scoped names and a project with no pnpm section', () => {
    const path = project({ name: 'x' })
    expect(approveIgnoredBuilds('Ignored build scripts: @prisma/engines@6.0.0', path)).toEqual(['@prisma/engines'])
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as { name: string; pnpm: { onlyBuiltDependencies: string[] } }
    expect(pkg.name).toBe('x')
    expect(pkg.pnpm.onlyBuiltDependencies).toEqual(['@prisma/engines'])
  })

  it('does nothing when the output names no ignored builds', () => {
    const path = project({ name: 'x' })
    expect(approveIgnoredBuilds('ERR_PNPM_FETCH_404 not found', path)).toEqual([])
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ name: 'x' })
  })
})
