// Build and check a repo's codebase map. A build scans the repo (scan.ts), reuses cached syntax facts for files whose
// hash is unchanged, resolves every import again (a target may have appeared or gone), and writes the whole map into a
// temporary sibling folder that replaces map/ only when complete, under a lock file in the map root.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import ts from 'typescript'
import { SOURCE_EXTENSIONS, extractFacts, resolveEdges, type SyntaxFacts } from './imports.ts'
import { markStale, readNotes } from './notes.ts'
import { MANIFEST_FILE, compareManifest, readManifest, type Freshness, type Manifest } from './manifest.ts'
import { packageForPath, surfaceForPath, type PackageInfo } from './membership.ts'
import { dirtyFiles, scanFiles, type ScannedFile } from './scan.ts'
import { GRAPH_FILE, SCHEMA, readCache, writeGraph, type CacheEntry, type Graph } from './sqlite-store.ts'

const exec = promisify(execFile)

export const SCANNER = `1+typescript-${ts.version}`
export const mapDirOf = (mapRoot: string): string => join(mapRoot, 'map')
const LOCK = '.build.lock'

export type BuildSummary = { mapRoot: string; commit: string; files: number; internal: number; external: number; unresolved: number; parsed: number; reused: number; removed: number }

async function git(repo: string, args: string[]): Promise<string> {
  return (await exec('git', ['-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout.trim()
}

export async function repoIdentity(repo: string): Promise<Manifest['repo']> {
  const roots = await git(repo, ['rev-list', '--max-parents=0', 'HEAD']).catch(() => '')
  const common = await git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => join(repo, '.git'))
  return { rootCommit: roots.split('\n')[0] ?? '', mainCheckout: dirname(common) }
}

const headCommit = (repo: string): Promise<string> => git(repo, ['rev-parse', 'HEAD']).catch(() => 'none')

/** Refuses a map built for another repo: the same map root reached from two repos of one directory name. */
export async function assertSameRepo(repo: string, mapRoot: string): Promise<void> {
  const manifest = await readManifest(mapDirOf(mapRoot))
  if (manifest === undefined) return
  const now = await repoIdentity(repo)
  if (manifest.repo.rootCommit !== now.rootCommit || manifest.repo.mainCheckout !== now.mainCheckout) {
    throw new Error(`the map in ${mapRoot} belongs to ${manifest.repo.mainCheckout}, not ${now.mainCheckout}; nothing was written. Point each repo at its own map root.`)
  }
}

async function current(repo: string, mapRoot: string): Promise<{ scanned: ScannedFile[]; now: Pick<Manifest, 'scanner' | 'commit' | 'dirty' | 'files'> }> {
  const [scanned, dirty, commit] = await Promise.all([scanFiles(repo, mapRoot), dirtyFiles(repo, mapRoot), headCommit(repo)])
  return { scanned, now: { scanner: SCANNER, commit, dirty, files: Object.fromEntries(scanned.map((file) => [file.path, file.hash])) } }
}

export async function checkMap(repo: string, mapRoot: string): Promise<Freshness> {
  await assertSameRepo(repo, mapRoot)
  const manifest = await readManifest(mapDirOf(mapRoot))
  if (manifest === undefined) return { state: 'missing' }
  return compareManifest(manifest, (await current(repo, mapRoot)).now)
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function takeLock(mapRoot: string): Promise<() => Promise<void>> {
  const file = join(mapRoot, LOCK)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(file, String(process.pid), { flag: 'wx' })
      return () => unlink(file).catch(() => undefined)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const pid = Number((await readFile(file, 'utf8').catch(() => '')).trim())
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) throw new Error(`a build is running in ${mapRoot} (process ${pid}); try again when it finishes`)
      await unlink(file).catch(() => undefined) // its process is gone: take the lock over
    }
  }
  throw new Error(`a build is running in ${mapRoot}`)
}

async function readPackages(repo: string, scanned: ScannedFile[]): Promise<PackageInfo[]> {
  const out: PackageInfo[] = []
  for (const file of scanned) {
    if (basename(file.path) !== 'package.json') continue
    const dir = dirname(file.path)
    let name = ''
    try {
      const parsed = JSON.parse(await readFile(join(repo, file.path), 'utf8')) as { name?: unknown }
      if (typeof parsed.name === 'string') name = parsed.name
    } catch {
      // a package.json that is not JSON still marks its folder as a package
    }
    out.push({ dir, name: name === '' ? dir : name })
  }
  return out
}

const slug = (text: string): string => text.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'root'

function mapMarkdown(summary: BuildSummary, graph: Graph): string {
  const bySurface = new Map<string, number>()
  for (const node of graph.nodes) bySurface.set(node.surface, (bySurface.get(node.surface) ?? 0) + 1)
  const lines = [
    '# Codebase map',
    '',
    `Commit ${summary.commit}. ${summary.files} files, ${summary.internal} internal import edges, ${summary.external} external, ${summary.unresolved} unresolved.`,
    '',
    'Orientation only: verify with source reads before relying on anything here.',
    '',
    '## Surfaces',
    '',
    ...[...bySurface].sort(([a], [b]) => a.localeCompare(b)).map(([surface, n]) => `- ${surface}: ${n}`),
    '',
    '## Packages',
    '',
    ...graph.packages.map((pkg) => `- ${pkg.name} (${pkg.dir}): ${graph.nodes.filter((node) => node.packageDir === pkg.dir).length} files`),
    '',
  ]
  return lines.join('\n')
}

function packageBrief(pkg: { dir: string; name: string }, graph: Graph): string {
  const nodes = graph.nodes.filter((node) => node.packageDir === pkg.dir)
  return [`# ${pkg.name}`, '', `Folder ${pkg.dir}. ${nodes.length} files. Orientation only: verify with source reads.`, '', ...nodes.map((node) => `- ${node.path} (${node.surface})`), ''].join('\n')
}

/** Puts a finished folder in place of map/ (the old one is kept aside until the new one is in). */
async function swapIn(mapRoot: string, tmp: string): Promise<void> {
  const map = mapDirOf(mapRoot)
  const old = join(mapRoot, 'map.prev')
  await rm(old, { recursive: true, force: true })
  if (existsSync(map)) await rename(map, old)
  await rename(tmp, map)
  await rm(old, { recursive: true, force: true })
}

/** `notesDir` is the notes folder; accepted notes whose cited file changed become stale on every build. `null` when the notes belong to another checkout (a linked worktree's build of the harness layout): they are neither read nor marked. */
export async function buildMap(repo: string, mapRoot: string, notesDir: string | null = join(mapRoot, 'notes')): Promise<BuildSummary> {
  await assertSameRepo(repo, mapRoot)
  await mkdir(mapRoot, { recursive: true })
  const release = await takeLock(mapRoot)
  try {
    // A build killed between its two renames left the previous complete map aside: put it back.
    if (!existsSync(mapDirOf(mapRoot)) && existsSync(join(mapRoot, 'map.prev'))) await rename(join(mapRoot, 'map.prev'), mapDirOf(mapRoot))
    for (const entry of await readdir(mapRoot, { withFileTypes: true })) if (entry.isDirectory() && entry.name.startsWith('build-')) await rm(join(mapRoot, entry.name), { recursive: true, force: true })
    const tmp = join(mapRoot, `build-${process.pid}`)
    await mkdir(tmp)

    const { scanned, now } = await current(repo, mapRoot)
    if (notesDir !== null) {
      for (const warning of (await readNotes(notesDir)).warnings) console.error(`map-codebase: ${warning}`)
      await markStale(notesDir, repo, now.files)
    }
    const previous = readCache(join(mapDirOf(mapRoot), GRAPH_FILE))
    const facts = new Map<string, SyntaxFacts>()
    const cache = new Map<string, CacheEntry>()
    let parsed = 0
    let reused = 0
    for (const file of scanned) {
      const hit = previous.get(file.path)
      if (hit !== undefined && hit.hash === file.hash && hit.scanner === SCANNER) {
        if (SOURCE_EXTENSIONS.test(file.path)) facts.set(file.path, hit.facts)
        cache.set(file.path, hit)
        reused++
        continue
      }
      const entry: CacheEntry = { hash: file.hash, scanner: SCANNER, facts: SOURCE_EXTENSIONS.test(file.path) ? extractFacts(file.path, await readFile(join(repo, file.path), 'utf8')) : { imports: [], exports: [], env: [] } }
      if (SOURCE_EXTENSIONS.test(file.path)) facts.set(file.path, entry.facts)
      cache.set(file.path, entry)
      parsed++
    }
    const removed = [...previous.keys()].filter((path) => !cache.has(path)).length

    const packages = await readPackages(repo, scanned)
    const edges = resolveEdges({ repo, files: new Set(scanned.map((file) => file.path)), packages }, facts)
    const graph: Graph = {
      nodes: scanned.map((file) => {
        const pkg = packageForPath(file.path, packages)
        return { path: file.path, hash: file.hash, package: pkg?.name ?? '', packageDir: pkg?.dir ?? '', surface: surfaceForPath(file.path), language: SOURCE_EXTENSIONS.test(file.path) ? 'typescript' : (/\.([^./]+)$/.exec(file.path)?.[1] ?? '') }
      }),
      packages,
      edges,
      envReads: [...facts].flatMap(([path, fact]) => fact.env.map((name) => ({ name, path }))),
      symbols: [...facts].flatMap(([path, fact]) => fact.exports.map((name) => ({ name, path }))),
    }
    writeGraph(join(tmp, GRAPH_FILE), graph, cache)

    const summary: BuildSummary = {
      mapRoot,
      commit: now.commit,
      files: scanned.length,
      internal: edges.filter((edge) => edge.kind === 'internal').length,
      external: edges.filter((edge) => edge.kind === 'external').length,
      unresolved: edges.filter((edge) => edge.kind === 'unresolved').length,
      parsed,
      reused,
      removed,
    }
    const manifest: Manifest = { version: 1, scanner: SCANNER, commit: now.commit, dirty: now.dirty, repo: await repoIdentity(repo), files: now.files }
    await writeFile(join(tmp, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
    await writeFile(join(tmp, 'CODEBASE_MAP.md'), mapMarkdown(summary, graph))
    await mkdir(join(tmp, 'schema'))
    await writeFile(join(tmp, 'schema', 'graph.sql'), SCHEMA.trimStart())
    await mkdir(join(tmp, 'briefs'))
    for (const pkg of packages) await writeFile(join(tmp, 'briefs', `${slug(pkg.dir)}.md`), packageBrief(pkg, graph))
    await swapIn(mapRoot, tmp)
    return summary
  } finally {
    await release()
  }
}
