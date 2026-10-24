import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const exec = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const eve = join(root, 'node_modules/eve/bin/eve.js')

// `eve info` compiles the agent but never bundles the workflow; `eve invoke` and `eve dev` do, at
// startup, and that bundle refuses any Node.js builtin reachable from a workflow body (pr-debator
// and everything it imports outside a "use step"). `eve build` runs the same bundler, so this is
// the check that the first cloud launch did by hand: a builtin import in the workflow graph fails here.
it('bundles the workflow the way eve invoke does, with no Node.js builtin reachable from the workflow body', async () => {
  const result = await exec('node', [eve, 'build'], { cwd: root, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } }).catch((error: Error & { stdout?: string; stderr?: string }) => {
    throw new Error(`eve build failed: ${error.message}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`)
  })
  const output = `${result.stdout}\n${result.stderr}`
  expect(output).not.toContain('Workflow bundle cannot import')
  expect(output).toContain('built output at')
}, 180_000)
