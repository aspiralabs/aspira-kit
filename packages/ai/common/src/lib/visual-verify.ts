// The visual-verify contract shared by build-feature's stage and the standalone visual-verify
// package (KIT-58): the aspira.json `dev` entry, the localhost-only url check, the stage answer
// the Chrome step returns, the result a caller records, and the one renderer that turns a result
// into PR-body lines and the local report.md. agent-common cannot import either consumer.
// Grades are their own scale and never map to severity.ts SEVERITIES (A5).

import { z } from 'zod'
import { redact } from './redact.ts'

/** The part of a plan.json that decides whether a build touches UI: each task's changed paths. Read leniently, so a plan whose other fields do not validate still decides. */
export const planChangesSchema = z.object({ tasks: z.array(z.object({ changes: z.array(z.object({ path: z.string() })) })) })

/** The aspira.json `dev` entry. Named DevServer, never `dev` alone, to stay apart from Card.dev. */
export const devServerSchema = z.object({
  cwd: z.string().default('.'),
  command: z.string().trim().min(1),
  url: z.string(),
  /** Variables the kit sets to the resolved url in a worktree's env file (KIT-67). */
  urlEnvVars: z.array(z.string()).optional(),
  /** True when the app's backend is deployed, so a route the dev server cannot reach is not "backend not deployed" (A4). */
  backendDeployed: z.boolean().default(false),
})
export type DevServer = z.infer<typeof devServerSchema>

/** Ok only for an http: or https: url whose hostname is localhost, 127.0.0.1 or [::1]; otherwise a reason naming the url. */
export function localDevUrl(url: string): { ok: true } | { ok: false; reason: string } {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(host) || (host.endsWith('.localhost') && host.length > '.localhost'.length && !host.startsWith('.'))
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && loopback) return { ok: true }
  } catch {
    // falls through to the reason
  }
  return { ok: false, reason: `The dev url ${url} is not an http(s) url on localhost, 127.0.0.1 or [::1]; visual verify only opens a local server.` }
}

/** `url` with {name} and {port} replaced by the worktree's name and port; a url without braces is returned unchanged. */
export function resolveDevUrl(url: string, worktree: { name: string; port: number }): string {
  return url.replaceAll('{name}', worktree.name).replaceAll('{port}', String(worktree.port))
}

/** How bad a visual finding is, its own scale; never counted by severity.ts. */
export const GRADES = ['blocker', 'major', 'minor'] as const
export type Grade = (typeof GRADES)[number]

/** The closed list of reasons a run reports as skipped (F12). */
export const SKIP_REASONS = [
  'no Chrome tool',
  '--cloud',
  'no aspira.json dev entry',
  'plan without UI',
  '--autonomous with sign-in needed',
  'dev server did not start or answer',
  'not signed in',
  'a server from another checkout is answering at the url',
  'dev.url needs a kit worktree; run kit worktree',
] as const
export type SkipReason = (typeof SKIP_REASONS)[number]

const text = z.string()
const finding = z.object({ grade: z.enum(GRADES), title: text, page: text, files: z.array(text).default([]), deployedBackend: z.boolean().default(false) })
const notExercised = z.object({ page: text, action: text, reason: text })
const backendNotDeployed = z.object({ route: text })
const noData = z.object({ page: text })

/** The stage answer of the Chrome step: what it looked at, found and left alone. */
export const visualVerifyAnswerSchema = z.object({
  nonce: text,
  status: z.enum(['ran', 'skipped']),
  skipReason: z.enum(SKIP_REASONS).optional(),
  skipDetail: text.optional(),
  viewport: text,
  findings: z.array(finding).default([]),
  notExercised: z.array(notExercised).default([]),
  backendNotDeployed: z.array(backendNotDeployed).default([]),
  noData: z.array(noData).default([]),
  screenshots: z.array(text).default([]),
}).refine((answer) => answer.status !== 'skipped' || answer.skipReason !== undefined, { message: 'skipReason is required when status is skipped', path: ['skipReason'] })
export type VisualVerifyAnswer = z.infer<typeof visualVerifyAnswerSchema>

/** What a caller records and renders: no screenshots, which stay local. */
export const visualVerifyResultSchema = z.object({
  status: z.enum(['passed', 'skipped', 'blocked', 'halted']),
  verifications: z.number().int().min(0),
  skipReason: z.enum(SKIP_REASONS).optional(),
  skipDetail: text.optional(),
  viewport: text.optional(),
  findings: z.array(finding).default([]),
  notExercised: z.array(notExercised).default([]),
  backendNotDeployed: z.array(backendNotDeployed).default([]),
  noData: z.array(noData).default([]),
})
export type VisualVerifyResult = z.input<typeof visualVerifyResultSchema>

/** Markdown lines for a result: findings blocker, major, minor, then the notices apart (never counted as findings). Every untrusted fragment is redacted on its own. */
export async function visualVerifyLines(result: VisualVerifyResult, repo: string, options: { app?: string }): Promise<string[]> {
  const clean = (value: string) => redact(value, repo, options)
  const lines: string[] = []
  const findings = result.findings ?? []
  for (const grade of GRADES) {
    for (const item of findings.filter((entry) => entry.grade === grade)) lines.push(`- (${grade}) ${await clean(item.title)}, ${await clean(item.page)}`)
  }
  const notices: string[] = []
  if (result.status === 'skipped') {
    const detail = result.skipDetail ? ` (${await clean(result.skipDetail)})` : ''
    notices.push(`- skipped: ${result.skipReason ?? 'no reason recorded'}${detail}`)
  }
  for (const item of result.notExercised ?? []) notices.push(`- not exercised: ${await clean(item.action)} on ${await clean(item.page)}, ${await clean(item.reason)}`)
  const routes = result.backendNotDeployed ?? []
  if (routes.length > 0) {
    notices.push('- backend not deployed (unverified):')
    for (const item of routes) notices.push(`  - ${await clean(item.route)}`)
  }
  const empty = result.noData ?? []
  if (empty.length > 0) {
    notices.push('- no data to check:')
    for (const item of empty) notices.push(`  - ${await clean(item.page)}`)
  }
  if (findings.length === 0 && result.status !== 'skipped') lines.push('- no findings')
  if (notices.length > 0) lines.push(...(lines.length > 0 ? [''] : []), 'Not findings:', ...notices)
  return lines
}

/** The full report.md text: title, viewport, the lines, then the local screenshot paths. */
export async function visualVerifyReport(result: VisualVerifyResult, screenshots: readonly string[], repo: string, options: { app?: string }): Promise<string> {
  const lines = ['# Visual verify', '', `Viewport: ${await redact(result.viewport ?? 'not recorded', repo, options)}`, '', '## Findings', '', ...(await visualVerifyLines(result, repo, options))]
  if (screenshots.length > 0) lines.push('', '## Screenshots (local only)', '', ...screenshots.map((path) => `- ${path}`))
  return `${lines.join('\n')}\n`
}

/** Credentials a project command never gets, whether or not they are set. */
export const CREDENTIALS = ['NOTION_TOKEN', 'NOTION_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'AI_GATEWAY_API_KEY', 'NPM_TOKEN', 'NODE_AUTH_TOKEN'] as const
/** A variable named like a credential. */
const CREDENTIAL_NAME = /_(TOKEN|SECRET|KEY|PASSWORD)$/i

/** The variables a project command runs without: the fixed credentials and every credential-named variable set in `env`, sorted. */
export function credentialNames(env: NodeJS.ProcessEnv): string[] {
  const named = Object.keys(env).filter((name) => CREDENTIAL_NAME.test(name))
  return [...new Set([...CREDENTIALS, ...named])].sort()
}

/** `command` as a shell line that runs it with every one of `names` removed from its environment. */
export function withoutCredentials(command: string, names: readonly string[]): string {
  const quoted = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`)
  return `${['env', ...names.flatMap((name) => ['-u', name])].map(quoted).join(' ')} ${command}`
}
