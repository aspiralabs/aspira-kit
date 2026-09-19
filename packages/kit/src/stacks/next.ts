// The Next.js profile. Each step is idempotent: run init twice, get the same project.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { configDir, deepMerge, readJson, writeIfAbsent, writeJson, type Log } from '../fs.js'

export type InitOptions = { projectRoot: string; dryRun: boolean; log: Log }

const DEPS = ['@aspiralabs/ui']
const DEV_DEPS = ['@aspiralabs/config', '@aspiralabs/kit', 'eslint', 'prettier', 'typescript']

function packageManager(root: string): 'pnpm' | 'npm' | 'yarn' {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) {
    return 'pnpm'
  }
  if (existsSync(join(root, 'yarn.lock'))) {
    return 'yarn'
  }
  if (existsSync(join(root, 'package-lock.json'))) {
    return 'npm'
  }
  return 'pnpm'
}

function install(opts: InitOptions): void {
  const pm = packageManager(opts.projectRoot)
  const add = pm === 'yarn' ? 'add' : pm === 'npm' ? 'install' : 'add'
  const devFlag = pm === 'npm' ? '--save-dev' : '-D'
  const cmds = [
    [pm, add, ...DEPS],
    [pm, add, devFlag, ...DEV_DEPS],
  ]
  for (const cmd of cmds) {
    opts.log(`run    ${cmd.join(' ')}`)
    if (opts.dryRun) {
      continue
    }
    const res = spawnSync(cmd[0]!, cmd.slice(1), { cwd: opts.projectRoot, stdio: 'inherit' })
    if (res.status !== 0) {
      throw new Error(`${cmd.join(' ')} failed`)
    }
  }
}

function eslint(opts: InitOptions): void {
  writeIfAbsent(join(opts.projectRoot, 'eslint.config.mjs'), "import next from '@aspiralabs/config/eslint/next'\n\nexport default next\n", opts.log)
}

function prettier(opts: InitOptions): void {
  writeIfAbsent(join(opts.projectRoot, 'prettier.config.mjs'), "export { default } from '@aspiralabs/config/prettier'\n", opts.log)
}

function tsconfig(opts: InitOptions): void {
  const path = join(opts.projectRoot, 'tsconfig.json')
  const current = readJson<Record<string, unknown>>(path) ?? {}
  if (current.extends === '@aspiralabs/config/tsconfig/next.json') {
    opts.log(`keep   ${path} (already extends the kit)`)
    return
  }
  const next: Record<string, unknown> = { extends: '@aspiralabs/config/tsconfig/next.json', ...current }
  next.extends = '@aspiralabs/config/tsconfig/next.json'
  // paths must live in the project: a shared tsconfig resolves them relative to itself.
  const co = (next.compilerOptions ?? {}) as Record<string, unknown>
  if (!co.paths) {
    co.paths = { '@/*': ['./*'] }
  }
  next.compilerOptions = co
  opts.log(`update ${path} (extends -> @aspiralabs/config/tsconfig/next.json)`)
  if (!opts.dryRun) {
    writeJson(path, next)
  }
}

function css(opts: InitOptions): void {
  const candidates = ['app/globals.css', 'src/app/globals.css', 'styles/globals.css']
  const rel = candidates.find((c) => existsSync(join(opts.projectRoot, c)))
  if (!rel) {
    opts.log('skip   globals.css not found; add the tokens import and @source line by hand')
    return
  }
  const path = join(opts.projectRoot, rel)
  const text = readFileSync(path, 'utf8')
  if (text.includes('@aspiralabs/ui/tokens.css')) {
    opts.log(`keep   ${path} (tokens already imported)`)
    return
  }
  const depth = rel.split('/').length - 1
  const up = '../'.repeat(depth)
  const lines = [`@import "@aspiralabs/ui/tokens.css";`, `@source "${up}node_modules/@aspiralabs/ui/dist";`]
  const anchor = text.match(/^@import ['"]tailwindcss['"];?\s*$/m)
  const next = anchor ? text.replace(anchor[0], `${anchor[0]}\n${lines.join('\n')}`) : `${lines.join('\n')}\n${text}`
  opts.log(`update ${path} (tokens import + @source)`)
  if (!opts.dryRun) {
    writeFileSync(path, next)
  }
}

function agentFiles(opts: InitOptions): void {
  const cfg = configDir(opts.projectRoot)
  const tpl = (name: string, fallback: string): string => {
    if (!cfg) {
      return fallback
    }
    const p = join(cfg, 'agent', 'templates', name)
    return existsSync(p) ? readFileSync(p, 'utf8') : fallback
  }
  const project = basename(opts.projectRoot)

  // AGENTS.md: managed block is replaced, everything outside it is kept.
  const agentsPath = join(opts.projectRoot, 'AGENTS.md')
  const template = tpl('AGENTS.md', `# ${project}\n\n<!-- aspiralabs:begin -->\nThis project is on the Aspira Labs kit.\n<!-- aspiralabs:end -->\n`).replace('{{project}}', project)
  const block = template.match(/<!-- aspiralabs:begin[\s\S]*?<!-- aspiralabs:end -->/)?.[0] ?? ''
  if (existsSync(agentsPath)) {
    const current = readFileSync(agentsPath, 'utf8')
    const next = /<!-- aspiralabs:begin[\s\S]*?<!-- aspiralabs:end -->/.test(current)
      ? current.replace(/<!-- aspiralabs:begin[\s\S]*?<!-- aspiralabs:end -->/, block)
      : `${current.trimEnd()}\n\n${block}\n`
    opts.log(next === current ? `keep   ${agentsPath} (managed block current)` : `update ${agentsPath} (managed block)`)
    if (!opts.dryRun && next !== current) {
      writeFileSync(agentsPath, next)
    }
  } else {
    opts.log(`write  ${agentsPath}`)
    if (!opts.dryRun) {
      writeFileSync(agentsPath, template)
    }
  }

  writeIfAbsent(join(opts.projectRoot, 'CLAUDE.md'), tpl('CLAUDE.md', '@AGENTS.md\n'), opts.log)

  const mcpPath = join(opts.projectRoot, '.mcp.json')
  const mcpTemplate = JSON.parse(tpl('mcp.json', '{"mcpServers":{"aspiralabs-ui":{"command":"npx","args":["--no","aspiralabs-ui-mcp"]}}}')) as Record<string, unknown>
  const mcpNext = deepMerge(readJson<Record<string, unknown>>(mcpPath) ?? {}, mcpTemplate)
  opts.log(`${existsSync(mcpPath) ? 'update' : 'write '} ${mcpPath} (aspiralabs-ui server)`)
  if (!opts.dryRun) {
    writeJson(mcpPath, mcpNext)
  }

  const settingsPath = join(opts.projectRoot, '.claude', 'settings.json')
  const settingsTemplate = JSON.parse(tpl('claude-settings.json', '{}')) as Record<string, unknown>
  const settingsNext = deepMerge(readJson<Record<string, unknown>>(settingsPath) ?? {}, settingsTemplate)
  opts.log(`${existsSync(settingsPath) ? 'update' : 'write '} ${settingsPath} (session-start, deny-tier3, audit-log hooks)`)
  if (!opts.dryRun) {
    writeJson(settingsPath, settingsNext)
  }
}

function specs(opts: InitOptions): void {
  writeIfAbsent(
    join(opts.projectRoot, 'specs', 'README.md'),
    '# Specs\n\nOne file per feature: intent, constraints, acceptance criteria, out of scope, expected blast radius. Status approved before any code. See the kit constraints.\n',
    opts.log,
  )
}

export async function initNext(opts: InitOptions): Promise<void> {
  opts.log(`stack  next (${opts.projectRoot})`)
  install(opts)
  eslint(opts)
  prettier(opts)
  tsconfig(opts)
  css(opts)
  agentFiles(opts)
  specs(opts)
  opts.log('done   run `pnpm lint` to see what the org rules think of the codebase')
}
