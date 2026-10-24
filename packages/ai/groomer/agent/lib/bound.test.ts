// The eve tools are bound to the repository and working folder the launcher started the run on
// (GROOMER_REPO, GROOMER_FOLDER). A path the model passes, steered by text on the card or the page,
// must never reach another checkout or folder (review finding AVA1.1).
import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import groom from '../tools/groom.ts'
import readRepository from '../tools/read-repository.ts'
import writeRound from '../tools/write-round.ts'
import { boundRun, requireBound } from './bound.ts'

type Executable = { execute: (input: unknown, ctx: unknown) => Promise<unknown> }
const ctx = { abortSignal: new AbortController().signal }
let repo: string
let folder: string
let other: string

beforeEach(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'groomer-bound-')))
  repo = join(base, 'repo')
  folder = join(repo, '.work', 'kit-1-x')
  other = join(base, 'other')
  await mkdir(join(folder, 'groom'), { recursive: true })
  await mkdir(join(other, '.work', 'kit-1-x', 'groom'), { recursive: true })
  vi.stubEnv('GROOMER_REPO', repo)
  vi.stubEnv('GROOMER_FOLDER', folder)
  vi.stubEnv('NOTION_TOKEN', '')
})
afterEach(() => vi.unstubAllEnvs())

describe('boundRun', () => {
  it('derives the output folder from the bound working folder', () => {
    expect(boundRun()).toEqual({ repoPath: repo, folder, output: join(folder, 'groom') })
  })

  it('refuses when the launcher did not bind the run', () => {
    vi.stubEnv('GROOMER_REPO', '')
    expect(() => boundRun()).toThrow(/GROOMER_REPO and GROOMER_FOLDER are not set/)
  })

  it('accepts the bound path in any spelling that resolves to it, and nothing else', () => {
    expect(requireBound('repository', `${repo}/./`)).toBe(repo)
    expect(() => requireBound('repository', other)).toThrow(/bound to the repository/)
    expect(() => requireBound('output', join(other, '.work', 'kit-1-x', 'groom'))).toThrow(/bound to the output/)
  })
})

describe('the tools refuse an unbound path before touching it', () => {
  it('read-repository refuses another checkout, for files and for MCP alike', async () => {
    const tool = readRepository as unknown as Executable
    await expect(tool.execute({ repoPath: other, request: { kind: 'list', contains: '' } }, ctx)).rejects.toThrow(/bound to the repository/)
    await expect(tool.execute({ repoPath: other, request: { kind: 'mcp', tool: 'x', input: {} } }, ctx)).rejects.toThrow(/bound to the repository/)
  })

  it('write-round refuses a groom folder outside the bound working folder', async () => {
    const tool = writeRound as unknown as Executable
    const round = { kind: 'summary', markdown: 'x' }
    await expect(tool.execute({ output: join(other, '.work', 'kit-1-x', 'groom'), write: round }, ctx)).rejects.toThrow(/bound to the output/)
  })

  it('groom refuses another folder or repository', async () => {
    const tool = groom as unknown as Executable
    await expect(tool.execute({ folder: join(other, '.work', 'kit-1-x'), repoPath: repo, guidelinesPath: '/g' }, ctx)).rejects.toThrow(/bound to the folder/)
    await expect(tool.execute({ folder, repoPath: other, guidelinesPath: '/g' }, ctx)).rejects.toThrow(/bound to the repository/)
  })
})
