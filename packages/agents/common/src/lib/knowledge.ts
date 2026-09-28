// Pure helpers for load-knowledge: turning a Notion page tree into markdown
// files under /workspace/knowledge. No eve or node imports, so it is unit tested.

/** Where the guidelines land in the sandbox. The index page becomes INDEX.md. */
export const KNOWLEDGE_PATH = '/workspace/knowledge'
export const INDEX_FILE = `${KNOWLEDGE_PATH}/INDEX.md`

/** Notion's markdown endpoint, added in the 2026-03-11 API version. */
export const NOTION_VERSION = '2026-03-11'
export const NOTION_API = 'https://api.notion.com/v1'

/** Env: the integration token, and the page the walk starts from (URL or id). */
export const KNOWLEDGE_ENV = { token: 'NOTION_TOKEN', page: 'KNOWLEDGE_PAGE' } as const

/** How far below the index page the walk goes, and how many pages it will load. */
export const MAX_DEPTH = 3
export const MAX_PAGES = 80

export type ChildPage = { id: string; title: string; url: string }

function dashed(hex: string): string {
  const h = hex.toLowerCase()
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** The page id, dashed, from a Notion URL, a dashed id, or a bare 32-hex id: the last 32 hex characters of the last path segment once dashes are removed. */
export function pageIdFrom(input: string): string | undefined {
  const path = input.trim().split('?')[0] ?? ''
  const last = path.split('/').pop() ?? path
  const match = last.replace(/-/g, '').match(/([0-9a-f]{32})$/i)
  return match?.[1] === undefined ? undefined : dashed(match[1])
}

/**
 * Child pages as the markdown endpoint renders them: `<page url="…">title</page>` for
 * pages nested under this one, and `<mention-page url="…"/>` for pages linked inline,
 * which carry no title (the caller looks it up). Databases are skipped. One entry per id.
 */
export function childPagesOf(markdown: string): ChildPage[] {
  const out: ChildPage[] = []
  const seen = new Set<string>()
  const re = /<page url="([^"]+)">([^<]*)<\/page>|<mention-page url="([^"]+)"\s*\/>/g
  for (const m of markdown.matchAll(re)) {
    const url = m[1] ?? m[3] ?? ''
    const id = pageIdFrom(url)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    out.push({ id, title: (m[2] ?? '').trim(), url })
  }
  return out
}

function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'page'
  )
}

/** The sandbox file for a page title. `used` keeps two pages with the same slug apart. */
export function fileFor(title: string, used?: Set<string>): string {
  const base = `${KNOWLEDGE_PATH}/${slug(title)}`
  let candidate = `${base}.md`
  let n = 2
  while (used?.has(candidate)) {
    candidate = `${base}-${n}.md`
    n += 1
  }
  used?.add(candidate)
  return candidate
}

/**
 * Page tags become markdown links: a local file for a page that was fetched, the Notion
 * URL otherwise. Mentions carry no title, so `titles` supplies one for fetched pages.
 */
export function rewriteLinks(markdown: string, local: Map<string, string>, titles: Map<string, string> = new Map()): string {
  return markdown
    .replace(/<page url="([^"]+)">([^<]*)<\/page>/g, (_m, url: string, title: string) => {
      const id = pageIdFrom(url)
      const target = id === undefined ? url : (local.get(id) ?? url)
      return `[${title.trim()}](${target})`
    })
    .replace(/<mention-page url="([^"]+)"\s*\/>/g, (_m, url: string) => {
      const id = pageIdFrom(url)
      const target = id === undefined ? url : (local.get(id) ?? url)
      const title = (id === undefined ? undefined : titles.get(id)) ?? url
      return `[${title}](${target})`
    })
}

export type PageMeta = { title: string; url: string; fetchedAt: string; truncated: boolean }

/** A fetched page as written to the sandbox: provenance first, then the markdown. */
export function renderPage(meta: PageMeta, markdown: string): string {
  const flag = meta.truncated ? ' · TRUNCATED by the Notion API, read the source for the rest' : ''
  return `<!-- ${meta.title} · ${meta.url} · fetched ${meta.fetchedAt}${flag} -->\n\n${markdown.trim()}\n`
}

/** Env: comma-separated titles (or Notion URLs/ids) of the pages every agent must ingest in full before its first finding. Unset means DEFAULT_REQUIRED; an empty string means none. */
export const REQUIRED_ENV = 'KNOWLEDGE_REQUIRED'
export const REQUIRED_FILE = `${KNOWLEDGE_PATH}/REQUIRED.md`
export const DEFAULT_REQUIRED = ['Agent Instructions', 'Review Verification']

export function parseRequired(value: string | undefined): string[] {
  if (value === undefined) return DEFAULT_REQUIRED
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

export type LoadedPage = { id: string; title: string; url: string; markdown: string }

/** Each required entry resolved to a loaded page, by id when the entry is a URL or id, else by case-insensitive title. Order follows `required`; duplicates collapse. */
export function resolveRequired(required: string[], pages: LoadedPage[]): { found: LoadedPage[]; missing: string[] } {
  const found: LoadedPage[] = []
  const missing: string[] = []
  for (const entry of required) {
    const id = pageIdFrom(entry)
    const wanted = entry.trim().toLowerCase()
    const page = pages.find((p) => (id !== undefined && p.id === id) || p.title.trim().toLowerCase() === wanted)
    if (page === undefined) missing.push(entry)
    else if (!found.includes(page)) found.push(page)
  }
  return { found, missing }
}

/** REQUIRED.md: the required pages concatenated in order, each under its title with its source, so one `cat` is the whole required reading. */
export function renderRequired(pages: LoadedPage[], fetchedAt: string): string {
  const head = `<!-- Required reading · ${pages.length} page${pages.length === 1 ? '' : 's'} · fetched ${fetchedAt} -->

Every agent reads this file in full before its first finding. It is the pages the org marks as required, in order. Rules keep their ids; cite them by id.
`
  const body = pages.map((p) => `
---

# ${p.title}

<!-- ${p.url} -->

${p.markdown.trim()}
`)
  return head + body.join('')
}
