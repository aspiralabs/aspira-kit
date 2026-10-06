import { execFile } from 'node:child_process'
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { SandboxSession } from 'eve/sandbox'
import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { parseCostSample } from '../lib/estimate'
import { LAUNCH_FILES, packageFile } from '../lib/package-dir'
import { buildPacket } from '../lib/packet'
import { writeContext } from '../lib/shared-prefix'
import {
  LOCAL_BASE_FALLBACKS,
  LOCAL_EXCLUDES,
  REPO_PATH,
  changedFromPatch,
  TEMP_INDEX_SETUP,
  archiveArgs,
  cachedDiffArgs,
  clonePrCommand,
  parseChangedFiles,
  parsePrSource,
  patchStats,
  prApiUrl,
  prMetaFromApi,
  refDiffArgs,
  renderPrMeta,
  splitChanged,
  truncatePatch,
  type PrMeta,
} from '../lib/pr'
import { FILES, SEATS, type Reviewer } from '../lib/review'
import { TARGET_FILE, headShaFromFindings, type ReviewContextFile, type ReviewTarget } from '../lib/target'

const run = promisify(execFile)
const MAX_TARBALL = 512 * 1024 * 1024
// macOS tar adds ._* AppleDouble files unless told not to.
const TAR_ENV = { ...process.env, COPYFILE_DISABLE: '1' }

// Puts everything the six seats read into the shared sandbox: the tree at
// /workspace/repo, the diff at /workspace/pr.patch, the changed paths at
// /workspace/changed_files.txt, and the PR itself at /workspace/pr.md. The file
// layout is nitpick's, because the ported role prompts already assume it.
//
// Then it builds the review packet once — the diff, every changed file at HEAD,
// the changed paths, the PR, the required reading — and leaves it on the host for
// pr-debator, which puts it at the start of every prompt. The shas go to
// /workspace/target.json for export-review and comment-on-pr.
//
// A GitHub PR is cloned and diffed inside the sandbox; a local repo is diffed on
// the host (so uncommitted work counts) and tarred in. Runs in the app runtime,
// hence node:child_process.

/** A re-review: what the previous review's directory says. */
type Previous = { sha: string; dir: string; findings: string }

export default defineTool({
  availableInSubagents: false,
  description:
    'Load a pull request into the sandbox so the review seats can read it, and build the review packet. Either a GitHub PR (`source` = a PR URL or `owner/name#123`), or a local repository (`source` = the repo path, `branch` = the branch to review, `base` = what to compare it against, default main). Or pass `patch` with a unified diff and no repo. Pass `knowledgeRequiredFile` from load-knowledge so the packet carries the required reading. Pass `since` (the directory of a previous review) to re-review only what changed since it. Call after load-knowledge and before pr-debator, always.',
  inputSchema: z.object({
    source: z
      .string()
      .optional()
      .describe('GitHub PR URL, owner/name#123, or a local repo path, exactly as the person gave it.'),
    branch: z
      .string()
      .optional()
      .describe('Local repos only: the branch to review. Default: whatever is checked out.'),
    base: z
      .string()
      .optional()
      .describe('Local repos only: the branch, ref, or sha to compare against. Default: main, else master, else their origin/ equivalents.'),
    patch: z.string().optional().describe('A unified diff to review on its own, when there is no repo to load.'),
    since: z
      .string()
      .optional()
      .describe('Re-review: the host directory of the previous review of this change (where its findings.md is). The diff is then from the head that review was of to the head now.'),
    knowledgeRequiredFile: z
      .string()
      .optional()
      .describe('The `requiredFile` load-knowledge returned (REQUIRED.md in the sandbox). It goes into the packet so the seats need not read it.'),
  }),
  async execute({ source, branch, base, patch, since, knowledgeRequiredFile }, ctx) {
    if (source === undefined && patch === undefined) throw new Error('Pass source or patch.')
    const sandbox = await ctx.getSandbox()
    const previous = since === undefined ? null : await previousReview(since)
    // load-pr runs in the root session: its id keys the review context the seat sessions read.
    const extras: Extras = { previous, knowledgeRequiredFile: knowledgeRequiredFile ?? null, rootSessionId: ctx.session.id }

    if (source === undefined) {
      if (previous !== null) throw new Error('A pasted diff has no head to re-review from. Drop since, or load the repository.')
      return loadPatchOnly(sandbox, patch as string, extras)
    }

    const parsed = parsePrSource(source)
    if (parsed.kind === 'github') return loadGithubPr(sandbox, parsed, extras)
    return loadLocal(sandbox, parsed.path, base, branch, extras)
  },
})

type Extras = { previous: Previous | null; knowledgeRequiredFile: string | null; rootSessionId: string }

/**
 * Each reviewer's persona, from the agent's own files on the host, read when the review is
 * loaded. Through packageFile, never `import.meta.url` and `../..`: at launch this module runs
 * from eve's compiled snapshot, which carries no persona.md (see lib/package-dir.ts).
 */
async function readPersonas(): Promise<ReviewContextFile['personas']> {
  const entries = await Promise.all(([...SEATS, 'quinn'] as Reviewer[]).map(async (who) => [who, await readFile(packageFile(LAUNCH_FILES.persona(who)), 'utf8')] as const))
  return Object.fromEntries(entries) as ReviewContextFile['personas']
}

/** The cost.md files of this package's previous reviews, for the one-round estimate. */
async function readCostSamples(): Promise<ReviewContextFile['costSamples']> {
  const reviews = packageFile(LAUNCH_FILES.reviews)
  const names = (await readdir(reviews).catch(() => [])).sort()
  const samples: ReviewContextFile['costSamples'] = []
  for (const name of names) {
    const text = await readFile(join(reviews, name, 'cost.md'), 'utf8').catch(() => null)
    const sample = text === null ? null : parseCostSample(text, name)
    if (sample !== null) samples.push(sample)
  }
  return samples
}

/** The previous review a re-review starts from: its findings.md and the head it records. */
async function previousReview(dir: string): Promise<Previous> {
  const path = join(resolve(process.cwd(), dir), 'findings.md')
  const findings = await readFile(path, 'utf8').catch(() => null)
  if (findings === null) throw new Error(`since ${dir} has no findings.md to re-review from.`)
  const sha = headShaFromFindings(findings)
  if (sha === null) throw new Error(`${path} records no head sha (no "Reviewed:" or "Re-review:" line), so there is nothing to diff from. Review in full instead.`)
  return { sha, dir: resolve(process.cwd(), dir), findings }
}

async function loadGithubPr(sandbox: SandboxSession, parsed: Extract<ReturnType<typeof parsePrSource>, { kind: 'github' }>, extras: Extras) {
  const token = process.env.GITHUB_TOKEN
  const response = await fetch(prApiUrl(parsed.owner, parsed.name, parsed.number), {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'aspiralabs-pr-reviewer',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!response.ok) {
    const hint = response.status === 404 && token === undefined ? ' (private repo? set GITHUB_TOKEN)' : ''
    throw new Error(`GitHub API ${response.status} for ${parsed.label}${hint}`)
  }
  const meta = prMetaFromApi(parsed.owner, parsed.name, parsed.number, await response.json())
  if (extras.previous !== null && extras.previous.sha === meta.headSha) {
    throw new Error(`${parsed.label} is still at ${meta.headSha.slice(0, 7)}, the head the previous review was of. Nothing changed since.`)
  }

  const result = await sandbox.run({ command: clonePrCommand(parsed, meta, token, extras.previous?.sha) })
  if (result.exitCode !== 0) {
    const raw = result.stderr || result.stdout
    const detail = token === undefined ? raw : raw.replaceAll(token, '***')
    throw new Error(`Loading ${parsed.label} failed (exit ${result.exitCode}): ${detail}`)
  }

  // The clone wrote the patch and the file list in the sandbox; read them back to
  // measure, and rewrite the patch only if it has to be cut down.
  const rawPatch = (await sandbox.readTextFile({ path: FILES.patch })) ?? ''
  const changed = parseChangedFiles((await sandbox.readTextFile({ path: FILES.changed })) ?? '')
  const { patch: capped, truncated } = truncatePatch(rawPatch)
  if (truncated) await sandbox.writeTextFile({ path: FILES.patch, content: capped })

  return { ...(await finish(sandbox, meta, capped, changed, truncated, REPO_PATH, null, extras)), github: { owner: parsed.owner, name: parsed.name, number: parsed.number } }
}

async function loadLocal(sandbox: SandboxSession, path: string, base: string | undefined, branch: string | undefined, extras: Extras) {
  const dir = resolve(process.cwd(), path)
  const info = await stat(dir).catch(() => null)
  if (info === null || !info.isDirectory()) throw new Error(`Not a directory: ${dir}`)
  const git = (args: string[]) => run('git', ['-C', dir, ...args], { maxBuffer: MAX_TARBALL })

  // The git root, not the path we were handed: a review of packages/ui belongs in
  // the repo's .work, not in packages/ui/.work.
  const repoDir = await git(['rev-parse', '--show-toplevel'])
    .then((r) => r.stdout.trim())
    .catch(() => {
      throw new Error(`Not a git repository: ${dir}. A local review needs git to produce a diff.`)
    })

  // The branch under review. Named, or whatever is checked out.
  const checkedOut = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  const headRef = branch ?? checkedOut
  const headSha = await git(['rev-parse', '--verify', `${headRef}^{commit}`])
    .then((r) => r.stdout.trim())
    .catch(() => {
      throw new Error(`No such branch in ${dir}: ${headRef}.`)
    })

  const baseRef = base ?? (await firstResolvable(dir, LOCAL_BASE_FALLBACKS.filter((ref) => ref !== headRef)))
  if (baseRef === null) {
    throw new Error(`No base branch found in ${dir} (tried ${LOCAL_BASE_FALLBACKS.join(', ')}). Pass base explicitly.`)
  }
  if (baseRef === headRef) throw new Error(`Base and branch are both ${headRef} in ${dir}. Name a different base.`)
  const mergeBase = await git(['merge-base', baseRef, headSha])
    .then((r) => r.stdout.trim())
    .catch(() => {
      throw new Error(`\`git merge-base ${baseRef} ${headRef}\` failed in ${dir}. Do they share history?`)
    })

  // A re-review diffs from the previous head, not from the merge base: only what changed since.
  const since = extras.previous?.sha
  if (since !== undefined) {
    const known = await git(['cat-file', '-e', `${since}^{commit}`]).then(
      () => true,
      () => false,
    )
    if (!known) throw new Error(`The previous review was of ${since.slice(0, 7)}, which is not a commit in ${dir}. Was the branch rewritten? Review it in full instead.`)
  }
  const against = since ?? mergeBase

  // Only the checked-out branch has a working tree. Review it as it stands — with
  // the uncommitted edits and the files never added, which is the point of reviewing
  // locally. Any other branch is committed history and nothing else.
  const live = branch === undefined || headRef === checkedOut
  const { patch: rawPatch, changed } = live
    ? await workingTreeDiff(dir, against)
    : await refDiff(git, against, headSha)
  if (rawPatch.trim() === '') {
    throw new Error(since === undefined ? `Nothing to review: ${headRef} is identical to ${baseRef} in ${dir}.` : `Nothing to re-review: ${headRef} in ${dir} has not changed since ${since.slice(0, 7)}.`)
  }
  const subject = (await git(['log', '-1', '--format=%s', headSha])).stdout.trim()

  // The tree the seats read around the diff: the working tree for a live review
  // (tracked plus untracked-but-not-ignored, so new files in the diff exist in it),
  // the commit's own tree for any other branch.
  const tar = live
    ? await run('sh', ['-c', 'git ls-files -z -co --exclude-standard | tar -czf - --null -T -'], {
        cwd: dir,
        env: TAR_ENV,
        maxBuffer: MAX_TARBALL,
        encoding: 'buffer',
      }).catch(() =>
        run('tar', ['-czf', '-', ...LOCAL_EXCLUDES.flatMap((e) => ['--exclude', e]), '.'], {
          cwd: dir,
          env: TAR_ENV,
          maxBuffer: MAX_TARBALL,
          encoding: 'buffer',
        }),
      )
    : await run('git', ['-C', dir, ...archiveArgs(headSha)], { maxBuffer: MAX_TARBALL, encoding: 'buffer' })
  await sandbox.writeBinaryFile({ path: '/workspace/repo.tgz', content: new Uint8Array(tar.stdout) })
  const extract = await sandbox.run({
    command: `rm -rf ${REPO_PATH} && mkdir -p ${REPO_PATH} && tar -xzf /workspace/repo.tgz -C ${REPO_PATH} && rm /workspace/repo.tgz`,
  })
  if (extract.exitCode !== 0) throw new Error(`Extracting ${dir} failed (exit ${extract.exitCode}): ${extract.stderr || extract.stdout}`)

  const { patch: capped, truncated } = truncatePatch(rawPatch)
  await sandbox.writeTextFile({ path: FILES.patch, content: capped })
  await sandbox.writeTextFile({ path: FILES.changed, content: `${changed.join('\n')}\n` })

  const scope = live
    ? 'The working tree is included, so uncommitted edits and files that were never added are part of this diff.'
    : `${headRef} is not the checked-out branch, so this is its committed history only — nothing from the working tree.`
  const meta: PrMeta = {
    label: `${dir} @ ${headRef} vs ${baseRef}`,
    title: subject === '' ? `Local changes on ${headRef}` : subject,
    body: `Local review of \`${headRef}\` against \`${baseRef}\` in \`${dir}\`, from their merge base \`${mergeBase.slice(0, 7)}\`. ${scope}`,
    baseRef: `${baseRef} (merge base ${mergeBase.slice(0, 7)})`,
    baseSha: mergeBase,
    headRef,
    headSha,
    author: null,
    url: null,
  }
  return finish(sandbox, meta, capped, changed, truncated, REPO_PATH, { repoDir, branch: headRef }, extras)
}

/**
 * The checked-out branch, working tree and all. `--cached` against a scratch index
 * seeded from HEAD, because a plain working-tree diff silently omits files that were
 * never `git add`ed — the newest code on the branch. The person's own index is never
 * touched, and the scratch file goes away whatever happens.
 */
async function workingTreeDiff(dir: string, against: string): Promise<{ patch: string; changed: string[] }> {
  const indexFile = resolve(tmpdir(), `pr-review-index-${process.pid}-${Date.now()}`)
  const staged = (args: string[]) =>
    run('git', ['-C', dir, ...args], { maxBuffer: MAX_TARBALL, env: { ...process.env, GIT_INDEX_FILE: indexFile } })
  try {
    for (const args of TEMP_INDEX_SETUP) await staged(args)
    return {
      patch: (await staged(cachedDiffArgs(against, false))).stdout,
      changed: parseChangedFiles((await staged(cachedDiffArgs(against, true))).stdout),
    }
  } finally {
    await rm(indexFile, { force: true })
  }
}

/** Any other branch: `main...branch`, straight out of the object database. */
async function refDiff(
  git: (args: string[]) => Promise<{ stdout: string }>,
  against: string,
  headSha: string,
): Promise<{ patch: string; changed: string[] }> {
  return {
    patch: (await git(refDiffArgs(against, headSha, false))).stdout,
    changed: parseChangedFiles((await git(refDiffArgs(against, headSha, true))).stdout),
  }
}

async function loadPatchOnly(sandbox: SandboxSession, patch: string, extras: Extras) {
  const { patch: capped, truncated } = truncatePatch(patch)
  const changed = changedFromPatch(capped)
  if (changed.length === 0) throw new Error('That does not look like a unified diff: no `diff --git` headers found.')
  await sandbox.writeTextFile({ path: FILES.patch, content: capped })
  await sandbox.writeTextFile({ path: FILES.changed, content: `${changed.join('\n')}\n` })
  const meta: PrMeta = {
    label: 'a pasted diff',
    title: 'Pasted diff',
    body: 'No repository was loaded. The seats review this patch on its own and cannot read the surrounding code.',
    baseRef: 'unknown',
    baseSha: '',
    headRef: 'unknown',
    headSha: '',
    author: null,
    url: null,
  }
  return finish(sandbox, meta, capped, changed, truncated, null, null, extras)
}

async function finish(
  sandbox: SandboxSession,
  meta: PrMeta,
  patch: string,
  changed: string[],
  truncated: boolean,
  repoPath: string | null,
  // Where the review is written afterwards: the git root of a local source, so the
  // review lands in the repo it reviewed. Null for a GitHub PR or a bare patch —
  // there is no checkout on this machine to put it in.
  local: { repoDir: string; branch: string } | null,
  extras: Extras,
) {
  // A truncated patch does not contain every changed file, so changed_files.txt is
  // narrowed to what is actually in it — the seats are told to cite paths from that
  // file, and a path they cannot read is a wasted call and a bad finding.
  const { reviewed, dropped } = splitChanged(changed, patch, truncated)
  if (dropped.length > 0) await sandbox.writeTextFile({ path: FILES.changed, content: `${reviewed.join('\n')}\n` })

  const target: ReviewTarget = {
    baseSha: meta.baseSha,
    headSha: meta.headSha,
    since: extras.previous === null ? null : { sha: extras.previous.sha, dir: extras.previous.dir },
  }
  const stats = patchStats(patch, reviewed.length, truncated)
  const prMd = renderPrMeta(meta, stats, reviewed, dropped, target)
  await sandbox.writeTextFile({ path: FILES.meta, content: prMd })
  if (extras.previous !== null) await sandbox.writeTextFile({ path: FILES.previousFindings, content: extras.previous.findings })

  // The packet, once: the index of the change and the required reading. No hunks, no file bodies.
  const required = extras.knowledgeRequiredFile === null ? null : await Promise.resolve(sandbox.readTextFile({ path: extras.knowledgeRequiredFile })).catch(() => null)
  const packet = buildPacket({ label: meta.label, description: prMd, patch, changed: reviewed, required, previousFindings: extras.previous?.findings ?? null })
  const { text, ...packetStats } = packet

  // The shas and the packet size, in the sandbox for export-review and comment-on-pr; the
  // packet itself on the host for pr-debator, whose steps read the host and never the sandbox.
  await sandbox.writeTextFile({ path: TARGET_FILE, content: JSON.stringify({ target, packet: packetStats }, null, 2) })
  const context: ReviewContextFile = {
    pr: {
      label: meta.label,
      repoPath,
      knowledgePath: extras.knowledgeRequiredFile === null ? null : dirname(extras.knowledgeRequiredFile),
      knowledgeRequiredFile: extras.knowledgeRequiredFile,
    },
    packet: text,
    target,
    stats: packetStats,
    changedLines: stats.additions + stats.deletions,
    personas: await readPersonas(),
    costSamples: await readCostSamples(),
  }
  const contextFile = await writeContext(extras.rootSessionId, context)

  return {
    label: meta.label,
    title: meta.title,
    repoPath,
    repoDir: local?.repoDir ?? null,
    // Set only for a GitHub PR, where comment-on-pr can post the review back.
    github: null as { owner: string; name: string; number: number } | null,
    branch: local?.branch ?? meta.headRef,
    files: FILES,
    stats,
    target,
    contextFile,
    packet: packetStats,
    required: required !== null,
    notReviewed: dropped,
    changed: reviewed.slice(0, 50),
  }
}

async function firstResolvable(dir: string, refs: string[]): Promise<string | null> {
  for (const ref of refs) {
    const ok = await run('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', ref]).then(
      () => true,
      () => false,
    )
    if (ok) return ref
  }
  return null
}
