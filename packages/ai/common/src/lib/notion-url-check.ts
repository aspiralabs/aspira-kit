// Resolves each Notion URL aspira.json names against the Notion API, for `kit doctor`'s Notion
// checks: by id, through the same object-type routes board.ts and knowledge.ts already use, never
// by requesting the URL itself (a renamed or moved page still has the same id).
import { NOTION_API, NOTION_VERSION, pageIdFrom } from './knowledge.ts'

export type UrlCheck = { key: string; url: string; kind: 'database' | 'page' | 'data_source' }

export type UrlCheckResult = { ok: true } | { ok: false; status?: number; unreachable?: boolean; reason: string }

const ROUTE: Record<UrlCheck['kind'], string> = { database: 'databases', page: 'pages', data_source: 'data_sources' }

/** The response's first line only, trimmed and length-capped: never more than Notion's own first line of explanation. */
function oneLine(text: string): string {
  return (text.split('\n')[0] ?? '').trim().slice(0, 200)
}

async function checkOne(check: UrlCheck, token: string, api: string): Promise<UrlCheckResult> {
  const id = pageIdFrom(check.url)
  if (id === undefined) return { ok: false, unreachable: true, reason: `not a Notion URL or id: ${oneLine(check.url)}` }
  const path = `${api}/${ROUTE[check.kind]}/${id}`
  let res: Response
  try {
    res = await fetch(path, { headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION } })
  } catch (error) {
    return { ok: false, unreachable: true, reason: oneLine(`network error: ${error instanceof Error ? error.message : String(error)}`) }
  }
  if (res.ok) return { ok: true }
  const body = await res.text().catch(() => '')
  const reason = oneLine(body) || res.statusText || `HTTP ${res.status}`
  if (res.status === 401 || res.status === 403 || res.status === 404) return { ok: false, status: res.status, reason }
  return { ok: false, unreachable: true, reason }
}

/**
 * Resolves every `{key, url, kind}` against Notion, by id. One result per key: `{ ok: true }` on
 * 2xx; `{ ok: false, status }` for 401/403/404 (a real failure, e.g. not shared with the
 * integration, or the wrong id); `{ ok: false, unreachable: true, reason }` for 429, a 5xx, a
 * timeout, a network error, or a URL that is not a Notion id at all. `api` defaults to Notion's
 * real API, injectable so a mock server can stand in for it in tests.
 */
export async function checkNotionUrls(checks: UrlCheck[], options: { token: string; api?: string }): Promise<Record<string, UrlCheckResult>> {
  const api = options.api ?? NOTION_API
  const out: Record<string, UrlCheckResult> = {}
  await Promise.all(
    checks.map(async (check) => {
      out[check.key] = await checkOne(check, options.token, api)
    }),
  )
  return out
}
