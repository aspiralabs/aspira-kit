// KIT-39/KIT-40: after the build, the driver prints one code-analyzer step per app the implementor's
// record names and judges each by the export under that step's own --app directory, never by
// aspira.json's app, where an earlier run may have left a stale result.
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanup, project } from './driver.test-helper.ts'
import { SLOW, commandOf } from './driver.integration.shared.ts'

afterAll(cleanup)

describe('KIT-39 per-app analyzer steps', () => {
  it('runs the analyzer per changed app and reads each result under its own --app, not aspira.json’s app', async () => {
    const h = await project({ status: 'Ready: Plan', aspira: { board: 'https://app.notion.com/p/board', repository: 'aspiralabs/fixture', app: 'tools/aspira' }, files: { 'tools/aspira/package.json': '{"name":"tools"}', 'pkgs/a/package.json': '{"name":"a"}' } })
    const implementor = await h.advance({}, await h.start())
    await h.report(implementor.stage!, 'complete', { apps: ['.', 'pkgs/a'] })
    // A stale incomplete export from an earlier run under aspira.json's app.
    await mkdir(join(h.repo, 'tools/aspira/.static-analysis'), { recursive: true })
    await writeFile(join(h.repo, 'tools/aspira/.static-analysis/rounds.json'), JSON.stringify({ mode: 'local', status: 'incomplete', editedFiles: [], rounds: [] }))
    const first = await h.advance()
    await h.report(first.stage!, 'ready', { app: '.', edited: [] })
    const second = await h.advance()
    await h.report(second.stage!, 'ready', { app: 'pkgs/a', edited: [] })
    const after = await h.advance()
    await h.stop()
    expect({ first: commandOf(first), second: commandOf(second), after: after.stage?.stage, stopped: (await h.summary()).includes('tools/aspira/.static-analysis') }).toEqual({ first: '/aspira-code-analyzer KIT-11 --app . --local', second: '/aspira-code-analyzer KIT-11 --app pkgs/a --local', after: 'step10', stopped: false })
  }, SLOW)
})
