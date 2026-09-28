import { dirname } from 'node:path'
import { black, cargoFmt, colonLines, eslintJson, githubAnnotations, gofmt, mypy, prettier, pyright, rubocopJson, ruffFormat, ruffJson, script, tsc, type Parser } from './parsers.ts'

export type Ecosystem = 'js' | 'python' | 'go' | 'rust' | 'ruby'
export type Analyzer = {
  id: string
  tool: string
  ecosystem: Ecosystem
  /** Repository-relative directory the command runs in ('' for the root). */
  cwd: string
  check: string
  /** Whole-tree auto-fix command, or null when the tool has none. */
  fix: string | null
  parse: Parser
  /** Binary probed with `command -v`; null when nothing beyond the package manager is needed. */
  requires: string | null
  /** Sandbox-only install commands for `requires`. */
  install: string[]
}
export type Detection = {
  analyzers: Analyzer[]
  ecosystems: Ecosystem[]
  /** Commands that prepare the tree (dependency install), run in the sandbox always and on the host only when dependencies are missing. */
  setup: { command: string; ecosystem: Ecosystem; hostWhenMissing: string | null }[]
  notes: string[]
  packageManager: 'pnpm' | 'yarn' | 'bun' | 'npm' | null
}

const under = (files: string[], dir: string) => (dir ? `${dir}/` : '')
const dirOf = (file: string) => (dirname(file) === '.' ? '' : dirname(file))
const hasNodeModules = (path: string) => path.split('/').includes('node_modules')
const MAX_DIRS = 20

type Pm = { name: NonNullable<Detection['packageManager']>; exec: string; run: (s: string) => string; install: string }
function packageManager(files: Set<string>, rootPkg: { packageManager?: string } | null): Pm {
  const declared = rootPkg?.packageManager?.split('@')[0]
  if (files.has('pnpm-lock.yaml') || declared === 'pnpm') return { name: 'pnpm', exec: 'pnpm exec', run: (s) => `pnpm run ${s}`, install: 'pnpm install --frozen-lockfile' }
  if (files.has('bun.lock') || files.has('bun.lockb') || declared === 'bun') return { name: 'bun', exec: 'bunx', run: (s) => `bun run ${s}`, install: 'bun install --frozen-lockfile' }
  if (files.has('yarn.lock') || declared === 'yarn') return { name: 'yarn', exec: 'yarn', run: (s) => `yarn run ${s}`, install: 'yarn install' }
  return { name: 'npm', exec: 'npx --no-install', run: (s) => `npm run ${s}`, install: files.has('package-lock.json') ? 'npm ci' : 'npm install' }
}

const ESLINT_CONFIG = /(^|\/)(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.(js|cjs|json|ya?ml))?)$/
const PRETTIER_CONFIG = /^(\.prettierrc(\..*)?|prettier\.config\.[cm]?[jt]s)$/
const APT = (pkg: string) => `sudo apt-get install -y -qq ${pkg} >/dev/null`
const PIP = (pkg: string) => `pip3 install --user --quiet --break-system-packages ${pkg} || pip3 install --user --quiet ${pkg}`

/** Chooses analyzers from what is in the tree. Pure: files plus a reader, no execution. */
export async function detect(files: string[], read: (path: string) => Promise<string | null>): Promise<Detection> {
  const set = new Set(files)
  const analyzers: Analyzer[] = []
  const ecosystems: Ecosystem[] = []
  const setup: Detection['setup'] = []
  const notes: string[] = []
  let pmName: Detection['packageManager'] = null

  if (set.has('package.json')) {
    ecosystems.push('js')
    const pkg = JSON.parse((await read('package.json')) ?? '{}') as { scripts?: Record<string, string>; prettier?: unknown; packageManager?: string; workspaces?: unknown }
    const scripts = pkg.scripts ?? {}
    const pm = packageManager(set, pkg)
    pmName = pm.name
    setup.push({ command: pm.install, ecosystem: 'js', hostWhenMissing: 'node_modules' })
    const withScript = (names: string[]) => names.find((n) => scripts[n])
    const lintScript = withScript(['lint'])
    const typeScript = withScript(['typecheck', 'type-check', 'check-types', 'tsc'])
    const formatScript = withScript(['format:check', 'prettier:check', 'format-check', 'check-format'])
    const formatFix = withScript(['format', 'format:write', 'prettier:write', 'format:fix', 'fix:format'])
    const eslintDirs = files.filter((f) => ESLINT_CONFIG.test(f) && !hasNodeModules(f)).map(dirOf)
    const eslintRoots = eslintDirs.includes('') ? [''] : [...new Set(eslintDirs)].slice(0, MAX_DIRS)
    if (lintScript) analyzers.push({ id: 'script:lint', tool: 'lint', ecosystem: 'js', cwd: '', check: pm.run(lintScript), fix: null, parse: script('lint'), requires: null, install: [] })
    else for (const dir of eslintRoots) analyzers.push({ id: `eslint:${dir || '.'}`, tool: 'eslint', ecosystem: 'js', cwd: dir, check: `${pm.exec} eslint . --format json`, fix: `${pm.exec} eslint . --fix`, parse: eslintJson, requires: null, install: [] })
    // ESLint's own --fix stays available even when the project runs lint through a script.
    if (lintScript && eslintRoots.length) for (const dir of eslintRoots) analyzers.push({ id: `eslint-fix:${dir || '.'}`, tool: 'eslint', ecosystem: 'js', cwd: dir, check: '', fix: `${pm.exec} eslint . --fix`, parse: eslintJson, requires: null, install: [] })
    const tsconfigs = files.filter((f) => /(^|\/)tsconfig\.json$/.test(f) && !hasNodeModules(f)).map(dirOf)
    if (typeScript) analyzers.push({ id: 'script:typecheck', tool: 'tsc', ecosystem: 'js', cwd: '', check: pm.run(typeScript), fix: null, parse: script('tsc'), requires: null, install: [] })
    else for (const dir of [...new Set(tsconfigs)].slice(0, MAX_DIRS)) {
      const solution = /"references"\s*:/.test((await read(`${under(files, dir)}tsconfig.json`)) ?? '')
      analyzers.push({ id: `tsc:${dir || '.'}`, tool: 'tsc', ecosystem: 'js', cwd: dir, check: solution ? `${pm.exec} tsc -b --pretty false` : `${pm.exec} tsc -p tsconfig.json --noEmit --pretty false`, fix: null, parse: tsc, requires: null, install: [] })
    }
    const prettierConfigured = files.some((f) => PRETTIER_CONFIG.test(f)) || pkg.prettier !== undefined
    if (formatScript) analyzers.push({ id: 'script:format', tool: 'prettier', ecosystem: 'js', cwd: '', check: pm.run(formatScript), fix: formatFix ? pm.run(formatFix) : prettierConfigured ? `${pm.exec} prettier --write .` : null, parse: script('prettier'), requires: null, install: [] })
    else if (prettierConfigured) analyzers.push({ id: 'prettier', tool: 'prettier', ecosystem: 'js', cwd: '', check: `${pm.exec} prettier --check .`, fix: `${pm.exec} prettier --write .`, parse: prettier, requires: null, install: [] })
    if (set.has('biome.json') || set.has('biome.jsonc')) analyzers.push({ id: 'biome', tool: 'biome', ecosystem: 'js', cwd: '', check: `${pm.exec} biome check --reporter=github .`, fix: `${pm.exec} biome check --write .`, parse: githubAnnotations('biome'), requires: null, install: [] })
    if (!analyzers.some((a) => a.ecosystem === 'js' && a.check)) notes.push('JavaScript project without lint/typecheck scripts, ESLint, tsconfig, Prettier or Biome configuration')
  }

  const pyproject = set.has('pyproject.toml') ? ((await read('pyproject.toml')) ?? '') : ''
  const setupCfg = set.has('setup.cfg') ? ((await read('setup.cfg')) ?? '') : ''
  const toxIni = set.has('tox.ini') ? ((await read('tox.ini')) ?? '') : ''
  if (set.has('pyproject.toml') || set.has('setup.py') || set.has('setup.cfg') || set.has('requirements.txt') || set.has('ruff.toml')) {
    ecosystems.push('python')
    if (set.has('requirements.txt')) setup.push({ command: PIP('-r requirements.txt'), ecosystem: 'python', hostWhenMissing: null })
    if (set.has('pyproject.toml')) setup.push({ command: `${PIP('-e .')} || true`, ecosystem: 'python', hostWhenMissing: null })
    const ruffConfigured = set.has('ruff.toml') || set.has('.ruff.toml') || /\[tool\.ruff/.test(pyproject)
    analyzers.push({ id: 'ruff', tool: 'ruff', ecosystem: 'python', cwd: '', check: 'ruff check . --output-format json', fix: 'ruff check . --fix', parse: ruffJson, requires: 'ruff', install: [PIP('ruff')] })
    if (ruffConfigured) analyzers.push({ id: 'ruff-format', tool: 'ruff-format', ecosystem: 'python', cwd: '', check: 'ruff format --check .', fix: 'ruff format .', parse: ruffFormat, requires: 'ruff', install: [PIP('ruff')] })
    if (/\[tool\.black\]/.test(pyproject)) analyzers.push({ id: 'black', tool: 'black', ecosystem: 'python', cwd: '', check: 'black --check .', fix: 'black .', parse: black, requires: 'black', install: [PIP('black')] })
    if (set.has('mypy.ini') || set.has('.mypy.ini') || /\[tool\.mypy\]/.test(pyproject) || /^\[mypy\]/m.test(setupCfg)) analyzers.push({ id: 'mypy', tool: 'mypy', ecosystem: 'python', cwd: '', check: 'mypy . --no-error-summary --no-color-output --show-column-numbers --hide-error-context', fix: null, parse: mypy, requires: 'mypy', install: [PIP('mypy')] })
    if (set.has('pyrightconfig.json') || /\[tool\.pyright\]/.test(pyproject)) analyzers.push({ id: 'pyright', tool: 'pyright', ecosystem: 'python', cwd: '', check: 'pyright --outputjson', fix: null, parse: pyright, requires: 'pyright', install: [PIP('pyright')] })
    if (set.has('.flake8') || /^\[flake8\]/m.test(setupCfg) || /^\[flake8\]/m.test(toxIni)) analyzers.push({ id: 'flake8', tool: 'flake8', ecosystem: 'python', cwd: '', check: 'flake8', fix: null, parse: colonLines('flake8'), requires: 'flake8', install: [PIP('flake8')] })
  }

  if (set.has('go.mod')) {
    ecosystems.push('go')
    const go = [APT('golang-go')]
    analyzers.push({ id: 'gofmt', tool: 'gofmt', ecosystem: 'go', cwd: '', check: 'gofmt -l .', fix: 'gofmt -w .', parse: gofmt, requires: 'gofmt', install: go })
    analyzers.push({ id: 'go-vet', tool: 'go-vet', ecosystem: 'go', cwd: '', check: 'go vet ./...', fix: null, parse: colonLines('go-vet'), requires: 'go', install: go })
    if (files.some((f) => /^\.golangci\.(ya?ml|toml|json)$/.test(f))) analyzers.push({ id: 'golangci-lint', tool: 'golangci-lint', ecosystem: 'go', cwd: '', check: 'golangci-lint run', fix: null, parse: colonLines('golangci-lint'), requires: 'golangci-lint', install: [...go, 'curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/HEAD/install.sh | sh -s -- -b "$HOME/.local/bin"'] })
  }

  if (set.has('Cargo.toml')) {
    ecosystems.push('rust')
    const rust = ['curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --component clippy,rustfmt >/dev/null']
    analyzers.push({ id: 'cargo-fmt', tool: 'cargo-fmt', ecosystem: 'rust', cwd: '', check: 'cargo fmt --all -- --check', fix: 'cargo fmt --all', parse: cargoFmt, requires: 'cargo', install: rust })
    analyzers.push({ id: 'clippy', tool: 'clippy', ecosystem: 'rust', cwd: '', check: 'cargo clippy --all-targets --message-format short -- -D warnings', fix: null, parse: colonLines('clippy'), requires: 'cargo', install: rust })
  }

  if (set.has('Gemfile') && (set.has('.rubocop.yml') || /rubocop/.test((await read('Gemfile')) ?? ''))) {
    ecosystems.push('ruby')
    setup.push({ command: 'bundle install --quiet', ecosystem: 'ruby', hostWhenMissing: null })
    analyzers.push({ id: 'rubocop', tool: 'rubocop', ecosystem: 'ruby', cwd: '', check: 'bundle exec rubocop --format json', fix: 'bundle exec rubocop -a', parse: rubocopJson, requires: 'bundle', install: [APT('ruby-full'), 'sudo gem install bundler >/dev/null'] })
  }

  if (!ecosystems.length) notes.push('No supported ecosystem detected (looked for package.json, pyproject.toml/setup.py/requirements.txt, go.mod, Cargo.toml, Gemfile)')
  return { analyzers, ecosystems, setup, notes, packageManager: pmName }
}
