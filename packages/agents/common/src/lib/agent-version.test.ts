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

it('reads the folder of @aspiralabs/ai that is running and says whether it is installed or kit source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-version-'))
  const manifest = { name: '@aspiralabs/ai', version: '0.16.0' }
  const aiSource = await pkg(join(dir, 'kit', 'packages', 'ai'), manifest.name, manifest.version)
  const aiInstalled = await pkg(join(dir, 'app', 'node_modules', '@aspiralabs', 'ai'), manifest.name, manifest.version)
  const source = join(aiSource, 'planner')
  const installed = join(aiInstalled, 'planner')
  await mkdir(source, { recursive: true })
  await mkdir(installed, { recursive: true })
  const copy = await pkg(join(dir, 'app', '.work', '.agents', 'planner@0.16.0'), 'planner', '0.16.0')
  expect(await agentVersion(source)).toEqual({ name: 'planner', version: '0.16.0', path: source, installed: false })
  expect(await agentVersion(pathToFileURL(`${source}/`))).toMatchObject({ name: 'planner', version: '0.16.0', installed: false })
  expect(await agentVersion(installed)).toEqual({ name: 'planner', version: '0.16.0', path: installed, installed: true })
  expect(await agentVersion(pathToFileURL(`${installed}/`))).toMatchObject({ name: 'planner', version: '0.16.0', installed: true })
  expect(await agentVersion(copy)).toMatchObject({ name: 'planner', version: '0.16.0' })
  expect(await agentVersion(pathToFileURL(`${copy}/`))).toMatchObject({ name: 'planner', version: '0.16.0' })
})

it('records the version in the export trace, or at the export root without one, and skips a missing export', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-version-'))
  const agent = { name: 'planner', version: '0.16.0', path: '/kit/packages/ai/planner', installed: false }
  await mkdir(join(dir, 'with-trace', 'trace'), { recursive: true })
  expect(await recordAgentVersion(join(dir, 'with-trace'), agent)).toBe(join(dir, 'with-trace', 'trace', AGENT_VERSION_FILE))
  expect(JSON.parse(await readFile(join(dir, 'with-trace', 'trace', AGENT_VERSION_FILE), 'utf8'))).toMatchObject(agent)
  await mkdir(join(dir, 'flat'))
  expect(await recordAgentVersion(join(dir, 'flat'), agent)).toBe(join(dir, 'flat', AGENT_VERSION_FILE))
  expect(await recordAgentVersion(join(dir, 'missing'), agent)).toBeNull()
})
