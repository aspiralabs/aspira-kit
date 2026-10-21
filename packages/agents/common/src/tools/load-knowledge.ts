import type { SandboxSession } from 'eve/sandbox'
import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { writeHandoff } from '../lib/handoff.ts'
import { renderProvenance, type ProvenancePage } from '../lib/knowledge-snapshot.ts'
import { walkKnowledge } from '../lib/knowledge-walk.ts'
import { INDEX_FILE, KNOWLEDGE_ENV, KNOWLEDGE_PATH, REQUIRED_ENV, REQUIRED_FILE, pageIdFrom, parseRequired, renderPage, renderRequired, type LoadedPage } from '../lib/knowledge.ts'

// Puts the org's engineering guidelines in the sandbox as markdown so an agent
// reads them like any other file: INDEX.md is the Notion page named in
// KNOWLEDGE_PAGE, one file per page below it. Runs in the app runtime (network
// and env), writes into the shared sandbox. The walk itself (packages/agents/common/src/lib/
// knowledge-walk.ts) is shared with the load-knowledge command, probe-knowledge and
// code-analyzer's host copy, so the three can never again write different file names for the
// same tree. A page that fails to load, or is truncated, now fails the whole call.

export default defineTool({
  availableInSubagents: false,
  description:
    'Load the engineering guidelines from Notion into the sandbox at /workspace/knowledge as markdown (INDEX.md first, one file per page), and write REQUIRED.md: the pages every agent must ingest in full (KNOWLEDGE_REQUIRED, default "Agent Instructions, Review Verification"). Throws when a required page is not in the tree, or when any page fails to load or is truncated. Call once before any review or debate. Returns configured: false when NOTION_TOKEN or KNOWLEDGE_PAGE is unset.',
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
    if (pageIdFrom(start) === undefined) throw new Error(`Not a Notion page URL or id: ${start}`)

    const sandbox = await ctx.getSandbox()
    await sandbox.run({ command: `rm -rf ${KNOWLEDGE_PATH} && mkdir -p ${KNOWLEDGE_PATH}` })

    const wanted = required ?? parseRequired(process.env[REQUIRED_ENV])
    const walk = await walkKnowledge({ token, page: start, required: wanted })

    const pagesWritten: string[] = []
    for (const p of walk.pages) {
      const path = `${KNOWLEDGE_PATH}/${p.file}`
      await write(sandbox, path, renderPage({ title: p.title, url: p.url, fetchedAt: walk.fetchedAt, truncated: false }, p.markdown))
      pagesWritten.push(path)
    }

    let requiredFile: string | null = null
    let requiredHostFile: string | null = null
    if (walk.required.length > 0) {
      const provenancePages: ProvenancePage[] = walk.pages.map((p) => ({
        id: p.id,
        url: p.url,
        title: p.title,
        file: p.file,
        rawMarkdown: p.notionMarkdown,
        section: `# ${p.title}\n\n<!-- ${p.url} -->\n\n${p.markdown.trim()}\n`,
      }))
      const header = renderProvenance({ fetchedAt: walk.fetchedAt, rootUrl: walk.rootUrl, rootId: walk.rootId, path: REQUIRED_FILE, pages: provenancePages })
      requiredFile = REQUIRED_FILE
      const required: LoadedPage[] = walk.required.map((p) => ({ id: p.id, title: p.title, url: p.url, markdown: p.markdown }))
      await write(sandbox, REQUIRED_FILE, renderRequired(required, walk.fetchedAt, header))
      // The same pages on the host, for a workflow that cannot read the sandbox. A path,
      // not the text: the orchestrator would otherwise retype 2.5k tokens into a tool call.
      // Its links stay Notion links: a host reader follows them with the Notion read tool,
      // where a /workspace/knowledge path would point into a sandbox it cannot open.
      const requiredForHost: LoadedPage[] = walk.required.map((p) => ({ id: p.id, title: p.title, url: p.url, markdown: p.notionMarkdown }))
      requiredHostFile = await writeHandoff('required', renderRequired(requiredForHost, walk.fetchedAt, header))
    }

    return {
      configured: true as const,
      path: KNOWLEDGE_PATH,
      index: INDEX_FILE,
      required: walk.required.map((p) => p.title),
      requiredFile,
      // Host path of the same text; pass it to review-spec as guidelinesPath.
      requiredHostFile,
      pages: pagesWritten.length,
      files: requiredFile === null ? pagesWritten : [...pagesWritten, requiredFile],
      ...(walk.notLoaded.length > 0 ? { notLoaded: walk.notLoaded.map((p) => `${p.title} (${p.url})`) } : {}),
    }
  },
})

async function write(sandbox: SandboxSession, path: string, content: string): Promise<void> {
  await sandbox.writeTextFile({ path, content })
}
