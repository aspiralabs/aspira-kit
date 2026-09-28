import { describe, expect, it } from 'vitest'
import { detect } from './analyzers.ts'

const tree = (files: Record<string, string>) => detect(Object.keys(files), async (p) => files[p] ?? null)

describe('detect', () => {
  it('prefers root scripts and keeps eslint --fix available', async () => {
    const d = await tree({ 'package.json': JSON.stringify({ scripts: { lint: 'turbo run lint', typecheck: 'tsc -b', 'format:check': 'prettier --check .', format: 'prettier --write .' } }), 'pnpm-lock.yaml': '', 'eslint.config.mjs': '', 'packages/a/eslint.config.mjs': '', 'tsconfig.json': '{"references":[]}' })
    expect(d.packageManager).toBe('pnpm')
    expect(d.analyzers.map((a) => [a.id, a.check, a.fix])).toEqual([
      ['script:lint', 'pnpm run lint', null],
      ['eslint-fix:.', '', 'pnpm exec eslint . --fix'],
      ['script:typecheck', 'pnpm run typecheck', null],
      ['script:format', 'pnpm run format:check', 'pnpm run format'],
    ])
    expect(d.setup).toEqual([{ command: 'pnpm install --frozen-lockfile', ecosystem: 'js', hostWhenMissing: 'node_modules' }])
  })
  it('falls back to per-directory eslint and tsc, prettier and biome with yarn/npm/bun', async () => {
    const yarn = await tree({ 'package.json': JSON.stringify({ prettier: {} }), 'yarn.lock': '', 'packages/a/.eslintrc.json': '', 'packages/b/eslint.config.ts': '', 'packages/a/tsconfig.json': '{}', 'packages/b/tsconfig.json': '{"references":[{"path":"../a"}]}', 'biome.json': '{}' })
    expect(yarn.packageManager).toBe('yarn')
    expect(yarn.analyzers.map((a) => a.id).sort()).toEqual(['biome', 'eslint:packages/a', 'eslint:packages/b', 'prettier', 'tsc:packages/a', 'tsc:packages/b'])
    expect(yarn.analyzers.find((a) => a.id === 'tsc:packages/b')!.check).toBe('yarn tsc -b --pretty false')
    expect(yarn.analyzers.find((a) => a.id === 'eslint:packages/a')!.cwd).toBe('packages/a')
    const npm = await tree({ 'package.json': '{}', 'package-lock.json': '', 'eslint.config.js': '' })
    expect(npm.analyzers[0]!.check).toBe('npx --no-install eslint . --format json')
    expect(npm.setup[0]!.command).toBe('npm ci')
    const bun = await tree({ 'package.json': '{}', 'bun.lock': '', '.prettierrc': '' })
    expect(bun.analyzers.map((a) => a.check)).toEqual(['bunx prettier --check .'])
    const bare = await tree({ 'package.json': '{}' })
    expect(bare.analyzers).toEqual([])
    expect(bare.notes[0]).toContain('without lint/typecheck scripts')
  })
  it('detects python, go, rust and ruby analyzers from configuration', async () => {
    const py = await tree({ 'pyproject.toml': '[tool.ruff]\nline-length = 100\n[tool.mypy]\nstrict = true\n[tool.black]\n', 'pyrightconfig.json': '{}', 'setup.cfg': '[flake8]\nmax-line-length = 100', 'requirements.txt': 'requests' })
    expect(py.ecosystems).toEqual(['python'])
    expect(py.analyzers.map((a) => a.id)).toEqual(['ruff', 'ruff-format', 'black', 'mypy', 'pyright', 'flake8'])
    expect(py.analyzers.every((a) => a.requires && a.install.length)).toBe(true)
    const plainPy = await tree({ 'requirements.txt': '' })
    expect(plainPy.analyzers.map((a) => a.id)).toEqual(['ruff'])
    const go = await tree({ 'go.mod': 'module x', '.golangci.yml': '' })
    expect(go.analyzers.map((a) => a.id)).toEqual(['gofmt', 'go-vet', 'golangci-lint'])
    const rust = await tree({ 'Cargo.toml': '' })
    expect(rust.analyzers.map((a) => [a.id, a.fix])).toEqual([['cargo-fmt', 'cargo fmt --all'], ['clippy', null]])
    const ruby = await tree({ Gemfile: "gem 'rubocop'", '.rubocop.yml': '' })
    expect(ruby.analyzers.map((a) => a.id)).toEqual(['rubocop'])
    expect((await tree({ 'README.md': '' })).notes[0]).toContain('No supported ecosystem')
  })
})
