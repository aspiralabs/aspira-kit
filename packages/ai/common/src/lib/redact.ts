// What makes a command's output, or a Notion card's or a PR's own text, safe to echo into a
// progress note, a Build Summary or a PR body (SEC-010). `tail` keeps only the last lines of a
// command's output, however long it ran. `redact` then makes the text safe to show: it is escaped
// so it never renders as HTML or markdown (a card or PR title is attacker-controlled text, not
// ours), and every token-shaped secret, every value a project's own `.env*` files define (the
// repository root's and, when named, the app directory's), and any extra literal value the caller
// names (the NOTION_TOKEN in use) is replaced by `[redacted]`. Those `.env*` files are the ones
// `allowedPath` (repository.ts) excludes from every other reader for the same reason: this module
// reads them only to collect the values to scrub, and never otherwise echoes a path `allowedPath`
// rejects.
//
// Callers redact individual untrusted fragments (a command's output, a title, a decision's
// reason) before they are woven into a renderer's own markdown; redacting the whole rendered
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

/** `redact`'s widening over the repository root alone: the app directory `aspira.json` names, and extra literal values the caller already knows are secret. */
export type RedactOptions = {
  /** The app directory (aspira.json `app`), read for its own `.env*` files alongside the repository root's. Absent or `.` means the root alone. */
  app?: string
  /** Literal values to redact outright (the NOTION_TOKEN value in use), alongside what `.env*` files define. */
  extra?: readonly string[]
}

/** A `.env*` key whose value is a credential by its name: the only values `redactSecrets` strips from authored prose (KIT-52). */
const SECRET_KEY = /(TOKEN|SECRET|KEY|PASSWORD|PASS|PASSWD|DSN|PRIVATE|CREDENTIAL|AUTH)/i

/** Every value a single directory's `.env*` files define, read only to redact them: never echoed back as a path or as content. With `secretKeysOnly`, only the values of SECRET_KEY-named keys. */
async function envValuesIn(dir: string, secretKeysOnly = false): Promise<string[]> {
  let names: string[]
  try {
    names = (await readdir(dir)).filter((name) => name.startsWith('.env'))
  } catch {
    return []
  }
  const values: string[] = []
  for (const name of names) {
    const raw = await readFile(join(dir, name), 'utf8').catch(() => '')
    for (const line of raw.split('\n')) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
      if (match === null) continue
      if (secretKeysOnly && !SECRET_KEY.test(match[1]!)) continue
      const value = match[2]!.replace(/^(['"])(.*)\1$/, '$2').trim()
      if (value.length >= 4) values.push(value)
    }
  }
  return values
}

/**
 * Every value to redact: the repository root's `.env*` files, the app directory's `.env*` files
 * (when `options.app` names one other than the root), and `options.extra`'s literal values.
 * Values shorter than 4 characters stay unredacted, same as a `.env*` value.
 */
export async function envValues(repo: string, options: RedactOptions = {}, secretKeysOnly = false): Promise<string[]> {
  const app = options.app
  const dirs = app === undefined || app === '' || app === '.' ? [repo] : [repo, join(repo, app)]
  const fromFiles = (await Promise.all(dirs.map((dir) => envValuesIn(dir, secretKeysOnly)))).flat()
  const extra = (options.extra ?? []).filter((value) => value.length >= 4)
  return [...fromFiles, ...extra]
}

/**
 * `text` made safe to echo into a progress note, the Build Summary or a PR body: escaped first (so
 * it renders as plain words, never as a tag or markdown), then every secret-shaped string, every
 * `.env*` value the repository root and the named app directory define, and every extra literal
 * value replaced by `[redacted]`.
 */
export async function redact(text: string, repo: string, options: RedactOptions = {}): Promise<string> {
  let result = escapeText(text)
  for (const pattern of TOKEN_PATTERNS) result = result.replace(pattern, '[redacted]')
  for (const value of await envValues(repo, options)) {
    if (value === '') continue
    result = result.split(value).join('[redacted]')
  }
  return result
}

/** TOKEN_PATTERNS anchored at a word start, for prose: `desk-side` and `task-level` are not `sk-` tokens. */
const PROSE_TOKEN_PATTERNS: readonly RegExp[] = TOKEN_PATTERNS.map((pattern) => new RegExp(`(?<![A-Za-z0-9_])(?:${pattern.source})`, pattern.flags))

/**
 * The secret pass alone, with the markdown kept (KIT-52): for text the kit's own agent authored as
 * markdown (the implementor's `## What it fixed` section), which must render as written in the PR
 * body and on the release page. Only credential-shaped tokens at a word start and the values of
 * credential-named `.env*` keys are stripped, so `NODE_ENV=production` never turns "deploy to
 * production" into "deploy to [redacted]". Never for a command's output or a card's free text:
 * those take `redact`.
 */
export async function redactSecrets(text: string, repo: string, options: RedactOptions = {}): Promise<string> {
  let result = text
  for (const pattern of PROSE_TOKEN_PATTERNS) result = result.replace(pattern, '[redacted]')
  for (const value of await envValues(repo, options, true)) {
    if (value === '') continue
    result = result.split(value).join('[redacted]')
  }
  return result
}
