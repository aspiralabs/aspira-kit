// Mid-build notes at final verification: every backticked identifier, path, option name or
// signature in a notes file is searched in the repository; one that no longer exists is corrected
// to its current name when a renamed symbol is found, or its sentence is removed. The rewritten
// file starts with a header carrying the commit SHA. Pure functions first; the git-backed
// searcher and the file operations are at the end.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** The first line of a rewritten notes file. */
export const NOTES_HEADER = (sha: string, at: string): string => `<!-- Rewritten from the code at verification · commit ${sha} · ${at} -->`
const HEADER_LINE = /^<!-- Rewritten from the code at verification · commit ([0-9a-f]{7,40}) · \S+ -->\n?/

/** What the search found for one identifier. */
export type Finding = { status: 'found' } | { status: 'renamed'; to: string } | { status: 'missing' }
/** How a searcher answers for a term: whether it exists, and the tokens that could be its new name. */
export type Searcher = { exists(term: string): Promise<boolean>; candidates(term: string): Promise<string[]> }
/** What a rewrite did to one notes file. */
export type NotesResult = { file: string; action: 'rewritten'; corrected: { from: string; to: string }[]; removed: string[] } | { file: string; action: 'deleted' }

/** The backticked tokens of a notes file, once each, in order; empty tokens are skipped. */
export function identifiersIn(notes: string): string[] {
  return [...new Set([...notes.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!.trim()).filter((t) => t.length > 1))]
}

/** What to search for: a signature or a generic is searched by its leading name. */
export function searchTerm(token: string): string {
  const lead = token.match(/^[^\s(<:]+/)?.[0] ?? token
  return lead.replace(/[.,;]+$/, '') || token
}

const isPath = (term: string) => term.includes('/') || /\.[a-z0-9]{1,5}$/i.test(term)

/** The words of an identifier (camelCase, snake_case, kebab-case, path segments), lower case. */
export function wordsOf(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w !== '')
}

const bigrams = (text: string): string[] => {
  const t = text.toLowerCase()
  return Array.from({ length: Math.max(0, t.length - 1) }, (_, i) => t.slice(i, i + 2))
}
function dice(a: string, b: string): number {
  const left = bigrams(a)
  const right = bigrams(b)
  if (left.length === 0 || right.length === 0) return 0
  const counts = new Map<string, number>()
  for (const g of left) counts.set(g, (counts.get(g) ?? 0) + 1)
  let shared = 0
  for (const g of right) {
    const n = counts.get(g) ?? 0
    if (n > 0) {
      shared += 1
      counts.set(g, n - 1)
    }
  }
  return (2 * shared) / (left.length + right.length)
}
const tail = (path: string) => path.split('/').pop() ?? path

/**
 * The candidate most likely to be the identifier's new name: it must share a word with the old
 * name, and the best Jaccard-on-words plus Dice-on-characters score must clear 0.4. Paths compare
 * by basename. Null when nothing is close enough.
 */
export function bestRename(identifier: string, candidates: string[]): string | null {
  const key = isPath(identifier) ? tail(identifier) : identifier
  const words = new Set(wordsOf(key))
  let best: { name: string; score: number } | null = null
  for (const candidate of new Set(candidates)) {
    if (candidate === identifier) continue
    const other = isPath(identifier) ? tail(candidate) : candidate
    const theirs = new Set(wordsOf(other))
    const shared = [...words].filter((w) => theirs.has(w)).length
    // No shared word is not a rename; neither is one bare word of the old name (`cart` for `cartBadge`).
    if (shared === 0 || (theirs.size === 1 && words.size > 1 && shared === 1)) continue
    const union = new Set([...words, ...theirs]).size
    const score = (shared / union + dice(key, other)) / 2
    if (score >= 0.4 && (best === null || score > best.score)) best = { name: candidate, score }
  }
  return best?.name ?? null
}

/** One finding per backticked token. */
export async function checkNotes(notes: string, searcher: Searcher): Promise<Map<string, Finding>> {
  const out = new Map<string, Finding>()
  for (const token of identifiersIn(notes)) {
    const term = searchTerm(token)
    if (await searcher.exists(term)) {
      out.set(token, { status: 'found' })
      continue
    }
    const to = bestRename(term, await searcher.candidates(term))
    out.set(token, to === null ? { status: 'missing' } : { status: 'renamed', to })
  }
  return out
}

/** The tokens that are not in the repository as written. */
export async function staleIdentifiers(notes: string, searcher: Searcher): Promise<string[]> {
  return [...(await checkNotes(notes, searcher))].filter(([, f]) => f.status !== 'found').map(([token]) => token)
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function withoutSentences(line: string, tokens: string[]): string | null {
  if (!tokens.some((t) => line.includes(`\`${t}\``))) return line
  if (line.trim().startsWith('|')) return null
  const marker = line.match(/^\s*(?:(?:[-*+]|\d+\.)\s+)?/)?.[0] ?? ''
  const body = line.slice(marker.length)
  const kept = body.split(/(?<=[.!?])\s+/).filter((sentence) => !tokens.some((t) => sentence.includes(`\`${t}\``)))
  if (kept.join('').trim() === '') return null
  return marker + kept.join(' ')
}

/** The notes with renamed tokens corrected, the sentences of missing ones removed, and one header carrying the SHA. */
export function rewriteNotes(notes: string, findings: Map<string, Finding>, header: { sha: string; at: string }): { text: string; corrected: { from: string; to: string }[]; removed: string[] } {
  const corrected: { from: string; to: string }[] = []
  const removed: string[] = []
  let text = notes.replace(HEADER_LINE, '')
  for (const [token, finding] of findings) {
    if (finding.status !== 'renamed') continue
    const to = token.replace(searchTerm(token), finding.to)
    text = text.replace(new RegExp(`\`${escape(token)}\``, 'g'), `\`${to}\``)
    corrected.push({ from: token, to: finding.to })
  }
  const missing = [...findings].filter(([, f]) => f.status === 'missing').map(([token]) => token)
  if (missing.length > 0) {
    text = text
      .split('\n')
      .map((line) => withoutSentences(line, missing))
      .filter((line): line is string => line !== null)
      .join('\n')
    removed.push(...missing)
  }
  return { text: `${NOTES_HEADER(header.sha, header.at)}\n${text}`, corrected, removed }
}

/** The SHA a rewritten notes file carries, or null when it has no header. */
export function notesHeaderSha(text: string): string | null {
  return text.match(HEADER_LINE)?.[1] ?? null
}

/** A searcher over a repository: `git grep -F` (or the path exists), and `git grep -o` / `git ls-files` for candidates. */
export function repoSearcher(repo: string): Searcher {
  const grep = async (args: string[]): Promise<string> => run('git', ['-C', repo, 'grep', '-I', ...args], { maxBuffer: 64 * 1024 * 1024 }).then(({ stdout }) => stdout, () => '')
  return {
    async exists(term) {
      if (existsSync(join(repo, term))) return true
      return run('git', ['-C', repo, 'grep', '-I', '-F', '-q', '-e', term, '--', '.']).then(() => true, () => false)
    },
    async candidates(term) {
      const words = wordsOf(isPath(term) ? tail(term) : term).filter((w) => w.length >= 3)
      if (words.length === 0) return []
      if (isPath(term)) {
        const files = (await run('git', ['-C', repo, 'ls-files'], { maxBuffer: 64 * 1024 * 1024 })).stdout.split('\n')
        return files.filter((file) => file !== '' && words.some((w) => tail(file).toLowerCase().includes(w)))
      }
      const found = new Set<string>()
      for (const word of words) {
        const out = await grep(['-o', '-h', '-i', '-E', '-e', `[A-Za-z0-9_$]*${escape(word)}[A-Za-z0-9_$]*`, '--', '.'])
        for (const token of out.split('\n')) if (token !== '') found.add(token)
      }
      return [...found]
    },
  }
}

/** The notes files under a work directory: handoff-notes.md first, then any *notes*.md, never from trace/ or an excluded directory. */
export async function notesFilesIn(workDir: string, options: { exclude?: string[] } = {}): Promise<string[]> {
  const excluded = new Set(['trace', ...(options.exclude ?? [])])
  const names = await readdir(workDir).catch(() => [])
  return names
    .filter((name) => !excluded.has(name) && /notes.*\.md$/i.test(name))
    .sort((a, b) => (a === 'handoff-notes.md' ? -1 : b === 'handoff-notes.md' ? 1 : a.localeCompare(b)))
    .map((name) => join(workDir, name))
}

/** Rewrites one notes file in place from the repository at HEAD, with the header. */
export async function rewriteNotesFile(options: { repo: string; file: string; sha: string; now?: () => Date }): Promise<NotesResult> {
  const { repo, file, sha } = options
  const notes = await readFile(file, 'utf8')
  const findings = await checkNotes(notes, repoSearcher(repo))
  const result = rewriteNotes(notes, findings, { sha, at: (options.now ?? (() => new Date()))().toISOString() })
  await writeFile(file, result.text)
  return { file, action: 'rewritten', corrected: result.corrected, removed: result.removed }
}

/** Deletes one notes file. */
export async function deleteNotesFile(file: string): Promise<NotesResult> {
  await rm(file, { force: true })
  return { file, action: 'deleted' }
}
