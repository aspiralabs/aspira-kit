#!/usr/bin/env node
// Smoke test for the MCP server: initialize, list tools, fetch one component.
// Runs in CI after build. Exits non-zero if any expectation fails.
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bin = join(here, '..', 'bin', 'mcp.js')
const p = spawn('node', [bin], { stdio: ['pipe', 'pipe', 'inherit'] })
let out = ''
p.stdout.on('data', (d) => (out += d))
const send = (m) => p.stdin.write(`${JSON.stringify(m)}\n`)
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } })
send({ jsonrpc: '2.0', method: 'notifications/initialized' })
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_component', arguments: { name: 'button', section: 'usage' } } })
send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_components', arguments: {} } })

setTimeout(() => {
  p.kill()
  const msgs = out.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const by = (id) => msgs.find((m) => m.id === id)?.result
  const tools = by(2)?.tools?.map((t) => t.name) ?? []
  const usage = by(3)?.content?.[0]?.text ?? ''
  const list = by(4)?.content?.[0]?.text ?? ''
  const components = (list.match(/^- /gm) ?? []).length
  const checks = [
    ['server initialized', by(1)?.serverInfo?.name === 'aspiralabs-ui'],
    ['five tools', tools.length === 5],
    ['button usage has an import', usage.includes("from '@aspiralabs/ui'")],
    ['at least 30 components listed', components >= 30],
  ]
  let failed = 0
  for (const [label, ok] of checks) {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
    if (!ok) failed += 1
  }
  console.log(`mcp smoke: ${components} components, tools: ${tools.join(', ')}`)
  process.exit(failed ? 1 : 0)
}, 4000)
