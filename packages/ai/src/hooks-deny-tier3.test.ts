// T6 (F1, F8): the real hooks/deny-tier3.sh run with sh, fed the JSON a PreToolUse hook receives on stdin.
// A denial is exit 2 with "DENIED (tier 3): <what>" on stderr; an allowed command prints nothing and exits 0.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HOOK = fileURLToPath(new URL('../hooks/deny-tier3.sh', import.meta.url))

function runHook(command: string) {
  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command } })
  const result = spawnSync('sh', [HOOK], { input: payload, encoding: 'utf8', timeout: 30_000 })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('deny-tier3.sh database migrations', () => {
  it.each([
    'prisma migrate dev --name add_x',
    'prisma migrate reset',
    'prisma migrate deploy',
    'prisma migrate status',
    'prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma',
    'prisma migrate resolve --applied 20260101_init',
    'pnpm prisma migrate dev',
    'prisma db push',
  ])('T6: denies "%s" as a database migration', (command) => {
    const result = runHook(command)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('DENIED (tier 3): database migration')
  })

  it('T6: allows kit db migrate --name add_x with no output and exit 0', () => {
    const result = runHook('kit db migrate --name add_x')
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })
})
