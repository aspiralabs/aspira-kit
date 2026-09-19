// Reports which kit version a project is on and whether the wiring is present.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, type Log } from './fs.js'

type Pkg = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }

export function doctor(projectRoot: string, log: Log): number {
  const pkg = readJson<Pkg>(join(projectRoot, 'package.json'))
  if (!pkg) {
    log('no package.json here')
    return 1
  }
  let problems = 0
  const all = { ...pkg.dependencies, ...pkg.devDependencies }
  for (const name of ['@aspiralabs/ui', '@aspiralabs/config', '@aspiralabs/kit']) {
    const declared = all[name]
    const installed = readJson<{ version: string }>(join(projectRoot, 'node_modules', name, 'package.json'))?.version
    if (!declared) {
      log(`missing ${name}`)
      problems += 1
      continue
    }
    log(`${name.padEnd(20)} declared ${declared.padEnd(14)} installed ${installed ?? '(not installed)'}`)
  }
  const checks: Array<[string, () => boolean]> = [
    ['eslint.config.mjs extends the kit', () => existsSync(join(projectRoot, 'eslint.config.mjs')) && readFileSync(join(projectRoot, 'eslint.config.mjs'), 'utf8').includes('@aspiralabs/config')],
    ['tsconfig.json extends the kit', () => readJson<{ extends?: string }>(join(projectRoot, 'tsconfig.json'))?.extends?.includes('@aspiralabs/config') ?? false],
    ['globals.css imports tokens', () => ['app/globals.css', 'src/app/globals.css'].some((p) => existsSync(join(projectRoot, p)) && readFileSync(join(projectRoot, p), 'utf8').includes('@aspiralabs/ui/tokens.css'))],
    ['AGENTS.md has the managed block', () => existsSync(join(projectRoot, 'AGENTS.md')) && readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8').includes('aspiralabs:begin')],
    ['.mcp.json registers aspiralabs-ui', () => JSON.stringify(readJson(join(projectRoot, '.mcp.json')) ?? {}).includes('aspiralabs-ui')],
    ['.claude/settings.json has the hooks', () => JSON.stringify(readJson(join(projectRoot, '.claude', 'settings.json')) ?? {}).includes('session-start.sh')],
  ]
  for (const [label, ok] of checks) {
    const pass = ok()
    if (!pass) {
      problems += 1
    }
    log(`${pass ? 'ok  ' : 'FAIL'} ${label}`)
  }
  log(problems === 0 ? 'healthy' : `${problems} problem(s); run kit init --stack next`)
  return problems === 0 ? 0 : 1
}
