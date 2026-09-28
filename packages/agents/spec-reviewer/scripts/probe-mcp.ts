import { connectReadTools } from '../agent/lib/mcp.ts'
import { childPagesOf } from '@aspiralabs/agent-common/lib/knowledge'
const controller = new AbortController()
process.once('SIGINT', () => controller.abort(new Error('Cancelled')))
process.once('SIGTERM', () => controller.abort(new Error('Cancelled')))
const signal = controller.signal
const connection = await connectReadTools(process.env.MCP_READ_CONNECTIONS, signal)
try {
  console.log(JSON.stringify({ tools: Object.keys(connection.tools) }))
  for (const name of Object.keys(connection.tools).filter((name) => name.endsWith('__list_guidelines') || name.endsWith('__list_components'))) {
    const result = await connection.tools[name]!.execute!({}, { toolCallId: 'probe', messages: [], context: {}, abortSignal: signal })
    const object = result as { isError?: boolean; content?: { type: string; text?: string }[] }
    if (object.isError) throw new Error(`${name} failed`)
    console.log(`${name}: live read successful`)
    if (name.endsWith('__list_guidelines')) {
      const body = object.content?.find((item) => item.type === 'text')?.text
      const child = body ? childPagesOf((JSON.parse(body) as { markdown: string }).markdown)[0] : undefined
      if (!child) throw new Error('No linked guideline found in engineering index')
      const readName = name.replace('__list_guidelines', '__read_guideline')
      const read = await connection.tools[readName]!.execute!({ page: child.id }, { toolCallId: 'probe-child', messages: [], context: {}, abortSignal: signal })
      if ((read as { isError?: boolean }).isError) throw new Error(`${readName} failed`)
      console.log(`${readName}: linked guideline read successful`)
    }
  }
} finally { await connection.close() }
