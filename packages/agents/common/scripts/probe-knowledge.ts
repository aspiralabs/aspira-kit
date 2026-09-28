// Walks the guidelines tree from the terminal and prints what load-knowledge would
// write, without a sandbox or a model. Reads NOTION_TOKEN and KNOWLEDGE_PAGE from
// the environment (a --env-file flag on node points it at an agent's .env.local).
//
//   node --env-file=../spec-reviewer/.env.local scripts/probe-knowledge.ts
//
// Prints one line per page (depth, file it would become, title, truncated flag)
// and the first lines of INDEX.md, so a page that is not shared with the
// integration, or a tree that is deeper than the walk, shows up before a paid run.

import {
  INDEX_FILE,
  KNOWLEDGE_ENV,
  MAX_DEPTH,
  MAX_PAGES,
  NOTION_API,
  NOTION_VERSION,
  childPagesOf,
  fileFor,
  pageIdFrom,
  rewriteLinks,
} from '../src/lib/knowledge.ts'

const token = process.env[KNOWLEDGE_ENV.token]?.trim()
const start = process.env[KNOWLEDGE_ENV.page]?.trim()
if (!token || !start) {
  console.error(`Set ${KNOWLEDGE_ENV.token} and ${KNOWLEDGE_ENV.page} (for example: node --env-file=../spec-reviewer/.env.local scripts/probe-knowledge.ts)`)
  process.exit(2)
}
const rootId = pageIdFrom(start)
if (rootId === undefined) {
  console.error(`Not a Notion page URL or id: ${start}`)
  process.exit(2)
}

const headers = { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION }
async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${NOTION_API}${path}`, { headers })
  if (!res.ok) throw new Error(`Notion ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json()) as T
}

type Row = { id: string; title: string; url: string; depth: number }
const queue: Row[] = [{ id: rootId, title: '(index)', url: start, depth: 0 }]
const seen = new Set<string>([rootId])
const files = new Map<string, string>([[rootId, INDEX_FILE]])
const titles = new Map<string, string>()
const used = new Set<string>([INDEX_FILE])
async function titleOf(id: string): Promise<string> {
  const page = await get<{ properties?: Record<string, { type?: string; title?: { plain_text?: string }[] }> }>(`/pages/${id}`)
  const prop = Object.values(page.properties ?? {}).find((p) => p.type === 'title')
  return (prop?.title ?? []).map((t) => t.plain_text ?? '').join('').trim() || id
}
let indexMarkdown = ''
let count = 0

while (queue.length > 0 && count < MAX_PAGES) {
  const next = queue.shift()
  if (next === undefined) break
  let body: { markdown?: string; truncated?: boolean }
  try {
    body = await get<{ markdown?: string; truncated?: boolean }>(`/pages/${next.id}/markdown`)
  } catch (error) {
    console.log(`${'  '.repeat(next.depth)}skipped ${next.title}: ${error instanceof Error ? error.message.slice(0, 140) : String(error)}`)
    continue
  }
  const md = body.markdown ?? ''
  count += 1
  console.log(`${'  '.repeat(next.depth)}${files.get(next.id)}  ${next.title}  (${md.length} chars${body.truncated ? ', TRUNCATED' : ''})`)
  if (next.depth === 0) indexMarkdown = md
  if (next.depth >= MAX_DEPTH) continue
  for (const child of childPagesOf(md)) {
    if (seen.has(child.id)) continue
    seen.add(child.id)
    let title = child.title
    if (title === '') {
      try {
        title = await titleOf(child.id)
      } catch (error) {
        console.log(`${'  '.repeat(next.depth + 1)}skipped ${child.url}: ${error instanceof Error ? error.message.split('\n')[0]?.slice(0, 140) : String(error)}`)
        continue
      }
    }
    files.set(child.id, fileFor(title, used))
    titles.set(child.id, title)
    queue.push({ ...child, title, depth: next.depth + 1 })
  }
}
if (queue.length > 0) console.log(`\n${queue.length} page(s) not visited (depth ${MAX_DEPTH} / ${MAX_PAGES} pages cap): ${queue.map((q) => q.title).join(', ')}`)
console.log(`\n${count} page(s). INDEX.md would begin:\n`)
console.log(rewriteLinks(indexMarkdown, files, titles).split('\n').slice(0, 30).join('\n'))
