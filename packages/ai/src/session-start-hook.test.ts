// T28 (F6, F8, F10): the real hooks/session-start.sh run with sh, its stdout parsed as one JSON object.
// The version-check cache is <HOME>/.cache/aspiralabs/version-check.json shaped
// { checkedAt: <ms>, latest: '<x.y.z>', notified: {} }; no network is needed (fresh cache, or no token).
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const HOOK = fileURLToPath(new URL('../hooks/session-start.sh', import.meta.url))
const PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url))

const dirs: string[] = []
const temp = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `ai-hook-${name}-`))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function homeWithCache(latest: string | null): string {
  const home = temp('home')
  if (latest !== null) {
    mkdirSync(join(home, '.cache', 'aspiralabs'), { recursive: true })
    writeFileSync(join(home, '.cache', 'aspiralabs', 'version-check.json'), JSON.stringify({ checkedAt: Date.now(), latest, notified: {} }))
  }
  return home
}

type Output = { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string }; systemMessage?: string }

function runHook(script: string, home: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home }
  for (const key of ['NOTION_TOKEN', 'NOTION_API_KEY']) delete env[key]
  const result = spawnSync('sh', [script], { env, encoding: 'utf8', timeout: 30_000 })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

function expectRulesPointer(output: Output): void {
  expect(output.hookSpecificOutput?.hookEventName).toBe('SessionStart')
  const context = output.hookSpecificOutput?.additionalContext ?? ''
  expect(context).toContain('https://app.notion.com/p/3e73e59b2258813d9eece6ed89171bd3')
  expect(context).toContain('https://app.notion.com/p/3e83e59b225881f7ac5aeab5d353beea')
  expect(context).toContain('aspiralabs-ui MCP server')
  expect(context).toContain("this repository's AGENTS.md")
  expect(context).toContain('Gotchas')
}

describe('SessionStart JSON', () => {
  it('T28: prints exactly one JSON object with the rules pointer and, with a newer cache, the notice as systemMessage', () => {
    const newer = runHook(HOOK, homeWithCache('99.0.0'))
    expect(newer.code).toBe(0)
    const output = JSON.parse(newer.stdout) as Output
    expectRulesPointer(output)
    const version = (JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { version: string }).version
    expect(output.systemMessage).toContain('99.0.0')
    expect(output.systemMessage).toContain(version)
    expect(output.systemMessage).toContain('pnpm add -g @aspiralabs/ai@latest')
    expect(output.systemMessage).toContain('pnpm add -D @aspiralabs/ai@latest')
    expect(output.systemMessage).toContain('kit init')

    const plain = runHook(HOOK, homeWithCache(null))
    expect(plain.code).toBe(0)
    const plainOutput = JSON.parse(plain.stdout) as Output
    expectRulesPointer(plainOutput)
    expect(plainOutput.systemMessage).toBeUndefined()
    expect(plainOutput.hookSpecificOutput?.additionalContext).toBe(output.hookSpecificOutput?.additionalContext)
  })

  it('T28: with no dist/ beside it the hook still prints the one JSON object and nothing on stderr', () => {
    const dir = temp('copy')
    mkdirSync(join(dir, 'hooks'))
    copyFileSync(HOOK, join(dir, 'hooks', 'session-start.sh'))
    const result = runHook(join(dir, 'hooks', 'session-start.sh'), homeWithCache('99.0.0'))
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    const output = JSON.parse(result.stdout) as Output
    expectRulesPointer(output)
    expect(output.systemMessage).toBeUndefined()
  })
})
