import { execFile } from 'node:child_process'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { tool } from 'ai'
import { z } from 'zod'

const run = promisify(execFile)
export function allowedPath(path: string): boolean {
  return !/(?:^|\/)[^/]*\.(?:debate|review)[^/]*\//i.test(path) && !/(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|bun\.lockb?|yarn\.lock)$/.test(path) && !path.split('/').some((part) => /^(?:\.env(?:\..*)?|\.git|node_modules|\.eve|\.next|dist|\.output|coverage|vendor|(?:secrets?|credentials?)(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_rsa|id_ed25519)$/i.test(part)) && !/\.(?:pem|key|p12|pfx|lock|avif|webp|svg|png|jpe?g|gif|pdf|woff2?|zip|gz|mp4)$/i.test(path)
}


const MAX_REF_MATCHES = 3
const PACKET_BUDGET = 110_000
const MAX_EXCERPT = 40_000
const MIN_EXCERPT = 2_000

/** A reproducible source packet avoids a frontier model spending its budget navigating.
 * Omitted/truncated material stays available through the specialist read tools. */
export function evidencePacket(spec: string, files: Map<string, string>): string {
  const refs = [...new Set([...spec.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!).filter((value) => value.length < 160))]
  const exact = new Set<string>()
  const selected = new Set<string>()
  const producers = new Set<string>()
  const producerFacts: string[] = []
  for (const ref of refs) {
    const path = ref.split('?')[0]!
    if (files.has(path)) { exact.add(path); selected.add(path); continue }
    // Only path-like refs and component names name files. A bare word such as
    // `page` or `sort` would suffix-match dozens of files and flood the budget.
    const component = /^[A-Z][A-Za-z0-9]+$/.test(path)
    if (!component && !path.includes('/') && !/\.[a-z]{1,5}$/i.test(path)) continue
    const kebab = path.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
    const matches = [...files.keys()].filter((file) => file.endsWith(`/${path}`) || file.endsWith(`${path}/route.ts`) || (component && (file.endsWith(`/${kebab}.tsx`) || file.endsWith(`/${kebab}.ts`))))
    // An ambiguous ref is skipped; the spec's full paths and the read tools cover it.
    if (matches.length <= MAX_REF_MATCHES) for (const file of matches) selected.add(file)
  }
  // Schema and policy are high-signal context for virtually every data feature.
  for (const file of files.keys()) if (/(?:schema\.prisma|auth\.config\.ts)$/.test(file)) selected.add(file)
  // Include first-hop code dependencies so DTO and fetcher contracts are visible.
  for (const file of [...selected]) {
    for (const match of (files.get(file) ?? '').matchAll(/from ['"](@\/[^'"]+)['"]/g)) {
      const suffix = match[1]!.slice(2)
      for (const candidate of files.keys()) if (candidate.endsWith(`/${suffix}.ts`) || candidate.endsWith(`/${suffix}.tsx`)) selected.add(candidate)
    }
    // Fetch URLs reveal the CURRENT producer, which may differ from the route a
    // spec proposes migrating to. Include it so existing limits are not missed.
    for (const match of (files.get(file) ?? '').matchAll(/\b(?:useFetcher|fetch|apiFetch|request)(?:<[^>\n]+>)?\s*\(\s*['"`]\/((?:api\/)[^'"`?${}\s]+)(?:\?[^'"`]*)?['"`]/g)) {
      for (const candidate of files.keys()) if (candidate.endsWith(`/${match[1]}/route.ts`)) {
        selected.add(candidate)
        producers.add(candidate)
        const bounds = files.get(candidate)!.split('\n').flatMap((line, index) => /\bLIMIT\s+\d+|\btake:\s*\d+|\.slice\(\s*0\s*,\s*\d+/i.test(line) ? [`${candidate}:${index + 1}: ${line.trim().slice(0, 300)}`] : [])
        producerFacts.push(`${file} references /${match[1]} → ${candidate}${bounds.length ? `; observed result bounds:\n${bounds.join('\n')}` : ''}`)
      }
    }
  }
  // Files the spec names by full path come first, then current producers, so
  // neither looser matches nor long docs and schema excerpts can push them out.
  const ordered = new Set([...exact, ...producers, ...[...selected].filter((file) => !file.endsWith('.md')), ...selected])
  const bodies = new Map([...ordered].map((file) => {
    const lines = files.get(file)!.split('\n')
    return [file, { lines: lines.length, body: lines.map((line, index) => `${index + 1}: ${line}`).join('\n') }] as const
  }))
  // Named targets and current producers share the budget first; schema, policy,
  // imports and looser matches get what is left. Within a tier the budget is
  // shared smallest-first, so one large file cannot crowd out several small
  // ones. Truncated or omitted files stay reachable through read_files.
  const primary = [...ordered].filter((file) => exact.has(file) || producers.has(file))
  const tiers = [primary, [...ordered].filter((file) => !primary.includes(file))]
  const admitted: string[] = []
  const allotment = new Map<string, number>()
  let left = PACKET_BUDGET
  for (const tier of tiers) {
    const members: string[] = []
    let reserved = 0
    for (const file of tier) {
      const floor = Math.min(bodies.get(file)!.body.length, MIN_EXCERPT)
      if (reserved + floor > left) break
      members.push(file)
      reserved += floor
    }
    const bySize = [...members].sort((a, b) => bodies.get(a)!.body.length - bodies.get(b)!.body.length)
    bySize.forEach((file, index) => {
      const take = Math.min(bodies.get(file)!.body.length, MAX_EXCERPT, Math.floor(left / (bySize.length - index)))
      allotment.set(file, take)
      left -= take
    })
    admitted.push(...members)
  }
  const parts = admitted.map((file) => {
    const { lines, body } = bodies.get(file)!
    const excerpt = body.slice(0, allotment.get(file))
    return `SOURCE ${file} (${lines} lines)\n${excerpt}${excerpt.length < body.length ? '\n[PACKET EXCERPT TRUNCATED: use read_files/search for remaining lines]' : ''}`
  })
  return `Source packet selected from spec references, schemas, auth policy and first-hop imports. It is not exhaustive; specialists must inspect callers and missing paths.\nCURRENT PRODUCER LINKS (literal source observations; check applicability):\n${producerFacts.slice(0, 30).join('\n')}\n\n${parts.join('\n\n')}`
}

export async function repository(root: string, signal?: AbortSignal) {
  const base = await realpath(root)
  const listing = await run('git', ['-C', base, 'ls-files', '-z', '-co', '--exclude-standard'], { maxBuffer: 16 * 1024 * 1024, signal })
  const paths = [...new Set(listing.stdout.split('\0').filter((p) => p && allowedPath(p)))].sort()
  const files = new Map<string, string>()
  const gaps: string[] = []
  let bytes = 0
  for (const path of paths) {
    signal?.throwIfAborted()
    const target = await realpath(resolve(base, path)).catch(() => null)
    if (target === null) continue
    const rel = relative(base, target)
    if (rel.startsWith('..') || isAbsolute(rel) || !allowedPath(rel)) continue
    const info = await stat(target)
    if (!info.isFile()) continue
    if (info.size > 256 * 1024 || bytes + info.size > 40 * 1024 * 1024) { gaps.push(`Not indexed (size budget): ${path}`); continue }
    const text = await readFile(target, 'utf8')
    if (text.includes('\0')) continue
    files.set(path, text)
    bytes += info.size
  }
  const commit = (await run('git', ['-C', base, 'rev-parse', 'HEAD'], { signal })).stdout.trim()
  const status = (await run('git', ['-C', base, 'status', '--porcelain'], { signal })).stdout.trim()
  const instructions = [...files].filter(([p]) => /(^|\/)(AGENTS|CLAUDE)\.md$/.test(p) || /agent\/constraints\.md$/.test(p)).map(([p, text]) => `SOURCE ${p}\n${text}`).join('\n\n')
  return {
    files, commit, dirty: status.length > 0, gaps, instructions, packet: (spec: string) => evidencePacket(spec, files),
    tools: {
      list_files: tool({ description: 'List available snapshot paths matching a substring. Refine when truncated.', inputSchema: z.object({ contains: z.string() }), execute: async ({ contains }) => {
        const matches = [...files.keys()].filter((p) => p.toLowerCase().includes(contains.toLowerCase()))
        return { paths: matches.slice(0, 200), total: matches.length }
      } }),
      read_files: tool({ description: 'Read up to 8 repository files with line numbers. Paths are relative to repo root. No shell or external paths.', inputSchema: z.object({ files: z.array(z.object({ path: z.string(), start: z.number().int().min(1), lines: z.number().int().min(1).max(200) })).max(8) }), execute: async ({ files: requests }) => requests.map(({ path, start, lines }) => {
        const suffixMatches = [...files.keys()].filter((candidate) => candidate.endsWith(`/${path}`))
        const canonical = files.has(path) ? path : suffixMatches.length === 1 ? suffixMatches[0]! : path
        const text = files.get(canonical)
        if (text === undefined) return { path, error: 'Not in readable snapshot', candidates: suffixMatches.slice(0, 10) }
        const all = text.split('\n')
        return { path: canonical, totalLines: all.length, text: all.slice(start - 1, start - 1 + lines).map((line, i) => `${start + i}: ${line}`).join('\n') }
      }) }),
      search: tool({ description: 'Literal case-insensitive repository search, batched up to 16 queries. Returns file:line evidence. Refine path when truncated.', inputSchema: z.object({ queries: z.array(z.string().min(1)).max(16), pathContains: z.string() }), execute: async ({ queries, pathContains }) => queries.map((query) => {
        const hits: string[] = []
        for (const [path, text] of files) {
          if (!path.includes(pathContains)) continue
          text.split('\n').forEach((line, i) => { if (line.toLowerCase().includes(query.toLowerCase())) hits.push(`${path}:${i + 1}: ${line.slice(0, 500)}`) })
        }
        return { query, total: hits.length, hits: hits.slice(0, 80) }
      }) }),
    },
  }
}
