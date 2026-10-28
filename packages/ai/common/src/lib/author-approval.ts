// The author's approval of a step's output (KIT-83): `/aspira-build-feature <ID> --approve <step>
// --reason "<why>"`, typed by the human, accepts the output that step left (a spec or plan whose review
// ended incomplete or needs-author) as if the step had ended ready. Only the build-feature driver
// writes the record, from its own invocation, like the run-start approval: no session writes one
// (KIT-20). Each record names who (the git user), when, why, the output file and its sha256, so it
// holds only while that file is unchanged. The planner reads it to plan from an approved spec (KIT-84).

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'

/** The steps an author can approve, and the output file of each, relative to the ticket folder. */
export const APPROVABLE_OUTPUTS = {
  'spec-writer': 'spec.reviewed/spec.reviewed.md',
  planner: 'plan.review/plan.reviewed.md',
} as const
export type ApprovableStep = keyof typeof APPROVABLE_OUTPUTS
export const isApprovableStep = (value: string): value is ApprovableStep => Object.hasOwn(APPROVABLE_OUTPUTS, value)

const text = z.string().min(1)
const authorApprovalSchema = z.object({ step: z.enum(['spec-writer', 'planner']), name: text, at: text, reason: text, runId: text, output: text, sha256: text })
export type AuthorApproval = z.infer<typeof authorApprovalSchema>

/** `<folder>/.local/author-approvals.json`, outside the run state's own directory, so it goes wherever the ticket folder goes. */
export const authorApprovalsFile = (folder: string): string => join(folder, '.local', 'author-approvals.json')

export const sha256Of = (content: string): string => createHash('sha256').update(content).digest('hex')

/** Every recorded approval, oldest first; none when there is no file. Throws naming the file when it is invalid. */
export async function readAuthorApprovals(folder: string): Promise<AuthorApproval[]> {
  const file = authorApprovalsFile(folder)
  const raw = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (raw === null) return []
  const parsed = z.array(authorApprovalSchema).safeParse(JSON.parse(raw))
  if (!parsed.success) throw new Error(`${file} is not a list of author approvals: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`)
  return parsed.data
}

/** Append one approval, through a temp file. */
export async function recordAuthorApproval(folder: string, approval: AuthorApproval): Promise<void> {
  const file = authorApprovalsFile(folder)
  const all = [...(await readAuthorApprovals(folder)), authorApprovalSchema.parse(approval)]
  await mkdir(dirname(file), { recursive: true })
  await writeFile(`${file}.tmp`, `${JSON.stringify(all, null, 2)}\n`)
  await rename(`${file}.tmp`, file)
}

/** The latest approval of `step` whose hash matches `content` (the step's output as it is now), or null. */
export async function approvalOf(folder: string, step: ApprovableStep, content: string | null): Promise<AuthorApproval | null> {
  if (content === null) return null
  const sha256 = sha256Of(content)
  return (await readAuthorApprovals(folder).catch(() => [])).findLast((approval) => approval.step === step && approval.sha256 === sha256) ?? null
}

/** The approval of `step` that covers its output file in the folder as it is now, or null. */
export async function currentApproval(folder: string, step: ApprovableStep): Promise<AuthorApproval | null> {
  return approvalOf(folder, step, await readFile(join(folder, APPROVABLE_OUTPUTS[step]), 'utf8').catch(() => null))
}
