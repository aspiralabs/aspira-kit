// aspira.json at the project root: the project's Feature Board (a Notion URL), its Releases page
// when given, and, in a repository where the app that owns package.json and node_modules is not
// the root (apps/web), that app's directory. `kit init` writes it, `kit doctor` checks it, the
// skills, the launchers and `kit next` read it. It is git-ignored (the global ignore lists it) and
// never committed (KIT-71): `kit init` and `kit upgrade` stop tracking one an earlier kit committed
// and restore one that a pull of that change deleted.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { readJson, writeJson, type Log } from './fs.js'
import { z } from 'zod'
import { git, mainCheckoutRoot, repositoryRoot } from './git.js'

export const ASPIRA_FILE = 'aspira.json'

/** The optional keys that isolate a worktree (KIT-67). `src/isolation.ts` validates them; `checkAspira` ignores them. */
export type DatabaseConfig = { provider: string; projectId: string; parentBranch: string; envVars: Array<string | { name: string; pooled?: boolean }> }
export type WebhookConfig = { provider: string; path: string; events: string[]; connect?: boolean; secretEnvVar?: string; connectSecretEnvVar?: string }

export type AspiraConfig = {
  board: string
  releases?: string
  glossary?: string
  decisions?: string
  app?: string
  knowledge?: string
  database?: DatabaseConfig
  webhooks?: WebhookConfig[]
  tunnel?: { zone: string }
  dev?: { command?: string; cwd?: string; url?: string; urlEnvVars?: string[] }
  /** KIT-69: a folder, relative to this aspira.json, that holds each repo's codebase map and notes (`<folder>/<repo>/map|notes`). Read only by `kit map-codebase`; `checkAspira` ignores it. */
  codebaseMaps?: string
  /** KIT-68, client harness: read through `readEffectiveAspira`, not `readAspira`. */
  statusFlow?: boolean
  pullRequest?: boolean
  guidelines?: string
  workRoot?: string
  extend?: Record<string, string[]>
  repos?: Record<string, RepoEntry>
  /** KIT-70: true turns the codebase map on for the spec writer, planner and pr-reviewer runs; off when absent. Read only by `useCodebaseMap`; `checkAspira` ignores it. */
  useCodebaseMap?: boolean
}

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

/**
 * The directory of the nearest aspira.json at or above `cwd`, crossing the git root (a client harness folder
 * sits above its repos). Only `kit map-codebase` calls it (KIT-69); `resolveProjectRoot` keeps its own walk.
 */
export function nearestAspira(cwd: string): string | undefined {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ASPIRA_FILE))) return dir
    if (dirname(dir) === dir) return undefined
  }
}

const CodebaseMapsKey = z.object({ codebaseMaps: z.string().min(1).optional() })

/**
 * The map root folder for the repo at `repo`, read from the `codebaseMaps` key of the nearest aspira.json and
 * resolved against that file's folder; undefined when there is no file or no key (the in-repo layout). Only that
 * key is validated: a client-root config's other fields are not this command's business. Throws an Error naming
 * the file and the key when the file is not JSON, the value is not a string, is absolute, leaves the aspira.json
 * folder, or lies inside the repo (a map written into a client repo is what the harness layout exists to avoid).
 */
export function codebaseMapsFolder(cwd: string, repo: string): string | undefined {
  const dir = nearestAspira(cwd)
  if (dir === undefined) return undefined
  const file = join(dir, ASPIRA_FILE)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Error(`${file} is not valid JSON`)
  }
  const parsed = CodebaseMapsKey.safeParse(typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {})
  if (!parsed.success) throw new Error(`${file} "codebaseMaps" must be a folder path, relative to ${ASPIRA_FILE}`)
  const value = parsed.data.codebaseMaps
  if (value === undefined) return undefined
  if (isAbsolute(value)) throw new Error(`${file} "codebaseMaps" must be relative to ${ASPIRA_FILE}, not absolute`)
  const folder = resolve(dir, value)
  const out = relative(dir, folder)
  if (out === '..' || out.startsWith(`..${sep}`)) throw new Error(`${file} "codebaseMaps" must stay inside the folder of ${ASPIRA_FILE}`)
  const inRepo = relative(resolve(repo), folder)
  if (inRepo === '' || (!inRepo.startsWith('..') && !isAbsolute(inRepo))) throw new Error(`${file} "codebaseMaps" points inside the repository ${repo}; point it outside so nothing is written into the repository`)
  return folder
}

const UseCodebaseMapKey = z.object({ useCodebaseMap: z.boolean().optional() })

/**
 * KIT-70: whether the nearest aspira.json (walked up from `cwd`, crossing the git root) turns the codebase map on.
 * False when there is no file or no key. Throws an Error naming the file and the key when the file is not JSON
 * or the value is not a boolean.
 */
export function useCodebaseMap(cwd: string): boolean {
  const dir = nearestAspira(cwd)
  if (dir === undefined) return false
  const file = join(dir, ASPIRA_FILE)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Error(`${file} is not valid JSON`)
  }
  const parsed = UseCodebaseMapKey.safeParse(typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {})
  if (!parsed.success) throw new Error(`${file} "useCodebaseMap" must be true or false`)
  return parsed.data.useCodebaseMap ?? false
}

/** Whether git tracks the project root's aspira.json; false outside a git repository. */
export function aspiraTracked(projectRoot: string): boolean {
  return git(projectRoot, ['ls-files', '--error-unmatch', '--', ASPIRA_FILE]).status === 0
}

/** Stop tracking aspira.json (`git rm --cached`), keeping the engineer's file; true when it was tracked. A dry run only logs. */
export function untrackAspira(projectRoot: string, dryRun: boolean, log: Log): boolean {
  if (!aspiraTracked(projectRoot)) return false
  const path = join(projectRoot, ASPIRA_FILE)
  log(`untrack ${path} (git rm --cached: it is git-ignored now; the file stays)`)
  if (dryRun) return true
  const run = git(projectRoot, ['rm', '--cached', '-q', '--', ASPIRA_FILE])
  if (run.status !== 0) throw new Error(`git rm --cached ${ASPIRA_FILE} failed in ${projectRoot}: ${run.stderr.trim()}`)
  return true
}

/**
 * Put back an aspira.json git history has but the working tree lacks: a pull of the commit that stopped tracking it deletes the
 * local copy. Read from the last commit touching the path, or from its parent when that commit removed it. Never overwrites a file
 * that is there; true when it restored one. A dry run only logs.
 */
export function restoreAspira(projectRoot: string, dryRun: boolean, log: Log): boolean {
  const path = join(projectRoot, ASPIRA_FILE)
  try {
    lstatSync(path)
    return false
  } catch {
    // Nothing there: look in history below.
  }
  const last = git(projectRoot, ['log', '-1', '--format=%H', '--', ASPIRA_FILE])
  const sha = last.stdout.trim()
  if (last.status !== 0 || sha === '') return false
  let from = sha
  let show = git(projectRoot, ['show', `${sha}:./${ASPIRA_FILE}`])
  if (show.status !== 0) {
    from = `${sha}^`
    show = git(projectRoot, ['show', `${from}:./${ASPIRA_FILE}`])
  }
  if (show.status !== 0) return false
  log(`restore ${path} (from commit ${from.slice(0, 7)}${from.endsWith('^') ? '^' : ''}; git no longer tracks it)`)
  if (!dryRun) writeFileSync(path, show.stdout, { flag: 'wx' })
  return true
}

/**
 * In a linked worktree with no aspira.json, link the main checkout's at the same project path (git-ignored since KIT-71,
 * so a worktree has none), so `kit init` there merges into it instead of writing a new file without its keys (KIT-78).
 * A client file (it has `repos`) is never linked into a repo (KIT-68). Returns the linked file, or undefined.
 */
function linkMainAspira(projectRoot: string, dryRun: boolean, log: Log): string | undefined {
  const top = repositoryRoot(projectRoot)
  const main = mainCheckoutRoot(projectRoot)
  if (top === undefined || main === undefined || real(top) === real(main)) return undefined
  const source = join(real(main), relative(real(top), real(projectRoot)), ASPIRA_FILE)
  if (!existsSync(source) || readEffectiveAspira(dirname(source)).config.repos !== undefined) return undefined
  const path = join(projectRoot, ASPIRA_FILE)
  log(`link   ${path} -> ${source} (the main checkout's)`)
  if (!dryRun) symlinkSync(source, path)
  return source
}

/** Write or update aspira.json. A key that is not given keeps its current value, and so does every key kit init does not set. */
export function writeAspira(opts: { projectRoot: string; board?: string; releases?: string; app?: string; dryRun: boolean; log: Log }): void {
  const path = join(opts.projectRoot, ASPIRA_FILE)
  const linked = existsSync(path) ? undefined : linkMainAspira(opts.projectRoot, opts.dryRun, opts.log)
  const current = (linked === undefined ? readAspira(opts.projectRoot) : readJson<Partial<AspiraConfig>>(linked)) ?? {}
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
  if (config?.repos !== undefined) {
    try {
      validateClientKeys(path)
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
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

// ---- effective reader (KIT-68). Kept identical in common/src/lib/aspira-config.ts and src/aspira.ts: src cannot import common (tsconfig rootDir). ----

/** The keys a `repos` entry may carry; each replaces the top-level key of the same name inside that repo. */
export type RepoEntry = {
  path: string
  app?: string
  gates?: unknown
  dev?: unknown
  database?: unknown
  webhooks?: unknown
  tunnel?: unknown
  baseBranch?: string
}

export type EffectiveConfig = {
  statusFlow: boolean
  pullRequest: boolean
  guidelines?: string
  workRoot?: string
  extend?: Record<string, string[]>
  repos?: Record<string, RepoEntry>
  app?: string
  gates?: unknown
  dev?: unknown
  database?: unknown
  webhooks?: unknown
  tunnel?: unknown
  baseBranch?: string
  [key: string]: unknown
}

export type EffectiveAspira = {
  /** The aspira.json in use; absent when none applies. */
  file?: string
  /** The folder holding `file`. */
  root?: string
  /** The `repos` key of the repo the folder lies in (the only mapped repo when run at the client root). */
  repo?: string
  repoDir?: string
  config: EffectiveConfig
  /** An aspira.json found above a repo that does not map it; then `file` is absent. */
  ignored?: string
}

const PER_REPO_KEYS = ['app', 'gates', 'dev', 'database', 'webhooks', 'tunnel', 'baseBranch'] as const

function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function readConfigFile(file: string): Record<string, unknown> {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Error(`${file} is not valid JSON`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${file} must hold a JSON object`)
  return raw as Record<string, unknown>
}

function reposOf(raw: Record<string, unknown>): Record<string, RepoEntry> | undefined {
  const repos = raw.repos
  if (typeof repos !== 'object' || repos === null || Array.isArray(repos)) return undefined
  return repos as Record<string, RepoEntry>
}

function gitRootOf(dir: string): string | undefined {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d
    if (dirname(d) === d) return undefined
  }
}

/**
 * The aspira.json that applies to `from`: the nearest one at or above it, crossing the git root. One above a
 * repo is used only when its `repos` map that repo; otherwise it is reported as `ignored` and the defaults apply.
 * A mapped repo's per-repo keys replace the top-level ones, and its base branch defaults to main.
 */
export function readEffectiveAspira(from: string): EffectiveAspira {
  const start = real(from)
  let dir: string | undefined
  for (let d = start; ; d = dirname(d)) {
    if (existsSync(join(d, ASPIRA_FILE))) {
      dir = d
      break
    }
    if (dirname(d) === d) break
  }
  if (dir === undefined) return { config: { statusFlow: true, pullRequest: true } }
  const file = join(dir, ASPIRA_FILE)
  const raw = readConfigFile(file)
  const repos = reposOf(raw)
  const entries = Object.entries(repos ?? {}).map(([key, entry]) => ({ key, dir: real(resolve(dir, String(entry?.path ?? ''))) }))
  const hit = entries.filter((e) => within(e.dir, start)).sort((a, b) => b.dir.length - a.dir.length)[0]
  const distinct = new Set(entries.map((e) => e.dir))
  const mapped = hit ?? (start === dir && distinct.size === 1 ? entries[0] : undefined)
  const gitRoot = gitRootOf(start)
  const above = gitRoot !== undefined && gitRoot !== dir && within(dir, gitRoot)
  if (above && hit === undefined) return { ignored: file, config: { statusFlow: true, pullRequest: true } }
  const config: Record<string, unknown> = { ...raw, statusFlow: raw.statusFlow ?? true, pullRequest: raw.pullRequest ?? true }
  if (mapped !== undefined) {
    const entry = repos?.[mapped.key] ?? ({} as RepoEntry)
    for (const key of PER_REPO_KEYS) {
      delete config[key]
      if (entry[key] !== undefined) config[key] = entry[key]
    }
    config.baseBranch ??= 'main'
  }
  return { file, root: dir, ...(mapped === undefined ? {} : { repo: mapped.key, repoDir: mapped.dir }), config: config as EffectiveConfig }
}

/** The folder of the client harness (the folder of an aspira.json that has `repos`) `from` belongs to, or undefined. */
export function clientRootOf(from: string): string | undefined {
  const effective = readEffectiveAspira(from)
  return effective.file !== undefined && effective.config.repos !== undefined ? effective.root : undefined
}

export function isClientHarness(from: string): boolean {
  return clientRootOf(from) !== undefined
}

/** The absolute `workRoot` folder of the client file that applies to `from`, or undefined. */
export function workRootFor(from: string): string | undefined {
  const { root, config } = readEffectiveAspira(from)
  return root === undefined || config.workRoot === undefined ? undefined : resolve(root, config.workRoot)
}

/** The absolute `guidelines` folder of the client file that applies to `from`, or undefined. */
export function guidelinesFolder(from: string): string | undefined {
  const { root, config } = readEffectiveAspira(from)
  return root === undefined || config.guidelines === undefined ? undefined : resolve(root, config.guidelines)
}

/** The folder of the one repo the card's Area tags map to (case-insensitive); throws on none or on more than one. */
export function repoForAreas(file: string, areas: string[]): string {
  const root = dirname(file)
  const repos = reposOf(readConfigFile(file)) ?? {}
  const dirs = new Map<string, string[]>()
  for (const area of areas) {
    for (const [key, entry] of Object.entries(repos)) {
      if (key.toLowerCase() !== area.toLowerCase()) continue
      const folder = real(resolve(root, String(entry?.path ?? '')))
      dirs.set(folder, [...(dirs.get(folder) ?? []), key])
    }
  }
  const mappedTags = Object.keys(repos).join(', ')
  if (dirs.size === 0) throw new Error(`${file}: the card's Area tags [${areas.join(', ')}] map to no repo in "repos" (mapped tags: ${mappedTags})`)
  if (dirs.size > 1) throw new Error(`${file}: the card's Area tags [${areas.join(', ')}] map to more than one repo (${[...dirs.values()].map((k) => k[0]).join(', ')}); a card belongs to one repo`)
  return [...dirs.keys()][0] as string
}

type Confine = { file: string; key: string; root: string; repoDirs: string[] }

/** One path key: relative, inside the aspira.json folder, outside every repo; checked lexically and, when it exists, by realpath. */
function confine(c: Confine, value: unknown, opts: { outsideRepos: boolean; mustExist: boolean }): string {
  const name = `${c.file} "${c.key}"`
  if (typeof value !== 'string' || value === '') throw new Error(`${name} must be a path relative to ${ASPIRA_FILE}`)
  if (isAbsolute(value)) throw new Error(`${name} must be relative to ${ASPIRA_FILE}, not absolute (${value})`)
  const target = resolve(c.root, value)
  if (!within(c.root, target)) throw new Error(`${name} must stay inside the folder of ${ASPIRA_FILE} (${value})`)
  if (opts.outsideRepos && c.repoDirs.some((r) => within(r, target))) throw new Error(`${name} must not lie inside a repo (${value})`)
  if (!existsSync(target)) {
    if (opts.mustExist) throw new Error(`${name} points at ${value}, which does not exist`)
    return target
  }
  const actual = realpathSync(target)
  if (!within(real(c.root), actual)) throw new Error(`${name} resolves outside the folder of ${ASPIRA_FILE} (${value})`)
  if (opts.outsideRepos && c.repoDirs.some((r) => within(r, actual))) throw new Error(`${name} resolves inside a repo (${value})`)
  return target
}

function confineTree(c: Confine, target: string): void {
  if (!statSync(target).isDirectory()) return
  for (const name of readdirSync(target)) {
    const child = join(target, name)
    confine({ ...c, key: `${c.key}` }, relative(c.root, child), { outsideRepos: true, mustExist: true })
    if (!lstatSync(child).isSymbolicLink() && statSync(child).isDirectory()) confineTree(c, child)
  }
}

/** Refuse a client aspira.json whose keys are unusable, naming the file and the key. A file without client keys passes. */
/** The stages that read `extend` files: the agent folder names each passes to extendFilesFor. */
export const EXTEND_STAGES = ['groomer', 'spec-writer', 'planner', 'implementor', 'pr-reviewer'] as const

/** A baseBranch reaches git and a shell: only a plain branch name passes. */
function checkBaseBranch(file: string, key: string, value: unknown): void {
  if (value === undefined) return
  if (typeof value !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(value) || value.startsWith('-') || value.includes('..')) throw new Error(`${file} "${key}" must be a plain branch name (letters, digits, . _ / -, not starting with - and without ..)`)
}

export function validateClientKeys(file: string): void {
  const raw = readConfigFile(file)
  const root = dirname(file)
  const repos = raw.repos
  const repoDirs: string[] = []
  if (repos !== undefined) {
    if (typeof repos !== 'object' || repos === null || Array.isArray(repos)) throw new Error(`${file} "repos" must be an object of repo name → { path }`)
    const seen = new Map<string, string>()
    for (const [key, entry] of Object.entries(repos as Record<string, RepoEntry>)) {
      if (key.includes(',')) throw new Error(`${file} "repos" key "${key}" must not contain a comma`)
      const lower = key.toLowerCase()
      const other = seen.get(lower)
      if (other !== undefined) throw new Error(`${file} "repos" keys "${other}" and "${key}" differ only in case`)
      seen.set(lower, key)
      checkBaseBranch(file, `repos.${key}.baseBranch`, entry?.baseBranch)
      const target = confine({ file, key: 'repos', root, repoDirs: [] }, entry?.path, { outsideRepos: false, mustExist: false })
      repoDirs.push(real(target))
    }
  }
  checkBaseBranch(file, 'baseBranch', raw.baseBranch)
  const c = (key: string): Confine => ({ file, key, root, repoDirs })
  if (raw.guidelines !== undefined) confineTree(c('guidelines'), confine(c('guidelines'), raw.guidelines, { outsideRepos: true, mustExist: true }))
  if (raw.workRoot !== undefined) confine(c('workRoot'), raw.workRoot, { outsideRepos: true, mustExist: true })
  if (raw.extend !== undefined) {
    const extend = raw.extend
    if (typeof extend !== 'object' || extend === null || Array.isArray(extend)) throw new Error(`${file} "extend" must be an object of stage → files`)
    for (const [stage, files] of Object.entries(extend)) {
      if (!(EXTEND_STAGES as readonly string[]).includes(stage)) throw new Error(`${file} "extend" stage "${stage}" is not one of ${EXTEND_STAGES.join(', ')}`)
      if (!Array.isArray(files)) throw new Error(`${file} "extend" stages must list files`)
      for (const f of files) confine(c('extend'), f, { outsideRepos: true, mustExist: false })
    }
  }
  for (const key of ['statusFlow', 'pullRequest'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') throw new Error(`${file} "${key}" must be true or false`)
  }
  if (raw.pullRequest === false && raw.statusFlow !== false) throw new Error(`${file} sets "pullRequest" false without "statusFlow" false; a run with no pull request has no status to move`)
}

/** The absolute files `extend[stage]` lists for the file that applies to `from`; throws naming the file and "extend" when one is missing. */
export function extendFilesFor(from: string, stage: string): string[] {
  const { file, root, config } = readEffectiveAspira(from)
  if (file === undefined || root === undefined) return []
  validateClientKeys(file)
  return (config.extend?.[stage] ?? []).map((rel) => {
    const path = resolve(root, rel)
    if (!existsSync(path)) throw new Error(`${file} "extend" ${stage} lists ${rel}, which does not exist`)
    return path
  })
}
