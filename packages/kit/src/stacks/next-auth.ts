// `kit add auth`: writes a base Better Auth setup into a Next.js project. The
// files are the product's once written, so existing files are never touched and
// re-running only fills in what is missing.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { readJson, writeIfAbsent, type Log } from '../fs.js'
import { packageManager } from './next.js'

export type AddAuthOptions = { projectRoot: string; dryRun: boolean; log: Log; passkey: boolean; expo?: string }

// The version the templates are written and typechecked against. The plugins
// ship in lockstep with better-auth, so they share the range.
const BETTER_AUTH = '^1.6.22'

const TEMPLATES = fileURLToPath(new URL('../../templates/next/auth/', import.meta.url))

// `// #if flag` ... `// #endif` (or `# #if` in env files) keeps its lines only
// when the flag is on; `{{name}}` is replaced from vars.
export function render(text: string, flags: Record<string, boolean>, vars: Record<string, string> = {}): string {
  const out: string[] = []
  const stack: boolean[] = []
  for (const line of text.split('\n')) {
    const open = line.match(/^\s*(?:\/\/|#) #if (\w+)\s*$/)
    if (open) {
      stack.push(Boolean(flags[open[1]!]))
      continue
    }
    if (/^\s*(?:\/\/|#) #endif\s*$/.test(line)) {
      stack.pop()
      continue
    }
    if (stack.every(Boolean)) {
      out.push(line.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m))
    }
  }
  return out.join('\n')
}

function missingDeps(root: string, wanted: string[]): string[] {
  const pkg = readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(join(root, 'package.json')) ?? {}
  const have = { ...pkg.dependencies, ...pkg.devDependencies }
  return wanted.filter((spec) => !(spec.replace(/(?<=.)@.*$/, '') in have))
}

function install(opts: AddAuthOptions): void {
  const deps = missingDeps(opts.projectRoot, [
    `better-auth@${BETTER_AUTH}`,
    ...(opts.passkey ? [`@better-auth/passkey@${BETTER_AUTH}`] : []),
    ...(opts.expo ? [`@better-auth/expo@${BETTER_AUTH}`] : []),
    'ioredis',
    'resend',
    '@prisma/client',
  ])
  const devDeps = missingDeps(opts.projectRoot, ['prisma'])
  const pm = packageManager(opts.projectRoot)
  const add = pm === 'npm' ? 'install' : 'add'
  const cmds = [
    ...(deps.length ? [[pm, add, ...deps]] : []),
    ...(devDeps.length ? [[pm, add, pm === 'npm' ? '--save-dev' : '-D', ...devDeps]] : []),
  ]
  if (!cmds.length) {
    opts.log('keep   dependencies (all present)')
  }
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

function envExample(opts: AddAuthOptions, flags: Record<string, boolean>): void {
  const path = join(opts.projectRoot, '.env.example')
  const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const has = new Set(current.split('\n').map((l) => l.split('=')[0]!.trim()))
  const lines = render(readFileSync(join(TEMPLATES, 'env.example'), 'utf8'), flags)
    .split('\n')
    .filter((l) => l.trim() && (l.startsWith('#') || !has.has(l.split('=')[0]!)))
  if (lines.every((l) => l.startsWith('#'))) {
    opts.log(`keep   ${path} (auth keys present)`)
    return
  }
  opts.log(`${current ? 'update' : 'write '} ${path} (auth keys)`)
  if (!opts.dryRun) {
    writeFileSync(path, `${current ? `${current.trimEnd()}\n\n` : ''}${lines.join('\n')}\n`)
  }
}

// A kept file must still export what lib/auth.ts imports from it.
function checkExport(path: string, name: string, log: Log): void {
  if (existsSync(path) && !new RegExp(`export\\s+(?:const|let|function|async function)\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b`).test(readFileSync(path, 'utf8'))) {
    log(`warn   ${path} does not export \`${name}\`; lib/auth.ts imports it`)
  }
}

export function addAuthNext(opts: AddAuthOptions): void {
  if (opts.expo && !/^[a-z][a-z0-9+.-]*$/.test(opts.expo)) {
    throw new Error(`--expo takes the app's URL scheme (e.g. myapp), got "${opts.expo}"`)
  }
  const flags = { passkey: opts.passkey, expo: Boolean(opts.expo) }
  const vars = { scheme: opts.expo ?? '' }
  const base = existsSync(join(opts.projectRoot, 'src', 'app')) ? join(opts.projectRoot, 'src') : opts.projectRoot
  const lib = join(base, 'lib')

  opts.log(`auth   better-auth ${BETTER_AUTH} (passkey ${opts.passkey ? 'on' : 'off'}, expo ${opts.expo ?? 'off'})`)
  install(opts)

  const files: [string, string][] = [
    ['auth.ts', join(lib, 'auth.ts')],
    ['auth.client.ts', join(lib, 'auth', 'auth.client.ts')],
    ['session.ts', join(lib, 'auth', 'session.ts')],
    ['email.ts', join(lib, 'auth', 'email.ts')],
    ['redis.ts', join(lib, 'redis.ts')],
    ['prisma.ts', join(lib, 'prisma.ts')],
    ['route.ts', join(base, 'app', 'api', 'auth', '[...all]', 'route.ts')],
  ]
  for (const [tpl, dest] of files) {
    writeIfAbsent(dest, render(readFileSync(join(TEMPLATES, tpl), 'utf8'), flags, vars), opts.log, opts.dryRun)
  }
  checkExport(join(lib, 'prisma.ts'), 'prisma', opts.log)
  checkExport(join(lib, 'redis.ts'), 'getRedis', opts.log)
  envExample(opts, flags)

  opts.log('next   1. fill .env from .env.example (BETTER_AUTH_SECRET: `openssl rand -base64 32`)')
  opts.log('       2. `npx @better-auth/cli generate` to add the auth models to schema.prisma, then migrate')
  opts.log('       3. give server-owned user fields `input: false` as you add them (see lib/auth.ts)')
}
