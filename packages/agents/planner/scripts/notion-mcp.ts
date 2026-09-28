import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { notionReader } from '@aspiralabs/agent-common/lib/notion'

const { root, read } = notionReader(process.env.NOTION_TOKEN ?? '', process.env.KNOWLEDGE_PAGE ?? '')

const server = new McpServer({ name: 'aspira-notion-guidelines', version: '0.2.1' })
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
server.registerTool('list_guidelines', { description: 'Read the live Notion engineering index and discover links to guideline pages. Call first, then read_guideline for relevant topics.', inputSchema: {}, annotations }, async (_args, extra) => ({ content: [{ type: 'text', text: JSON.stringify(await read(root, extra.signal)) }] }))
server.registerTool('read_guideline', { description: 'Read a live Notion engineering guideline page linked from the index or an already-read guideline. Input is its Notion URL or page ID. Returns full markdown and provenance. No writes.', inputSchema: { page: z.string().min(1) }, annotations }, async ({ page }, extra) => {
  return { content: [{ type: 'text', text: JSON.stringify(await read(page, extra.signal)) }] }
})
await server.connect(new StdioServerTransport())
