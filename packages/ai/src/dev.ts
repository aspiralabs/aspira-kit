// kit dev: run dev.command on the worktree's own PORT and, when the kit wrote a tunnel config, the worktree's
// cloudflared tunnel beside it; either one exiting, or SIGINT/SIGTERM, stops both (KIT-67). Outside an isolated
// worktree (no PORT in the app's .env.development.local) it runs dev.command unchanged.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { appRoot, readEffectiveAspira, type AspiraConfig } from './aspira.js'
import { probePort, withoutCredentialEnv } from './isolation.js'

export type DevOptions = {
  projectRoot: string
  app?: string | undefined
  log: (line: string) => void
  warn: (line: string) => void
  env?: Readonly<Record<string, string | undefined>>
  portBusy?: (port: number) => Promise<boolean>
}

const PINS_PORT = /(^|\s)(-p|--port)(\s|=|\d|$)/

/** The package.json script a `npm run X`, `pnpm [run] X` or `yarn [run] X` command names. */
function scriptOf(command: string, cwd: string): string | undefined {
  const match = /^(?:npm run|pnpm run|pnpm|yarn run|yarn)\s+([\w:.-]+)/.exec(command.trim())
  if (match?.[1] === undefined) return undefined
  try {
    const scripts = (JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts
    return scripts?.[match[1]]
  } catch {
    return undefined
  }
}

function portOf(file: string): number | undefined {
  if (!existsSync(file)) return undefined
  const match = /^\s*PORT\s*=\s*"?(\d+)"?\s*$/m.exec(readFileSync(file, 'utf8'))
  const port = Number(match?.[1])
  return Number.isInteger(port) && port > 0 ? port : undefined
}

function stop(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

export async function dev(options: DevOptions): Promise<number> {
  const root = resolve(options.projectRoot)
  // The effective file: in a client repo's worktree the repos entry supplies dev and app (KIT-68).
  const config = readEffectiveAspira(root).config as Partial<AspiraConfig>
  const command = config?.dev?.command
  if (command === undefined || command.trim() === '') {
    options.warn('aspira.json has no dev.command; set dev.command to the command that starts the dev server')
    return 1
  }
  const cwd = join(root, config?.dev?.cwd ?? '.')
  const appDir = appRoot(root, options.app ?? (config.app === '' || config.app === '.' ? undefined : config.app))
  const port = portOf(join(appDir, '.env.development.local'))
  // The repo's commands never inherit the kit's credentials.
  const env = withoutCredentialEnv({ ...(options.env ?? process.env) } as Record<string, string | undefined>)
  const children: ChildProcess[] = []

  if (port === undefined) {
    // Not an isolated worktree: dev.command unchanged.
    const child = spawn('sh', ['-c', command], { cwd, env, stdio: 'inherit' })
    return await new Promise<number>((done) => {
      child.on('error', (error) => {
        options.warn(`could not run dev.command: ${error.message}`)
        done(1)
      })
      child.on('exit', (code) => done(code ?? 1))
    })
  }

  const pinned = PINS_PORT.test(command) ? command : PINS_PORT.test(scriptOf(command, cwd) ?? '') ? (scriptOf(command, cwd) as string) : undefined
  if (pinned !== undefined) {
    options.warn(`"${pinned}" pins the port with -p/--port; remove it so this worktree's PORT=${String(port)} decides`)
    return 1
  }
  if (await (options.portBusy ?? probePort)(port)) {
    options.warn(`port ${String(port)} (this worktree's PORT) is already in use; stop what holds it and rerun kit dev`)
    return 1
  }

  const yml = join(root, '.aspira', 'cloudflared.yml')
  const server = spawn('sh', ['-c', command], { cwd, env: { ...env, PORT: String(port) }, stdio: 'inherit', detached: true })
  children.push(server)
  const tunnel = existsSync(yml) ? spawn('cloudflared', ['tunnel', 'run', '--config', yml], { cwd: root, env, stdio: 'inherit', detached: true }) : undefined
  if (tunnel !== undefined) children.push(tunnel)

  return await new Promise<number>((done) => {
    let code: number | undefined
    let open = children.length
    const finish = (value: number): void => {
      code ??= value
      for (const child of children) stop(child)
    }
    const onSignal = (): void => finish(0)
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    for (const child of children) {
      child.on('error', (error) => {
        options.warn(`could not start ${child === server ? 'dev.command' : 'cloudflared'}: ${error.message}`)
        finish(1)
        if (child.pid === undefined && --open === 0) done(1)
      })
      child.on('exit', (exit) => {
        finish(exit ?? 1)
        if (--open === 0) {
          process.off('SIGINT', onSignal)
          process.off('SIGTERM', onSignal)
          done(code ?? 1)
        }
      })
    }
  })
}
