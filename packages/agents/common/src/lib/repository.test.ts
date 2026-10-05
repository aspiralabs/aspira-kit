import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { repository } from './repository'

const exec = promisify(execFile)

async function commit(root: string) {
  await exec('git', ['init', '-q', root])
  await exec('git', ['-C', root, 'add', '.'])
  await exec('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'])
}

async function write(root: string, path: string, text: string) {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), text)
}

it('reads the installed kit configuration, and nothing else under node_modules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'repository-'))
  await write(root, '.gitignore', 'node_modules/\n')
  await write(root, 'src/index.ts', 'export const a = 1\n')
  await write(root, 'node_modules/@aspiralabs/config/agent/constraints.md', '# Constraints\nNo enums.\n')
  await write(root, 'node_modules/@aspiralabs/config/tsconfig/library.json', '{"compilerOptions":{"strict":true}}\n')
  await write(root, 'node_modules/@aspiralabs/config/node_modules/dep/index.js', 'nested\n')
  await write(root, 'node_modules/left-pad/index.js', 'other\n')
  await commit(root)
  const repo = await repository(root)
  expect([...repo.files.keys()].sort()).toEqual(['.gitignore', 'node_modules/@aspiralabs/config/agent/constraints.md', 'node_modules/@aspiralabs/config/tsconfig/library.json', 'src/index.ts'])
  expect(repo.tracked.has('node_modules/@aspiralabs/config/agent/constraints.md')).toBe(false)
  expect(repo.instructions).toContain('SOURCE node_modules/@aspiralabs/config/agent/constraints.md\n# Constraints')
  const [read] = await repo.tools.read_files.execute!({ files: [{ path: 'node_modules/@aspiralabs/config/tsconfig/library.json', start: 1, lines: 5 }] }, { toolCallId: 't', messages: [], context: {} }) as { text: string }[]
  expect(read!.text).toContain('"strict":true')
})

it('works when the kit is not installed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'repository-'))
  await write(root, 'src/index.ts', 'export const a = 1\n')
  await commit(root)
  expect([...(await repository(root)).files.keys()]).toEqual(['src/index.ts'])
})
