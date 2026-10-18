// The launcher skill/aspira-groomer/scripts/groomer.sh, driven with a fake `node` (it records every
// agent-script call and answers the ticket steps; `node -p`/`node -e` one-liners run on the real node)
// and a fake `screen` that runs the detached run in the foreground. NOTION_TOKEN is emptied, so no
// path through the launcher can reach the real Notion API.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const launcher = join(root, 'skill/aspira-groomer/scripts/groomer.sh')
const BOARD = 'https://app.notion.com/p/3e93e59b225881bba552f8e336ad08ad'

async function sandbox(prefix: string) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  const repo = join(dir, 'repo')
  const bin = join(dir, 'bin')
  await mkdir(repo)
  await mkdir(bin)
  await exec('git', ['init', repo])
  await writeFile(join(repo, 'aspira.json'), JSON.stringify({ board: BOARD }))
  const folder = join(repo, '.work', 'kit-9-cart-limit')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'idea.md'), 'Let shoppers see why the cart stops at ten items.\n')
  await writeFile(
    join(bin, 'node'),
    [
      '#!/bin/bash',
      'case " $* " in *" -p "*|*" -e "*) exec "$REAL_NODE" "$@" ;; esac',
      // With REAL_RECORD set, `ticket.ts record` (the F7 old-word mapping of a run record) runs for real, unrecorded.
      'if [ -n "$REAL_RECORD" ]; then case "$*" in *"scripts/ticket.ts record "*) exec "$REAL_NODE" "$@" ;; esac; fi',
      '{ printf \'%s\\n\' "$@"; echo ---; } >> "$CAPTURE"',
      'case "$*" in',
      '  *"scripts/ticket.ts start"*)',
      '    if [ -n "$START_EXIT" ]; then printf \'%s\\n\' "$START_ERROR" >&2; exit "$START_EXIT"; fi',
      '    printf \'folder=%s\\nid=KIT-9\\ntitle=Cart limit\\nurl=https://www.notion.so/kit-9\\nbefore=Idea\\nstatus=Grooming\\ninput=%s\\n\' "$TICKET_FOLDER" "$TICKET_FOLDER/idea.md" ;;',
      '  *"scripts/ticket.ts finish"*) echo "run-status=$FINISH_STATUS" ;;',
      '  *) echo "{}" ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const screens = join(dir, 'screens')
  await writeFile(join(bin, 'screen'), '#!/bin/bash\necho "$@" >> "$SCREENS"\nexec "$3"\n', { mode: 0o755 })
  const capture = join(dir, 'arguments')
  await writeFile(capture, '')
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, REAL_NODE: process.execPath, CAPTURE: capture, SCREENS: screens, GROOMER_AGENT_DIR: '', ASPIRA_KIT: '', AI_GATEWAY_API_KEY: 'test', NOTION_TOKEN: '', NOTION_API_KEY: '', TICKET_FOLDER: folder, START_EXIT: '', START_ERROR: '', FINISH_STATUS: '', REAL_RECORD: '' }
  const calls = async (): Promise<string[][]> => (await readFile(capture, 'utf8')).split('---\n').filter((call) => call.trim() !== '').map((call) => call.split('\n').filter(Boolean))
  return { dir, repo, folder, env, calls, screens }
}

/** A finished run directory as `start` leaves it, whose output may hold a groom record. */
async function finishedRun(dir: string, groom: Record<string, unknown> | null) {
  const run = await realpath(await mkdtemp(join(dir, 'run-')))
  const output = join(dir, 'output')
  await mkdir(join(output, 'trace'), { recursive: true })
  if (groom !== null) await writeFile(join(output, 'trace', 'groom.json'), JSON.stringify(groom))
  await writeFile(join(run, 'started'), `${Math.floor(Date.now() / 1000)}\n`)
  await writeFile(join(run, 'exit'), '0\n')
  await writeFile(join(run, 'output'), `${output}\n`)
  await writeFile(join(run, 'log'), 'run done\n')
  await writeFile(join(run, 'agent'), `agent: @aspiralabs/groomer@0.0.0 (package, ${root})\n`)
  return { run, output }
}

const lines = (text: string) => text.split('\n')
const failure = (pending: Promise<unknown>) => pending.then(() => ({ code: 0, output: '' }), (error: { code?: number; stdout?: string; stderr?: string }) => ({ code: error.code ?? -1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }))

describe('status and wait', () => {
  it('print the run status, the Grooming Decisions page, the open questions and the two local files from the groom record', async () => {
    const { dir, env } = await sandbox('groomer-status-')
    const { run, output } = await finishedRun(dir, { status: 'needs-author', open: 3, page: { url: 'https://notion.so/gd' } })
    const { stdout } = await exec('bash', [launcher, 'status', run], { env })
    const shown = ['Status: needs-author', 'Grooming Decisions: https://notion.so/gd', 'Open questions: 3', `Decisions: ${output}/trace/decisions.md`, `Run analysis: ${output}/run-analysis.md`]
    expect(shown.filter((line) => !lines(stdout).includes(line))).toEqual([])
  })

  it('say the record is not written yet, without page lines, while the groom record is missing', async () => {
    const { dir, env } = await sandbox('groomer-status-missing-')
    const { run } = await finishedRun(dir, null)
    const { stdout } = await exec('bash', [launcher, 'status', run], { env })
    expect({
      status: lines(stdout).includes('Status: not yet written (run in progress or stopped before its first round)'),
      pageLines: lines(stdout).filter((line) => line.startsWith('Grooming Decisions:') || line.startsWith('Open questions:')),
    }).toEqual({ status: true, pageLines: [] })
  })

  it('say the page is not created yet when the record has no page URL', async () => {
    const { dir, env } = await sandbox('groomer-status-nourl-')
    const { run } = await finishedRun(dir, { status: 'needs-author', open: 3, page: {} })
    const { stdout } = await exec('bash', [launcher, 'status', run], { env })
    expect(lines(stdout)).toContain('Grooming Decisions: not created yet')
  })

  it('wait takes 1 to 60 seconds, and watch is the same command', async () => {
    const { dir, env } = await sandbox('groomer-wait-')
    const { run } = await finishedRun(dir, { status: 'needs-author', open: 3, page: { url: 'https://notion.so/gd' } })
    const zero = await failure(exec('bash', [launcher, 'wait', run, '--max', '0'], { env }))
    const sixtyOne = await failure(exec('bash', [launcher, 'wait', run, '--max', '61'], { env }))
    const waited = await exec('bash', [launcher, 'wait', run, '--max', '5'], { env })
    const watched = await exec('bash', [launcher, 'watch', run, '--max', '5'], { env })
    expect({ zero: zero.code !== 0, sixtyOne: sixtyOne.code !== 0, waited: lines(waited.stdout).includes('Status: needs-author'), watched: lines(watched.stdout).includes('Status: needs-author') }).toEqual({ zero: true, sixtyOne: true, waited: true, watched: true })
  })
})

describe('start', () => {
  it('exits 3 with the refusal and launches nothing when the gate refuses', async () => {
    const { repo, env, screens } = await sandbox('groomer-start-refused-')
    const refused = await failure(exec('bash', [launcher, 'start', 'KIT-9'], { cwd: repo, env: { ...env, START_EXIT: '3', START_ERROR: 'groomer: refused: KIT-9 Cart limit is a Bug card; groomer grooms Feature cards only.' } }))
    expect({ code: refused.code, refusal: refused.output.includes('is a Bug card'), launched: existsSync(screens) }).toEqual({ code: 3, refusal: true, launched: false })
  })

  it('passes --force-run to the ticket step', async () => {
    const { repo, env, calls } = await sandbox('groomer-start-force-')
    await exec('bash', [launcher, 'start', 'KIT-9', '--force-run'], { cwd: repo, env: { ...env, FINISH_STATUS: 'needs-author' } })
    const start = (await calls()).find((call) => call.some((arg) => arg.endsWith('scripts/ticket.ts')) && call.includes('start')) ?? []
    expect(start.slice(start.indexOf('start'))).toEqual(expect.arrayContaining(['start', 'KIT-9', '--force-run']))
  })

  it('names the board and BOARD-010 when the ticket step cannot read the board', async () => {
    const { repo, env } = await sandbox('groomer-start-board-')
    const refused = await failure(exec('bash', [launcher, 'start', 'KIT-9'], { cwd: repo, env: { ...env, START_EXIT: '2', START_ERROR: 'Notion 404 (object_not_found): Could not find database with ID: d9e768e6.' } }))
    expect(lines(refused.output)).toContain(`Board: ${BOARD}; check BOARD-010 (the aspira-agents connection on the product teamspace)`)
  })

  it('finishes with only the run status the record maps to (old words included, F7), no --ok/--failed, and keeps the finish step\'s run status word', async () => {
    const outcomes: { recorded: string; flag: string | undefined; runStatus: string | undefined; kept: string }[] = []
    // The finish step is the one writer of the final word: a reported `ready` may come back as `needs-author`.
    // A record an older groomer wrote (`confirmed`, `stopped`) reads as the new word before finish sees it.
    for (const [recorded, finished] of [['confirmed', 'needs-author'], ['stopped', 'needs-author'], ['ready', 'ready'], ['incomplete', 'incomplete']] as const) {
      const { repo, folder, env, calls } = await sandbox(`groomer-finish-${recorded}-`)
      await mkdir(join(folder, 'groom', 'trace'), { recursive: true })
      await writeFile(join(folder, 'groom', 'trace', 'groom.json'), JSON.stringify({ status: recorded, open: 0, page: { url: 'https://notion.so/gd' } }))
      const { stdout } = await exec('bash', [launcher, 'start', 'KIT-9'], { cwd: repo, env: { ...env, FINISH_STATUS: finished, REAL_RECORD: '1' } })
      const run = /^run: (.+)$/m.exec(stdout)?.[1] ?? ''
      const finish = (await calls()).find((call) => call.some((arg) => arg.endsWith('scripts/ticket.ts')) && call.includes('finish')) ?? []
      outcomes.push({
        recorded,
        flag: finish.find((arg) => arg === '--ok' || arg === '--failed'),
        runStatus: finish[finish.indexOf('--run-status') + 1],
        kept: (await readFile(join(run, 'status'), 'utf8').catch(() => '')).trim(),
      })
    }
    expect(outcomes).toEqual([
      { recorded: 'confirmed', flag: undefined, runStatus: 'ready', kept: 'needs-author' },
      { recorded: 'stopped', flag: undefined, runStatus: 'needs-author', kept: 'needs-author' },
      { recorded: 'ready', flag: undefined, runStatus: 'ready', kept: 'ready' },
      { recorded: 'incomplete', flag: undefined, runStatus: 'incomplete', kept: 'incomplete' },
    ])
  })
})
