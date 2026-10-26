// Test-only support for the KIT-67 build-feature suites that run an isolated worktree through the
// driver (worktree.integration.test.ts, review-loop-merge.integration.test.ts). The driver is a child
// process at seam S1, so the isolation seams cannot be handed to it as objects. They are stood in for at
// the boundary the compiled isolation module really crosses:
//   - Neon and Cloudflare DNS: the node:http mock of packages/ai/src/isolation-mocks.test.ts, reached
//     through NEON_API_BASE_URL and CLOUDFLARE_API_BASE_URL (the same override db-migrate.test.ts uses).
//   - cloudflared and the Stripe CLI: fake executables first on the driver's PATH. Each forwards its
//     arguments (and STRIPE_API_KEY, the only variable the mock reads) to a small bridge server in this
//     process, which answers with the in-memory runners of the same mock, so every seam shares one state.
// Nothing here talks to a live service. The keys are fakes.

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BOARD, REPOSITORY } from './driver.test-helper.ts'
import { ISOLATION_CONFIG, startMocks, type Mocks } from '../../src/isolation-mocks.test.ts'

/** The aspira.json of a project that isolates its worktrees: the board and repository, plus the mock config's database, tunnel, webhooks and dev keys. */
export const ISOLATED_ASPIRA: Record<string, unknown> = { board: BOARD, repository: REPOSITORY, ...ISOLATION_CONFIG }

/** The .gitignore the kit needs before it writes the env file and the tunnel config (spec Q10). */
export const ISOLATED_IGNORE = '.worktrees/\n.env.local\n.env.development.local\n.aspira/\n'

export type World = {
  mocks: Mocks
  /** Variables for project({ env }): the fake keys and the base URLs of the mocks. */
  env: Record<string, string>
  /** When true, `stripe webhook_endpoints delete` fails like a Stripe outage. */
  failStripeDelete: boolean
  /** Write the fake cloudflared and stripe into `<dir>/bin`, the first directory of the driver's PATH. */
  install: (projectDir: string) => Promise<void>
  close: () => Promise<void>
}

const FAKE = (name: string): string =>
  [
    `#!${process.execPath}`,
    `const body = JSON.stringify({ args: process.argv.slice(2), env: { STRIPE_API_KEY: process.env.STRIPE_API_KEY } })`,
    `fetch(process.env.MOCK_RUN_URL + '/${name}', { method: 'POST', body })`,
    `  .then((response) => response.json())`,
    `  .then((result) => { process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.status ?? 1 })`,
    `  .catch((error) => { process.stderr.write(String(error)); process.exitCode = 127 })`,
    '',
  ].join('\n')

export async function isolationWorld(): Promise<World> {
  const mocks = await startMocks()
  const world = { failStripeDelete: false }
  const bridge: Server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      const { args, env } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { args: string[]; env: Record<string, string | undefined> }
      const tool = (request.url ?? '').slice(1)
      const result =
        tool === 'stripe' && world.failStripeDelete && args[0] === 'webhook_endpoints' && args[1] === 'delete'
          ? { status: 1, stdout: '', stderr: 'stripe is down' }
          : tool === 'stripe'
            ? mocks.seams.stripe(args, { env })
            : mocks.seams.cloudflared(args, { env })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(result))
    })()
  })
  await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve))
  const runUrl = `http://127.0.0.1:${String((bridge.address() as AddressInfo).port)}`
  return {
    mocks,
    env: {
      NEON_API_KEY: 'napi_test',
      NEON_API_BASE_URL: mocks.seams.neonBaseUrl,
      CLOUDFLARE_API_TOKEN: 'cf_test',
      CLOUDFLARE_API_BASE_URL: mocks.seams.cloudflareBaseUrl,
      STRIPE_SECRET_KEY: 'sk_test_x',
      MOCK_RUN_URL: runUrl,
    },
    get failStripeDelete() {
      return world.failStripeDelete
    },
    set failStripeDelete(value: boolean) {
      world.failStripeDelete = value
    },
    async install(projectDir: string) {
      const bin = join(projectDir, 'bin')
      await mkdir(bin, { recursive: true })
      for (const name of ['cloudflared', 'stripe']) {
        await writeFile(join(bin, name), FAKE(name))
        await chmod(join(bin, name), 0o755)
      }
    },
    close: async () => {
      await new Promise<void>((resolve) => bridge.close(() => resolve()))
      await mocks.close()
    },
  }
}
