import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { jsonSchema, tool, type ToolSet } from 'ai'
import { z } from 'zod'

export const connectionSchema = z.array(z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  url: z.string().url().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  tokenEnv: z.string().optional(),
  envVars: z.array(z.string()).optional(),
  tools: z.array(z.string().min(1)).min(1),
}))

/** Explicit allow-lists only. No discovered write tool is automatically exposed. */
export async function connectReadTools(raw: string | undefined, signal: AbortSignal) {
  const config = connectionSchema.parse(JSON.parse(raw || '[]'))
  const clients: Client[] = []
  const tools: ToolSet = {}
  const reads: { tool: string; ok: boolean }[] = []
  try {
    const connections = await Promise.allSettled(config.map(async (connection) => {
      const client = new Client({ name: 'aspira-agents', version: '0.2.1' })
      clients.push(client)
      const token = connection.tokenEnv ? process.env[connection.tokenEnv] : undefined
      if (connection.tokenEnv && !token) throw new Error(`Missing MCP token variable: ${connection.tokenEnv}`)
      if (Boolean(connection.url) === Boolean(connection.command)) throw new Error('Configure exactly one MCP url or command')
      const env = Object.fromEntries((connection.envVars ?? []).map((name) => {
        const value = process.env[name]
        if (!value) throw new Error(`Missing MCP environment variable: ${name}`)
        return [name, value]
      }))
      const transport = connection.url
        ? new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} } })
        : new StdioClientTransport({ command: connection.command!, args: connection.args ?? [], env, stderr: 'pipe' })
      await client.connect(transport, { signal, timeout: false })
      const discovered = []
      let cursor: string | undefined
      do {
        const page = await client.listTools({ cursor }, { signal, timeout: false })
        discovered.push(...page.tools)
        cursor = page.nextCursor
      } while (cursor)
      for (const name of connection.tools) {
        const descriptor = discovered.find((t) => t.name === name)
        if (!descriptor) throw new Error(`MCP tool absent: ${connection.name}/${name}`)
        if (descriptor.annotations?.destructiveHint === true || descriptor.annotations?.readOnlyHint === false) throw new Error(`MCP tool is not read-only: ${connection.name}/${name}`)
        const key = `${connection.name}__${name}`
        if (tools[key]) throw new Error(`Duplicate MCP tool: ${key}`)
        tools[key] = tool({
          description: descriptor.description ?? name,
          inputSchema: jsonSchema<Record<string, unknown>>(descriptor.inputSchema),
          execute: async (args, options) => {
            const result = await client.callTool({ name, arguments: args }, undefined, { signal: options.abortSignal, timeout: false })
            const text = JSON.stringify(result)
            reads.push({ tool: key, ok: !result.isError && text.length <= 40_000 })
            if (text.length > 40_000) return { truncated: true, text: text.slice(0, 40_000), instruction: 'Narrow this query; do not count truncated evidence as complete.' }
            return result
          },
        })
      }
    }))
    const failed = connections.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
    return { tools, reads, sources: config.map(({ name, url, command, tools }) => ({ name, url, command, tools })), close: async () => { await Promise.allSettled(clients.map((client) => client.close())) } }
  } catch (error) {
    await Promise.allSettled(clients.map((client) => client.close()))
    throw error
  }
}
