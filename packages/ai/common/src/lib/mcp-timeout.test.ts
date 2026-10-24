import { expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

async function connected() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '1' })
  const server = new Server({ name: 'test-server', version: '1' }, { capabilities: { tools: {} } })
  let finish: () => void = () => {}
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await new Promise<void>((resolve) => { finish = resolve })
    return { tools: [] }
  })
  await server.connect(serverTransport)
  await client.connect(clientTransport, { timeout: false })
  return { client, finish: () => finish(), close: async () => { await client.close(); await server.close() } }
}

it('lets untimed MCP requests finish after the former request deadline', async () => {
  const connection = await connected()
  vi.useFakeTimers()
  try {
    let settled = false
    const pending = connection.client.listTools({}, { timeout: false }).finally(() => { settled = true })
    await vi.advanceTimersByTimeAsync(600_000)
    expect(settled).toBe(false)
    connection.finish()
    expect(await pending).toEqual({ tools: [] })
  } finally { vi.useRealTimers(); await connection.close() }
})

it('still cancels untimed MCP requests explicitly', async () => {
  const connection = await connected()
  try {
    const controller = new AbortController()
    const pending = connection.client.listTools({}, { signal: controller.signal, timeout: false })
    const rejected = expect(pending).rejects.toThrow('User cancelled')
    controller.abort(new Error('User cancelled'))
    await rejected
  } finally { connection.finish(); await connection.close() }
})

it('preserves the SDK default timeout for other consumers', async () => {
  const connection = await connected()
  vi.useFakeTimers()
  try {
    const rejected = expect(connection.client.listTools()).rejects.toThrow('Request timed out')
    await vi.advanceTimersByTimeAsync(60_000)
    await rejected
  } finally { connection.finish(); vi.useRealTimers(); await connection.close() }
})
