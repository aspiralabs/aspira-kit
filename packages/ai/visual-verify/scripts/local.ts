// The standalone /aspira-visual-verify run, as `visual-verify.sh` runs it (KIT-58 F17). Report-only:
// it never writes the Build Summary or a PR body, never calls Notion and never moves a card.
//   local.ts local <ID> --status <Status> [--cloud] [--repo DIR]   what the session must check, or why it cannot
//   local.ts report <ID> [--repo DIR]                              report.md from the session's answer.json
// The Status is the card's, read by the session with the Notion MCP and passed in; only
// In Progress: Implementation and In Review: Implementation are accepted (exit 3 otherwise).

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { touchesUi } from '@aspiralabs/ai/common/lib/plan'
import { credentialNames, devServerSchema, localDevUrl, planChangesSchema, visualVerifyAnswerSchema, visualVerifyReport, withoutCredentials, type SkipReason, type VisualVerifyResult } from '@aspiralabs/ai/common/lib/visual-verify'

const ACCEPTED = ['In Progress: Implementation', 'In Review: Implementation'] as const
const REFUSED_EXIT = 3

const configSchema = z.looseObject({ app: z.string().optional(), dev: devServerSchema.optional() })

const say = (text: string) => process.stdout.write(`${text}\n`)
const fail = (text: string) => process.stderr.write(`visual-verify: ${text}\n`)

/** The ticket's working folder: the first `.work/<id>-*` directory, else `.work/<id>`. */
async function folderOf(repo: string, id: string): Promise<string | null> {
  const work = join(repo, '.work')
  if (!existsSync(work)) return null
  const lower = id.toLowerCase()
  const entries = (await readdir(work, { withFileTypes: true })).filter((entry) => entry.isDirectory() && (entry.name === lower || entry.name.startsWith(`${lower}-`))).sort((a, b) => a.name.localeCompare(b.name))
  const first = entries[0]
  return first === undefined ? null : join(work, first.name)
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown
  } catch {
    return null
  }
}

const skippedResult = (skipReason: SkipReason): VisualVerifyResult => ({ status: 'skipped', verifications: 0, skipReason, findings: [], notExercised: [], backendNotDeployed: [], noData: [] })

/** Run the launcher's subcommand; the exit code is the return value. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { repo: { type: 'string' }, status: { type: 'string' }, cloud: { type: 'boolean', default: false } },
  })
  const [command, rawId] = positionals
  if ((command !== 'local' && command !== 'report') || rawId === undefined || !/^[A-Za-z]+-\d+$/.test(rawId)) {
    fail('usage: local.ts local <ID> --status <Status> [--cloud] [--repo DIR] | report <ID> [--repo DIR]; <ID> is the Feature Board ticket ID, for example KIT-11.')
    return 2
  }
  const repo = values.repo ?? process.cwd()
  const folder = await folderOf(repo, rawId)
  if (folder === null) {
    fail(`there is no working folder .work/${rawId.toLowerCase()}-* in ${repo}; run the ticket's steps first`)
    return 1
  }
  const config = configSchema.safeParse(await readJson(join(repo, 'aspira.json')))
  const out = join(folder, 'visual-verify')
  const options = { app: config.success ? config.data.app : undefined }
  if (command === 'report') return report(repo, out, options)

  const status = values.status
  if (status === undefined) {
    fail('local needs --status "<the card\'s Status>", read with notion-fetch')
    return 2
  }
  if (!(ACCEPTED as readonly string[]).includes(status)) {
    fail(`${rawId.toUpperCase()} is in ${status}; visual verify runs on ${ACCEPTED.join(' or ')}`)
    return REFUSED_EXIT
  }
  const plan = planChangesSchema.safeParse(await readJson(join(folder, 'plan.review/trace/plan.json')))
  const dev = config.success ? config.data.dev : undefined
  const reason: SkipReason | null = !plan.success || !touchesUi(plan.data) ? 'plan without UI' : values.cloud ? '--cloud' : dev === undefined ? 'no aspira.json dev entry' : null
  if (reason !== null || dev === undefined) {
    const result = skippedResult(reason ?? 'no aspira.json dev entry')
    const text = await visualVerifyReport(result, [], repo, options)
    await mkdir(out, { recursive: true })
    await writeFile(join(out, 'report.md'), text)
    say(text)
    return 0
  }
  const local = localDevUrl(dev.url)
  if (!local.ok) {
    fail(local.reason)
    return 1
  }
  const unset = credentialNames(process.env)
  say(
    JSON.stringify(
      {
        devServer: { cwd: join(repo, dev.cwd), command: dev.command, run: withoutCredentials(dev.command, unset), unset, url: dev.url, backendDeployed: dev.backendDeployed },
        screenshotsDir: out,
        spec: join(folder, 'spec.reviewed/spec.reviewed.md'),
        plan: join(folder, 'plan.review/trace/plan.json'),
        output: join(out, 'answer.json'),
        instructions: 'Follow the check in the skill exactly, in this session, against devServer: start it with "run", never with credentials, or reuse a server already answering at "url". Write the answer JSON to "output", then run visual-verify.sh report <ID>.',
      },
      null,
      2,
    ),
  )
  return 0
}

/** report: answer.json to report.md, printed. */
async function report(repo: string, out: string, options: { app: string | undefined }): Promise<number> {
  const raw = await readJson(join(out, 'answer.json'))
  const parsed = visualVerifyAnswerSchema.safeParse(raw)
  if (!parsed.success) {
    fail(`${join(out, 'answer.json')} is not a visual-verify answer: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'answer'}: ${issue.message}`).join('; ')}`)
    return 1
  }
  const answer = parsed.data
  const blocked = answer.findings.some((finding) => finding.grade === 'blocker')
  const result: VisualVerifyResult = {
    status: answer.status === 'skipped' ? 'skipped' : blocked ? 'blocked' : 'passed',
    verifications: 1,
    ...(answer.skipReason === undefined ? {} : { skipReason: answer.skipReason }),
    viewport: answer.viewport,
    findings: answer.findings,
    notExercised: answer.notExercised,
    backendNotDeployed: answer.backendNotDeployed,
    noData: answer.noData,
  }
  const text = await visualVerifyReport(result, answer.screenshots, repo, options)
  await writeFile(join(out, 'report.md'), text)
  say(text)
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main()
  } catch (error) {
    process.stderr.write(`visual-verify: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
