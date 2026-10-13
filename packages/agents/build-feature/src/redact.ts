// What makes a command's output, or a Notion card's or a PR's own text, safe to echo into the
// Build Summary or the PR body (SEC-010, F37). `tail` keeps only the last lines of a command's
// output, however long it ran. `redact` then makes the text safe to show: it is escaped so it
// never renders as HTML or markdown (a card or PR title is attacker-controlled text, not ours),
// and every token-shaped secret and every value a project's own `.env*` files define is replaced
// by `[redacted]`. Those `.env*` files are the ones `allowedPath` (repository.ts:10) excludes from
// every other reader for the same reason: this module reads them only to collect the values to
// scrub, and never otherwise echoes a path `allowedPath` rejects.
//
// Callers redact individual untrusted fragments (a command's output, a title, a decision's
// question) before they are woven into the renderer's own markdown; redacting the whole rendered
// document would also mangle the renderer's own headings, code fences and Mermaid blocks.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Secret-shaped strings a command's output or a pushed page might carry. */
const TOKEN_PATTERNS: readonly RegExp[] = [/ghp_[A-Za-z0-9]+/g, /github_pat_[A-Za-z0-9_]+/g, /secret_[A-Za-z0-9_-]+/gi, /ntn_[A-Za-z0-9]+/g, /sk-[A-Za-z0-9-]+/g, /Bearer\s+\S+/gi]

/** The last `max` lines of `text`, unchanged when it already has that many or fewer. */
export function tail(text: string, max = 40): string {
  const lines = text.split('\n')
  return lines.length <= max ? text : lines.slice(-max).join('\n')
}

/** `&`, `<`, `>` as entities and `` ` `` and `*` escaped: the text can no longer open an HTML tag or a markdown code span or emphasis run. */
function escapeText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('`', '\\`').replaceAll('*', '\\*')
}

/** Every value a `.env*` file at the repository's root defines, read only to redact them: never echoed back as a path or as content. */
async function envValues(repo: string): Promise<string[]> {
  let names: string[]
  try {
    names = (await readdir(repo)).filter((name) => name.startsWith('.env'))
  } catch {
    return []
  }
  const values: string[] = []
  for (const name of names) {
    const raw = await readFile(join(repo, name), 'utf8').catch(() => '')
    for (const line of raw.split('\n')) {
      const match = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*?)\s*$/.exec(line)
      if (match === null) continue
      const value = match[1]!.replace(/^(['"])(.*)\1$/, '$2').trim()
      if (value.length >= 4) values.push(value)
    }
  }
  return values
}

/**
 * `text` made safe to echo into the Build Summary or the PR body: escaped first (so it renders as
 * plain words, never as a tag or markdown), then every secret-shaped string and every `.env*`
 * value this repository defines replaced by `[redacted]`.
 */
export async function redact(text: string, repo: string): Promise<string> {
  let result = escapeText(text)
  for (const pattern of TOKEN_PATTERNS) result = result.replace(pattern, '[redacted]')
  for (const value of await envValues(repo)) {
    if (value === '') continue
    result = result.split(value).join('[redacted]')
  }
  return result
}
