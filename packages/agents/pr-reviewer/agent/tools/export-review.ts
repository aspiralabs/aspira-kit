import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { REVIEW_DIR, REVIEW_SUBDIR, ignoreRule, needsIgnoreRule, optionalPath, patchStats, ticketFolder } from '../lib/pr'
import { sortFindingsMarkdown } from '../lib/findings'
import { FILES, roundFilesInOrder, slugify } from '../lib/review'
import { TARGET_FILE, stampReviewed, targetFileSchema } from '../lib/target'
import { USAGE_LEDGER, parseLedger, renderCostMarkdown, summarizeUsage } from '../lib/usage'

// Which model each agent runs on, for the cost table. Keep in step with the agent.ts files.
const MODELS: Record<string, string> = {
  'pr-reviewer': 'anthropic/claude-sonnet-5',
  ava: 'anthropic/claude-opus-5.5',
  cole: 'anthropic/claude-opus-5.5',
  nova: 'anthropic/claude-opus-5.5',
  reba: 'anthropic/claude-opus-5.5',
  dex: 'anthropic/claude-opus-5.5',
  iris: 'anthropic/claude-opus-5.5',
  quinn: 'openai/gpt-6-luna',
}

// Sandboxes are per session and disposable. This copies the review's markdown out to
// the host so the person keeps it: the fix list, the summary, the transcript, what was
// reviewed, and what it cost. Runs in the app runtime, not the sandbox, hence node:fs.

export default defineTool({
  availableInSubagents: false,
  description:
    'Copy the review markdown (findings.md, review.md, conversation.md, pr.patch, changed_files.txt) from the sandbox to the host, plus cost.md with the model spend. Stamps the base and head shas into findings.md and review.md. For a local review it lands in <repoDir>/.work/<ticket>/pr-review/ (the ticket folder is the branch without its type prefix) and adds .work/ to that repo\'s .gitignore. Call after pr-debator finishes, or after it stopped at the budget.',
  inputSchema: z.object({
    rounds: z.number().int().min(1).describe('The `rounds` pr-debator returned. Decides how much transcript to assemble.'),
    label: z.string().optional().describe('The `label` pr-debator returned. Names the transcript.'),
    repoDir: z
      .string()
      .nullable()
      .optional()
      .describe('The `repoDir` load-pr returned, for a local review. Files then land in <repoDir>/.work/<ticket>/pr-review/.'),
    branch: z.string().nullable().optional().describe('The `branch` load-pr returned. Its name without the type prefix is the ticket folder inside .work/.'),
    outputDir: z.string().optional().describe('Host directory, absolute or relative to the agent project. Overrides the default.'),
    settled: z.boolean().optional().describe('The `settled` pr-debator returned: the loop ended by the stopping rule, not at the cap.'),
    maxCostUsd: z.number().nullable().optional().describe('The `budget.maxCostUsd` pr-debator returned, for cost.md. Null or absent when there was no budget.'),
    stoppedByBudget: z.boolean().optional().describe('true when pr-debator returned a `stopped` object: the budget ended the run and the export is incomplete.'),
  }),
  async execute({ rounds, label, repoDir: rawRepoDir, branch: rawBranch, outputDir, settled, maxCostUsd, stoppedByBudget }, ctx) {
    // load-pr returns null for these on a GitHub PR, and a model passes that back as "null".
    const repoDir = optionalPath(rawRepoDir)
    const branch = optionalPath(rawBranch)
    const slug = slugify(branch ?? label ?? 'review')
    const dir = resolve(process.cwd(), outputDir ?? defaultDir(slug, ticketFolder(branch ?? label ?? 'review'), repoDir))
    await mkdir(dir, { recursive: true })
    // The review lives in the repo it reviewed, and git never sees it. Done before
    // anything is written, so the files are ignored the moment they exist — otherwise
    // the next review of this branch would find the last one sitting in its own diff.
    const ignored = repoDir === undefined || outputDir !== undefined ? null : await ensureIgnored(repoDir)

    const sandbox = await ctx.getSandbox()
    // What was reviewed, as load-pr recorded it: the shas for the stamp, the packet size for cost.md.
    const targetJson = await Promise.resolve(sandbox.readTextFile({ path: TARGET_FILE })).catch(() => null)
    const loaded = targetJson === null ? null : (targetFileSchema.safeParse(JSON.parse(targetJson)).data ?? null)
    const target = loaded?.target ?? null

    const written: string[] = []
    const missing: string[] = []
    // Handed back so the orchestrator can print the documents without a second read.
    // `written` holds host paths, and read_file only sees the sandbox, so a model that
    // reaches for one of them gets "File not found" and burns a call retrying.
    let findings: string | null = null
    let review: string | null = null
    let changedLines: number | undefined

    const exported = [FILES.meta, FILES.patch, FILES.changed, FILES.findings, FILES.review, ...(target?.since === null || target?.since === undefined ? [] : [FILES.previousFindings])]
    for (const path of exported) {
      const raw = await sandbox.readTextFile({ path })
      if (raw === null) {
        missing.push(path)
        continue
      }
      // The two documents carry the shas the verdict applies to, whether or not the writers put them in,
      // and the fix list is in severity order with its totals equal to its entries, whatever Nova wrote.
      // Written back to the sandbox too, so comment-on-pr posts the stamped, sorted text.
      const stamp = target !== null && (path === FILES.findings || path === FILES.review)
      const content = stamp ? stampReviewed(path === FILES.findings ? sortFindingsMarkdown(raw) : raw, target) : raw
      if (stamp && content !== raw) await sandbox.writeTextFile({ path, content })
      if (path === FILES.findings) findings = content
      if (path === FILES.review) review = content
      if (path === FILES.patch) {
        const stats = patchStats(content, 0)
        changedLines = stats.additions + stats.deletions
      }
      await writeFile(resolve(dir, basename(path)), content, 'utf8')
      written.push(resolve(dir, basename(path)))
    }

    // The transcript is assembled here rather than in the sandbox: six seats write six
    // files a round, and concatenating them is the one place that ordering is decided.
    const sections: string[] = [`# Review: ${label ?? slug}`]
    for (const path of roundFilesInOrder(rounds)) {
      const content = await sandbox.readTextFile({ path })
      if (content !== null && content.trim() !== '') sections.push(content.trim())
    }
    const conversation = resolve(dir, basename(FILES.conversation))
    await writeFile(conversation, `${sections.join('\n\n')}\n`, 'utf8')
    written.push(conversation)

    // Cost: every model call in this session (root, six seats, verifier) landed in the
    // shared ledger via hooks/usage.ts. Aggregate, write, then clear it so a second
    // review in the same session starts from zero.
    const ledger = await sandbox.readTextFile({ path: USAGE_LEDGER })
    const summary = summarizeUsage(parseLedger(ledger ?? ''))
    const costPath = resolve(dir, 'cost.md')
    const packet = loaded?.packet ?? null
    await writeFile(
      costPath,
      renderCostMarkdown(label ?? slug, summary, MODELS, {
        rounds,
        ...(changedLines === undefined ? {} : { changedLines }),
        packet: packet === null ? null : { chars: packet.chars, tokens: packet.tokens },
        budget: maxCostUsd === null || maxCostUsd === undefined ? null : { maxCostUsd, stopped: stoppedByBudget === true },
        ...(settled === undefined ? {} : { settled }),
      }),
      'utf8',
    )
    written.push(costPath)
    if (ledger !== null) {
      await writeFile(resolve(dir, 'usage.jsonl'), ledger, 'utf8')
      await sandbox.removePath({ path: USAGE_LEDGER, force: true })
    }

    return { dir, written, missing, findings, review, target, gitignore: ignored, cost: summary, incomplete: stoppedByBudget === true || findings === null || review === null }
  },
})

// In the repo that was reviewed, inside the ticket's working folder, when we know
// where it is. Otherwise — a GitHub PR, a pasted diff — a dated folder in the
// package, because there is no checkout on this machine to put it in.
function defaultDir(slug: string, ticket: string, repoDir: string | undefined): string {
  if (repoDir !== undefined) return resolve(resolve(process.cwd(), repoDir), REVIEW_DIR, ticket, REVIEW_SUBDIR)
  const date = new Date().toISOString().slice(0, 10)
  return `reviews/${date}-${slug}`
}

/**
 * Append `.work/` to the reviewed repo's .gitignore, once. Idempotent, and it
 * never rewrites what is there — worst case it adds two lines to a file the person
 * owns. A repo we cannot write to is not worth failing an otherwise finished review,
 * so a failure is reported rather than thrown.
 */
async function ensureIgnored(repoDir: string): Promise<{ path: string; added: boolean; error?: string }> {
  const path = resolve(resolve(process.cwd(), repoDir), '.gitignore')
  try {
    const existing = await readFile(path, 'utf8').catch(() => '')
    if (!needsIgnoreRule(existing)) return { path, added: false }
    await writeFile(path, existing + ignoreRule(existing), 'utf8')
    return { path, added: true }
  } catch (error) {
    return { path, added: false, error: error instanceof Error ? error.message : String(error) }
  }
}
