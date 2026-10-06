// aspira.json at the project root: the project's Feature Board (a Notion URL), its Releases page
// when given, and, in a repository where the app that owns package.json and node_modules is not
// the root (apps/web), that app's directory. `kit init` writes it, `kit doctor` checks it, the
// skills, the launchers and `kit next` read it.
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { readJson, writeJson, type Log } from './fs.js'

export const ASPIRA_FILE = 'aspira.json'

export type AspiraConfig = { board: string; releases?: string; app?: string }

/** A Notion page or database URL (notion.so or app.notion.com) or a collection:// data source URL. */
export function isNotionUrl(value: unknown): value is string {
  return typeof value === 'string' && /^(https:\/\/(www\.|app\.)?notion\.(so|com)\/\S+|collection:\/\/[0-9a-f-]{32,36})$/i.test(value.trim())
}

/** `--app <dir>` as aspira.json records it: relative to the project root, forward slashes, no trailing slash. */
export function normalizeApp(app: string): string {
  const clean = normalize(app).split(sep).join('/').replace(/\/+$/, '')
  if (clean === '' || clean === '.') return '.'
  if (isAbsolute(app) || clean.startsWith('..')) throw new Error(`--app must be a directory inside the project, relative to its root, got: ${app}`)
  return clean
}

/** The directory that owns package.json and node_modules: `<root>/<app>`, or the root itself. */
export function appRoot(projectRoot: string, app: string | undefined): string {
  return app === undefined || app === '.' ? projectRoot : join(projectRoot, app)
}

export function readAspira(projectRoot: string): Partial<AspiraConfig> | undefined {
  return readJson<Partial<AspiraConfig>>(join(projectRoot, ASPIRA_FILE))
}

/** The `app` recorded in aspira.json, or undefined for a single-app project. */
export function readApp(projectRoot: string): string | undefined {
  const app = readAspira(projectRoot)?.app
  return typeof app === 'string' && app !== '' && app !== '.' ? app : undefined
}

/**
 * The project root for a command run with no --cwd: `cwd`, unless an ancestor's aspira.json names
 * an `app` that contains `cwd` (so `pnpm kit doctor` in apps/web, where the kit's bin is, works on
 * the repository root that `kit init --app apps/web` wired).
 */
export function resolveProjectRoot(cwd: string): string {
  const start = resolve(cwd)
  for (let dir = dirname(start); ; dir = dirname(dir)) {
    const app = existsSync(join(dir, ASPIRA_FILE)) ? readApp(dir) : undefined
    if (app !== undefined) {
      const inside = relative(resolve(dir, app), start)
      if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) return dir
    }
    if (dirname(dir) === dir) return start
  }
}

/** Write or update aspira.json. A key that is not given keeps its current value. */
export function writeAspira(opts: { projectRoot: string; board?: string; releases?: string; app?: string; dryRun: boolean; log: Log }): void {
  const path = join(opts.projectRoot, ASPIRA_FILE)
  const current = readAspira(opts.projectRoot) ?? {}
  const next: Partial<AspiraConfig> = { ...current }
  if (opts.board !== undefined) {
    if (!isNotionUrl(opts.board)) throw new Error(`--board must be the Feature Board's Notion URL, got: ${opts.board}`)
    next.board = opts.board.trim()
  }
  if (opts.releases !== undefined) {
    if (!isNotionUrl(opts.releases)) throw new Error(`--releases must be the Releases page's Notion URL, got: ${opts.releases}`)
    next.releases = opts.releases.trim()
  }
  if (opts.app !== undefined) {
    const app = normalizeApp(opts.app)
    if (app === '.') delete next.app
    else next.app = app
  }
  if (next.board === undefined && next.app === undefined) {
    opts.log(`skip   ${path} (no --board given; the project has no Feature Board until it is)`)
    return
  }
  if (existsSync(path) && JSON.stringify(current) === JSON.stringify(next)) {
    opts.log(`keep   ${path} (${next.board === undefined ? 'app' : 'board'} already set)`)
    return
  }
  const keys = [next.board === undefined ? '' : 'board', next.releases === undefined ? '' : 'releases', next.app === undefined ? '' : `app ${next.app}`].filter(Boolean).join(', ')
  opts.log(`${existsSync(path) ? 'update' : 'write '} ${path} (${keys}${next.board === undefined ? '; no --board given, the project has no Feature Board until it is' : ''})`)
  if (!opts.dryRun) writeJson(path, next)
}

/** The doctor's view: ok, or why not. */
export function checkAspira(projectRoot: string): { ok: boolean; reason?: string } {
  const path = join(projectRoot, ASPIRA_FILE)
  if (!existsSync(path)) return { ok: false, reason: `${ASPIRA_FILE} is missing; run kit init --board <Feature Board URL>` }
  let config: Partial<AspiraConfig> | undefined
  try {
    config = readAspira(projectRoot)
  } catch {
    return { ok: false, reason: `${ASPIRA_FILE} is not valid JSON` }
  }
  if (!isNotionUrl(config?.board)) return { ok: false, reason: `${ASPIRA_FILE} has no "board" Notion URL; run kit init --board <Feature Board URL>` }
  if (config?.releases !== undefined && !isNotionUrl(config.releases)) return { ok: false, reason: `${ASPIRA_FILE} "releases" is not a Notion URL` }
  if (config?.app !== undefined) {
    if (typeof config.app !== 'string' || config.app === '') return { ok: false, reason: `${ASPIRA_FILE} "app" is not a directory` }
    if (!existsSync(join(projectRoot, config.app, 'package.json'))) return { ok: false, reason: `${ASPIRA_FILE} "app" is ${config.app}, but ${config.app}/package.json does not exist` }
  }
  return { ok: true }
}
