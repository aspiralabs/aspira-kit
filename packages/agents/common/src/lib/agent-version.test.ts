import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { AGENT_VERSION_FILE, agentVersion, recordAgentVersion } from './agent-version.ts'

async function pkg(root: string, name: string, version: string) {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name, version }))
  return root
}

it('reads the package that is running and says whether it is installed or kit source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-version-'))
  const source = await pkg(join(dir, 'kit', 'packages', 'agents', 'planner'), '@aspiralabs/planner', '0.4.2')
  const installed = await pkg(join(dir, 'app', 'node_modules', '@aspiralabs', 'planner'), '@aspiralabs/planner', '0.5.0')
  expect(await agentVersion(source)).toEqual({ name: '@aspiralabs/planner', version: '0.4.2', path: source, installed: false })
  expect(await agentVersion(pathToFileURL(`${installed}/`))).toMatchObject({ version: '0.5.0', installed: true })
})

it('records the version in the export trace, or at the export root without one, and skips a missing export', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-version-'))
  const agent = { name: '@aspiralabs/planner', version: '0.4.2', path: '/kit/packages/agents/planner', installed: false }
  await mkdir(join(dir, 'with-trace', 'trace'), { recursive: true })
  expect(await recordAgentVersion(join(dir, 'with-trace'), agent)).toBe(join(dir, 'with-trace', 'trace', AGENT_VERSION_FILE))
  expect(JSON.parse(await readFile(join(dir, 'with-trace', 'trace', AGENT_VERSION_FILE), 'utf8'))).toMatchObject(agent)
  await mkdir(join(dir, 'flat'))
  expect(await recordAgentVersion(join(dir, 'flat'), agent)).toBe(join(dir, 'flat', AGENT_VERSION_FILE))
  expect(await recordAgentVersion(join(dir, 'missing'), agent)).toBeNull()
})
