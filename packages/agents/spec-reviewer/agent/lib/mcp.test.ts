import { expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'Button' }] })),
  close: vi.fn(async () => {}),
  listTools: vi.fn(async () => ({ tools: [
    { name: 'read_page', description: 'Read', inputSchema: { type: 'object' } },
    { name: 'delete_page', description: 'Delete', inputSchema: { type: 'object' } },
  ] })),
}))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: class {
  connect = vi.fn(async () => {})
  listTools = mocks.listTools
  callTool = mocks.callTool
  close = mocks.close
} }))
import { connectReadTools } from './mcp.ts'

it('exposes only allowed MCP tools, forwards cancellation and closes the connection', async () => {
  const controller = new AbortController()
  const connection = await connectReadTools(JSON.stringify([{ name: 'knowledge', url: 'https://example.com/mcp', tools: ['read_page'] }]), controller.signal)
  expect(Object.keys(connection.tools)).toEqual(['knowledge__read_page'])
  await connection.tools.knowledge__read_page!.execute!({}, { toolCallId: 'test', messages: [], context: {}, abortSignal: controller.signal })
  expect(mocks.callTool.mock.calls[0]).toEqual([{ name: 'read_page', arguments: {} }, undefined, { signal: controller.signal, timeout: false }])
  await connection.close()
  expect(mocks.close).toHaveBeenCalled()
})
