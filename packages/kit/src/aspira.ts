// aspira.json at the project root: the project's Feature Board (a Notion URL), its Releases page
// when given, and, in a repository where the app that owns package.json and node_modules is not
// the root (apps/web), that app's directory. `kit init` writes it, `kit doctor` checks it, the
// skills, the launchers and `kit next` read it.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { readJson, writeJson, type Log } from './fs.js'

export const ASPIRA_FILE = 'aspira.json'

export type AspiraConfig = { board: string; releases?: string; glossary?: string; decisions?: string; app?: string; knowledge?: string }

/** aspira.json's Notion keys that `kit doctor` resolves by id: the Feature Board (a database or,
 * for a collection:// value, a data source) and four pages, once those keys exist. `knowledge` is
 * the engineering guidelines' index page (Agent Instructions): the run's KNOWLEDGE_PAGE when the
 * environment has none. */
export const NOTION_KEYS = ['board', 'releases', 'glossary', 'decisions', 'knowledge'] as const
export type NotionKey = (typeof NOTION_KEYS)[number]
export type NotionTarget = { key: NotionKey; url: string; kind: 'database' | 'page' | 'data_source' }

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

/**
 * Whether the app sits in a workspace whose root is the project root: a root package.json with a
 * pnpm-workspace.yaml beside it or a "workspaces" field (npm, yarn). The root then owns the lockfile,
 * .npmrc and shared config; without it (no root package.json), the app owns everything.
 */
export function isWorkspaceRoot(projectRoot: string, app: string | undefined): boolean {
  if (app === undefined || app === '.' || !existsSync(join(projectRoot, 'package.json'))) return false
  return existsSync(join(projectRoot, 'pnpm-workspace.yaml')) || readJson<{ workspaces?: unknown }>(join(projectRoot, 'package.json'))?.workspaces !== undefined
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

/** The Notion keys aspira.json actually sets, each resolved to the check `kind` Notion needs: `board`
 * as a database (a data source for a `collection://` value), every other key as a page. `repository`,
 * `app` and anything else in aspira.json are never included: they are not Notion URLs `kit doctor`
 * resolves by id. */
export function notionTargets(config: Partial<AspiraConfig> | undefined): NotionTarget[] {
  if (config === undefined) return []
  return NOTION_KEYS.flatMap((key) => {
    const url = config[key]
    if (typeof url !== 'string' || url.trim() === '') return []
    const kind = key === 'board' ? (url.trim().toLowerCase().startsWith('collection://') ? 'data_source' : 'database') : 'page'
    return [{ key, url, kind }]
  })
}

/** Where `kit doctor` looks for NOTION_TOKEN, in precedence order: the process environment first
 * (so `kit next`'s own env-file precedence is matched), then the app's `.env.local`, then the
 * project root's. When there is no `app` (a single-app project) the app and root files are the
 * same file, so only one is named. Labels are relative, for display: never an absolute path. */
export function notionTokenCandidates(app: string | undefined): string[] {
  return ['the process environment', ...(app ? [`${app}/.env.local`] : []), '.env.local']
}

export type NotionTokenSource = { token: string; source: string }

/** The first NOTION_TOKEN found, by `notionTokenCandidates`'s order, with the label it came from.
 * Reads the env files directly; never mutates `env` or `process.env`. */
export function notionTokenSource(projectRoot: string, app: string | undefined, env: Record<string, string | undefined> = process.env): NotionTokenSource | undefined {
  const fromEnv = env.NOTION_TOKEN?.trim()
  if (fromEnv) return { token: fromEnv, source: 'the process environment' }
  const appDir = appRoot(projectRoot, app)
  const files: { file: string; label: string }[] = []
  if (app !== undefined && app !== '.') files.push({ file: join(appDir, '.env.local'), label: `${app}/.env.local` })
  files.push({ file: join(projectRoot, '.env.local'), label: '.env.local' })
  for (const { file, label } of files) {
    if (!existsSync(file)) continue
    const match = /^NOTION_TOKEN=(.*)$/m.exec(readFileSync(file, 'utf8'))
    const value = match?.[1]?.trim()
    if (value) return { token: value, source: label }
  }
  return undefined
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
  if (config?.knowledge !== undefined && !isNotionUrl(config.knowledge)) return { ok: false, reason: `${ASPIRA_FILE} "knowledge" is not a Notion URL` }
  if (config?.app !== undefined) {
    if (typeof config.app !== 'string' || config.app === '') return { ok: false, reason: `${ASPIRA_FILE} "app" is not a directory` }
    if (!existsSync(join(projectRoot, config.app, 'package.json'))) return { ok: false, reason: `${ASPIRA_FILE} "app" is ${config.app}, but ${config.app}/package.json does not exist` }
  }
  return { ok: true }
}
