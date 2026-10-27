// The one reader of aspira.json for the .ts consumers (KIT-68). The compiled kit carries the same code in src/aspira.ts.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const ASPIRA_FILE = 'aspira.json'

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
      const target = confine({ file, key: 'repos', root, repoDirs: [] }, entry?.path, { outsideRepos: false, mustExist: false })
      repoDirs.push(real(target))
    }
  }
  const c = (key: string): Confine => ({ file, key, root, repoDirs })
  if (raw.guidelines !== undefined) confineTree(c('guidelines'), confine(c('guidelines'), raw.guidelines, { outsideRepos: true, mustExist: true }))
  if (raw.workRoot !== undefined) confine(c('workRoot'), raw.workRoot, { outsideRepos: true, mustExist: true })
  if (raw.extend !== undefined) {
    const extend = raw.extend
    if (typeof extend !== 'object' || extend === null || Array.isArray(extend)) throw new Error(`${file} "extend" must be an object of stage → files`)
    for (const files of Object.values(extend)) {
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
