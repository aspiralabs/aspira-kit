import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { connectReadTools } from '@aspiralabs/agent-common/lib/mcp'
import { repository } from '@aspiralabs/agent-common/lib/repository'
import { requireBound } from '../lib/bound.ts'

// The groomer's only window on the repository (spec Round zero): `repository()`'s list_files,
// read_files and search over `git ls-files` filtered by allowedPath (no .env*, secrets, keys, .git,
// node_modules), and the read-only MCP tools MCP_READ_CONNECTIONS allow-lists. No shell, no other file,
// and no other repository: repoPath must be the one the launcher bound the run to (lib/bound.ts).

type Snapshot = Awaited<ReturnType<typeof repository>>
const snapshots = new Map<string, Promise<Snapshot>>()

/** One snapshot per repository per process: the tools read the same files for a whole run. */
function snapshot(repoPath: string): Promise<Snapshot> {
  let found = snapshots.get(repoPath)
  if (found === undefined) {
    found = repository(repoPath)
    found.catch(() => snapshots.delete(repoPath))
    snapshots.set(repoPath, found)
  }
  return found
}

const call = { toolCallId: 'read-repository', messages: [], context: {} }

export default defineTool({
  description:
    'Read the local repository: list paths matching a substring, read up to 8 files with line numbers, or run literal case-insensitive searches that return file:line evidence. Secrets, keys, .env files, .git and node_modules are never readable. kind "mcp" calls one read-only MCP tool from the MCP_READ_CONNECTIONS allow-list.',
  inputSchema: z.object({
    repoPath: z.string().min(1).describe('Absolute path of the local repository.'),
    request: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('list'), contains: z.string() }),
      z.object({ kind: z.literal('read'), files: z.array(z.object({ path: z.string(), start: z.number().int().min(1), lines: z.number().int().min(1).max(200) })).max(8) }),
      z.object({ kind: z.literal('search'), queries: z.array(z.string().min(1)).max(16), pathContains: z.string() }),
      z.object({ kind: z.literal('mcp'), tool: z.string().min(1), input: z.record(z.string(), z.unknown()) }),
    ]),
  }),
  async execute({ repoPath, request }, ctx) {
    requireBound('repository', repoPath)
    if (request.kind === 'mcp') {
      const mcp = await connectReadTools(process.env.MCP_READ_CONNECTIONS, ctx.abortSignal)
      try {
        const tool = mcp.tools[request.tool]
        if (tool?.execute === undefined) throw new Error(`${request.tool} is not an allow-listed read-only MCP tool`)
        return await tool.execute(request.input, { ...call, abortSignal: ctx.abortSignal })
      } finally {
        await mcp.close()
      }
    }
    const repo = await snapshot(requireBound('repository', repoPath))
    if (request.kind === 'list') return repo.tools.list_files.execute!({ contains: request.contains }, call)
    if (request.kind === 'read') return repo.tools.read_files.execute!({ files: request.files }, call)
    return repo.tools.search.execute!({ queries: request.queries, pathContains: request.pathContains }, call)
  },
})
