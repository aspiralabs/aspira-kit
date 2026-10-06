// The dependencies a build added: every package manifest diffed between the branch base and HEAD,
// each addition flagged native (the installed package carries native code) and by its Approved
// Technologies status in the loaded knowledge. Pure functions first; `dependenciesAdded` feeds
// them from git and the installed node_modules.

import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { pageTitle } from './local-knowledge.ts'

const run = promisify(execFile)

/** A package manifest anywhere in the repository, outside node_modules. */
export const MANIFEST = /(?:^|\/)package\.json$/
/** The lockfiles a manifest change lands in. */
export const LOCKFILE = /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/
const NOT_A_SOURCE = /(?:^|\/)node_modules\//

/** The entries of an installed package that mean it has native code. */
export const NATIVE_MARKERS = ['ios/', 'android/', 'expo-module.config.json', 'react-native.config.js'] as const

/** One package a manifest gained between the base and HEAD. */
export type ManifestAddition = { name: string; version: string; manifest: string; app: string; scope: 'runtime' | 'dev' }
/** The addition with its two flags. */
export type DependencyAdded = ManifestAddition & {
  native: boolean
  nativeMarkers: string[]
  /** False when the package is not installed, so native could not be checked. */
  installed?: boolean
  approval: string
  approved: boolean
  useInstead: string
}
/** One row of the Approved Technologies page. */
export type ApprovedTechnology = { name: string; status: string; useInstead: string }
/** Everything the section is rendered from. */
export type DependencyReport = { added: DependencyAdded[]; lockfileOnly: string[]; approvedFound: boolean }

/** The name of the app a manifest belongs to: its directory, or `root`. */
export const appOf = (manifest: string): string => (dirname(manifest) === '.' ? 'root' : dirname(manifest))

function dependenciesOf(text: string | undefined, key: 'dependencies' | 'devDependencies'): Record<string, string> {
  if (text === undefined) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || !(key in parsed)) return {}
    const section: unknown = (parsed as Record<string, unknown>)[key]
    if (typeof section !== 'object' || section === null) return {}
    return Object.fromEntries(Object.entries(section).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch {
    return {}
  }
}

const depth = (path: string) => path.split('/').length
/** Manifests from the root down: fewer path segments first, then by path. */
export const byManifest = (a: string, b: string): number => depth(a) - depth(b) || a.localeCompare(b)

/** The packages new in `head` against `base` (manifest path to text; a missing base entry is a new manifest), root manifest first. */
export function manifestAdditions(base: Map<string, string>, head: Map<string, string>): ManifestAddition[] {
  const out: ManifestAddition[] = []
  for (const manifest of [...head.keys()].sort(byManifest)) {
    const before = base.get(manifest)
    const after = head.get(manifest)
    for (const [key, scope] of [['dependencies', 'runtime'], ['devDependencies', 'dev']] as const) {
      const was = dependenciesOf(before, key)
      for (const [name, version] of Object.entries(dependenciesOf(after, key))) {
        if (!Object.hasOwn(was, name)) out.push({ name, version, manifest, app: appOf(manifest), scope })
      }
    }
  }
  return out
}

/** Which native markers an installed package's top-level entries carry. */
export function nativeMarkersIn(entries: string[]): string[] {
  const names = new Set(entries)
  return NATIVE_MARKERS.filter((marker) => names.has(marker.replace(/\/$/, '')))
}

const cell = (text: string) => text.replace(/<[^>]+>/g, '').replace(/\*\*/g, '').trim()

function rowsOf(markdown: string): string[][] {
  const rows: string[][] = []
  for (const table of markdown.match(/<table[\s\S]*?<\/table>/g) ?? []) {
    for (const row of table.match(/<tr>[\s\S]*?<\/tr>/g) ?? []) rows.push([...row.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => cell(m[1] ?? '')))
  }
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|') || /^\|[\s:|-]+\|$/.test(trimmed)) continue
    rows.push(trimmed.slice(1, trimmed.endsWith('|') ? -1 : undefined).split('|').map(cell))
  }
  return rows
}

/** The technologies a page lists: every table with a Name and a Status column, in order. */
export function approvedTechnologies(markdown: string): ApprovedTechnology[] {
  const out: ApprovedTechnology[] = []
  let columns: { name: number; status: number; useInstead: number } | null = null
  for (const row of rowsOf(markdown)) {
    const lower = row.map((c) => c.toLowerCase())
    const name = lower.indexOf('name')
    const status = lower.indexOf('status')
    if (name >= 0 && status >= 0) {
      columns = { name, status, useInstead: lower.indexOf('use instead') }
      continue
    }
    if (columns === null) continue
    const entry = row[columns.name]?.trim() ?? ''
    const value = row[columns.status]?.trim() ?? ''
    if (entry === '' || value === '') continue
    out.push({ name: entry, status: value, useInstead: columns.useInstead < 0 ? '' : (row[columns.useInstead]?.trim() ?? '') })
  }
  return out
}

const normalize = (name: string) => name.toLowerCase().replace(/^@[^/]+\//, '').replace(/[\s_]+/g, '-')

/** The package's row on the page, matched by name without case, scope or spacing; `not listed` otherwise. */
export function approvalOf(name: string, list: ApprovedTechnology[]): { approval: string; approved: boolean; useInstead: string } {
  const wanted = normalize(name)
  const entry = list.find((t) => normalize(t.name) === wanted)
  if (entry === undefined) return { approval: 'not listed', approved: false, useInstead: '' }
  return { approval: entry.status, approved: /^(adopt|trial)$/i.test(entry.status), useInstead: entry.useInstead }
}

/** The Approved Technologies page in a knowledge folder, found by its header title; absent is reported, not guessed. */
export async function approvedTechnologiesIn(knowledgeDir: string): Promise<{ found: boolean; entries: ApprovedTechnology[] }> {
  for (const name of (await readdir(knowledgeDir).catch(() => [])).filter((n) => n.endsWith('.md')).sort()) {
    const text = await readFile(join(knowledgeDir, name), 'utf8')
    if (pageTitle(text)?.toLowerCase() !== 'approved technologies') continue
    return { found: true, entries: approvedTechnologies(text) }
  }
  return { found: false, entries: [] }
}

/** The `## Dependencies added` section of the progress log. */
export function renderDependencies(report: DependencyReport): string {
  const lines = ['## Dependencies added', '']
  if (report.added.length === 0 && report.lockfileOnly.length === 0) return `${lines.join('\n')}\nNone\n`
  if (report.added.length === 0) lines.push('None')
  if (!report.approvedFound && report.added.length > 0) lines.push('Approved Technologies is not in the loaded knowledge, so no addition could be checked against it; a human must approve each one.', '')
  for (const dep of report.added) {
    const native = dep.installed === false ? 'native unknown (not installed)' : dep.native ? `native (${dep.nativeMarkers.join(', ')})` : 'not native'
    const approval = dep.useInstead === '' ? dep.approval : `${dep.approval} (use ${dep.useInstead})`
    const notes: string[] = []
    if (dep.native) notes.push('A native module: the mobile app needs a store build.')
    if (!dep.approved) notes.push('Not Adopt or Trial: a human must approve it (Agent Instructions, Approved Technologies).')
    lines.push(`- \`${dep.name}\` ${dep.version} (${dep.app}, ${dep.scope}): ${native}; approval: ${approval}.${notes.length === 0 ? '' : ` ${notes.join(' ')}`}`)
  }
  for (const lockfile of report.lockfileOnly) lines.push(`- Lockfile changed without a manifest change: ${lockfile}`)
  return `${lines.join('\n')}\n`
}

async function gitText(repo: string, ref: string, path: string): Promise<string | undefined> {
  return run('git', ['-C', repo, 'show', `${ref}:${path}`], { maxBuffer: 16 * 1024 * 1024 }).then(
    ({ stdout }) => stdout,
    () => undefined,
  )
}

/** The additions between `base` and HEAD, each flagged from the app's (or the root's) node_modules and the knowledge folder. */
export async function dependenciesAdded(options: { repo: string; base: string; knowledgeDir: string }): Promise<DependencyReport> {
  const { repo, base, knowledgeDir } = options
  const changed = (await run('git', ['-C', repo, 'diff', '--name-only', base, 'HEAD'], { maxBuffer: 16 * 1024 * 1024 })).stdout
    .split('\n')
    .filter((path) => path !== '' && !NOT_A_SOURCE.test(path))
  const manifests = changed.filter((path) => MANIFEST.test(path))
  const before = new Map<string, string>()
  const after = new Map<string, string>()
  for (const manifest of manifests) {
    const was = await gitText(repo, base, manifest)
    const is = await gitText(repo, 'HEAD', manifest)
    if (was !== undefined) before.set(manifest, was)
    if (is !== undefined) after.set(manifest, is)
  }
  const touched = new Set(manifests.map(appOf))
  const lockfileOnly = changed.filter((path) => LOCKFILE.test(path) && !touched.has(appOf(path)))
  const approved = await approvedTechnologiesIn(knowledgeDir)
  const added: DependencyAdded[] = []
  for (const addition of manifestAdditions(before, after)) {
    const installedAt = [join(repo, dirname(addition.manifest), 'node_modules', addition.name), join(repo, 'node_modules', addition.name)]
    let entries: string[] | null = null
    for (const dir of installedAt) {
      entries = await readdir(dir).catch(() => null)
      if (entries !== null) break
    }
    const nativeMarkers = entries === null ? [] : nativeMarkersIn(entries)
    added.push({ ...addition, native: nativeMarkers.length > 0, nativeMarkers, installed: entries !== null, ...approvalOf(addition.name, approved.entries) })
  }
  return { added, lockfileOnly, approvedFound: approved.found }
}
