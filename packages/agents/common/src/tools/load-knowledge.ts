import type { SandboxSession } from 'eve/sandbox'
import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { writeHandoff } from '../lib/handoff'
import {
  INDEX_FILE,
  KNOWLEDGE_ENV,
  KNOWLEDGE_PATH,
  MAX_DEPTH,
  MAX_PAGES,
  NOTION_API,
  REQUIRED_ENV,
  REQUIRED_FILE,
  parseRequired,
  renderRequired,
  resolveRequired,
  type LoadedPage,
  NOTION_VERSION,
  childPagesOf,
  fileFor,
  pageIdFrom,
  renderPage,
  rewriteLinks,
  type ChildPage,
} from '../lib/knowledge'

// Puts the org's engineering guidelines in the sandbox as markdown so an agent
// reads them like any other file: INDEX.md is the Notion page named in
// KNOWLEDGE_PAGE, one file per page below it. Runs in the app runtime (network
// and env), writes into the shared sandbox. Notion's markdown endpoint renders
// child pages as <page url="…">title</page>, which is how the walk finds them.

type PageMarkdown = { markdown: string; truncated: boolean }

export default defineTool({
  availableInSubagents: false,
  description:
    'Load the engineering guidelines from Notion into the sandbox at /workspace/knowledge as markdown (INDEX.md first, one file per page), and write REQUIRED.md: the pages every agent must ingest in full (KNOWLEDGE_REQUIRED, default "Agent Instructions, Review Verification"). Throws when a required page is not in the tree. Call once before any review or debate. Returns configured: false when NOTION_TOKEN or KNOWLEDGE_PAGE is unset.',
  inputSchema: z.object({
    page: z.string().optional().describe('Notion page URL or id to start from. Defaults to the KNOWLEDGE_PAGE env var.'),
    required: z
      .array(z.string())
      .optional()
      .describe('Titles (or URLs/ids) of the pages every agent must read in full. Defaults to the KNOWLEDGE_REQUIRED env var, then to "Agent Instructions" and "Review Verification".'),
  }),
  async execute({ page, required }, ctx) {
    const token = process.env[KNOWLEDGE_ENV.token]?.trim()
    const start = page?.trim() || process.env[KNOWLEDGE_ENV.page]?.trim()
    if (!token || !start) {
      const missing = [!token && KNOWLEDGE_ENV.token, !start && KNOWLEDGE_ENV.page].filter(Boolean).join(' and ')
      return { configured: false as const, reason: `${missing} not set` }
    }
    const rootId = pageIdFrom(start)
    if (rootId === undefined) throw new Error(`Not a Notion page URL or id: ${start}`)

    const sandbox = await ctx.getSandbox()
    await sandbox.run({ command: `rm -rf ${KNOWLEDGE_PATH} && mkdir -p ${KNOWLEDGE_PATH}` })

    const fetchedAt = new Date().toISOString()
    const notion = client(token)

    // Breadth-first from the index page, depth and count capped. Each page's file
    // is decided before its links are rewritten, so links resolve regardless of order.
    const queue: { id: string; title: string; url: string; depth: number }[] = [
      { id: rootId, title: await notion.title(rootId), url: start, depth: 0 },
    ]
    const seen = new Set<string>([rootId])
    const files = new Map<string, string>([[rootId, INDEX_FILE]])
    const titles = new Map<string, string>([[rootId, queue[0]?.title ?? 'Engineering']])
    const used = new Set<string>([INDEX_FILE])
    const bodies = new Map<string, { markdown: string; truncated: boolean; title: string; url: string }>()
    const skipped: string[] = []

    while (queue.length > 0 && bodies.size < MAX_PAGES) {
      const next = queue.shift()
      if (next === undefined) break
      let body: PageMarkdown
      try {
        body = await notion.markdown(next.id)
      } catch (error) {
        skipped.push(`${next.title}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      bodies.set(next.id, { ...body, title: next.title, url: next.url })
      if (next.depth >= MAX_DEPTH) continue
      for (const child of childPagesOf(body.markdown)) {
        if (seen.has(child.id)) continue
        seen.add(child.id)
        // Mentions carry no title; the page object does. One extra call per mention.
        let title = child.title
        if (title === '') {
          try {
            title = await notion.title(child.id)
          } catch (error) {
            skipped.push(`${child.url}: ${error instanceof Error ? error.message : String(error)}`)
            continue
          }
        }
        files.set(child.id, fileFor(title, used))
        titles.set(child.id, title)
        queue.push({ ...child, title, depth: next.depth + 1 })
      }
    }
    const unvisited: ChildPage[] = queue.map(({ id, title, url }) => ({ id, title, url }))

    const written: string[] = []
    const truncated: string[] = []
    const loaded: LoadedPage[] = []
    for (const [id, body] of bodies) {
      const path = files.get(id)
      if (path === undefined) continue
      const markdown = rewriteLinks(body.markdown, files, titles)
      loaded.push({ id, title: body.title, url: body.url, markdown, notionMarkdown: body.markdown })
      await write(sandbox, path, renderPage({ title: body.title, url: body.url, fetchedAt, truncated: body.truncated }, markdown))
      written.push(path)
      if (body.truncated) truncated.push(path)
    }

    // Required reading is not optional: a page the org marks as required that the
    // walk did not reach is an error, not a note, or the agents run without the
    // rules they are supposed to be bound by.
    const wanted = required ?? parseRequired(process.env[REQUIRED_ENV])
    const resolved = resolveRequired(wanted, loaded)
    if (resolved.missing.length > 0) {
      throw new Error(
        `Required knowledge page${resolved.missing.length === 1 ? '' : 's'} not loaded: ${resolved.missing.join(', ')}. Loaded: ${loaded.map((p) => p.title).join(', ')}. Fix the title in ${REQUIRED_ENV}, or link the page from the index within ${MAX_DEPTH} levels and ${MAX_PAGES} pages.`,
      )
    }
    let requiredFile: string | null = null
    let requiredHostFile: string | null = null
    if (resolved.found.length > 0) {
      requiredFile = REQUIRED_FILE
      const markdown = renderRequired(resolved.found, fetchedAt)
      await write(sandbox, REQUIRED_FILE, markdown)
      // The same pages on the host, for a workflow that cannot read the sandbox. A path,
      // not the text: the orchestrator would otherwise retype 2.5k tokens into a tool call.
      // Its links stay Notion links: a host reader follows them with the Notion read tool,
      // where a /workspace/knowledge path would point into a sandbox it cannot open.
      requiredHostFile = await writeHandoff('required', renderRequired(resolved.found.map((page) => ({ ...page, markdown: page.notionMarkdown ?? page.markdown })), fetchedAt))
    }

    return {
      configured: true as const,
      path: KNOWLEDGE_PATH,
      index: INDEX_FILE,
      required: resolved.found.map((p) => p.title),
      requiredFile,
      // Host path of the same text; pass it to review-spec as guidelinesPath.
      requiredHostFile,
      pages: written.length,
      files: written,
      ...(truncated.length > 0 ? { truncated } : {}),
      ...(skipped.length > 0 ? { skipped } : {}),
      ...(unvisited.length > 0 ? { notLoaded: unvisited.map((p) => `${p.title} (${p.url})`) } : {}),
    }
  },
})

async function write(sandbox: SandboxSession, path: string, content: string): Promise<void> {
  await sandbox.writeTextFile({ path, content })
}

function client(token: string) {
  const headers = { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION }
  async function get<T>(path: string, attempt = 0): Promise<T> {
    const res = await fetch(`${NOTION_API}${path}`, { headers })
    if (res.status === 429 && attempt < 2) {
      const wait = Number(res.headers.get('retry-after') ?? '1') * 1000
      await new Promise((r) => setTimeout(r, Math.min(wait, 10_000)))
      return get<T>(path, attempt + 1)
    }
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300)
      const hint = res.status === 404 || res.status === 403 ? ' (is the page shared with the integration?)' : ''
      throw new Error(`Notion ${res.status} on ${path}${hint}: ${detail}`)
    }
    return (await res.json()) as T
  }
  return {
    async markdown(id: string): Promise<PageMarkdown> {
      const body = await get<{ markdown?: string; truncated?: boolean }>(`/pages/${id}/markdown`)
      return { markdown: body.markdown ?? '', truncated: body.truncated === true }
    },
    // The markdown endpoint returns content only; the title lives on the page object.
    async title(id: string): Promise<string> {
      const pageObject = await get<{ properties?: Record<string, { type?: string; title?: { plain_text?: string }[] }> }>(`/pages/${id}`)
      const prop = Object.values(pageObject.properties ?? {}).find((p) => p.type === 'title')
      const text = (prop?.title ?? []).map((t) => t.plain_text ?? '').join('').trim()
      return text || 'Engineering'
    },
  }
}
