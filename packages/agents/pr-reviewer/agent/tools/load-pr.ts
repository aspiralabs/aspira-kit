import { execFile } from 'node:child_process'
import { rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { SandboxSession } from 'eve/sandbox'
import { defineTool } from 'eve/tools'
import { z } from 'zod'
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
import { FILES } from '../lib/review'

const run = promisify(execFile)
const MAX_TARBALL = 512 * 1024 * 1024
// macOS tar adds ._* AppleDouble files unless told not to.
const TAR_ENV = { ...process.env, COPYFILE_DISABLE: '1' }

// Puts everything the six seats read into the shared sandbox: the tree at
// /workspace/repo, the diff at /workspace/pr.patch, the changed paths at
// /workspace/changed_files.txt, and the PR itself at /workspace/pr.md. The file
// layout is nitpick's, because the ported role prompts already assume it.
//
// A GitHub PR is cloned and diffed inside the sandbox; a local repo is diffed on
// the host (so uncommitted work counts) and tarred in. Runs in the app runtime,
// hence node:child_process.

export default defineTool({
  availableInSubagents: false,
  description:
    'Load a pull request into the sandbox so the review seats can read it. Either a GitHub PR (`source` = a PR URL or `owner/name#123`), or a local repository (`source` = the repo path, `branch` = the branch to review, `base` = what to compare it against, default main). Or pass `patch` with a unified diff and no repo. Call before pr-debator, always.',
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
  }),
  async execute({ source, branch, base, patch }, ctx) {
    if (source === undefined && patch === undefined) throw new Error('Pass source or patch.')
    const sandbox = await ctx.getSandbox()

    if (source === undefined) return loadPatchOnly(sandbox, patch as string)

    const parsed = parsePrSource(source)
    if (parsed.kind === 'github') return loadGithubPr(sandbox, parsed)
    return loadLocal(sandbox, parsed.path, base, branch)
  },
})

async function loadGithubPr(sandbox: SandboxSession, parsed: Extract<ReturnType<typeof parsePrSource>, { kind: 'github' }>) {
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

  const result = await sandbox.run({ command: clonePrCommand(parsed, meta, token) })
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

  return { ...(await finish(sandbox, meta, capped, changed, truncated, REPO_PATH)), github: { owner: parsed.owner, name: parsed.name, number: parsed.number } }
}

async function loadLocal(sandbox: SandboxSession, path: string, base: string | undefined, branch: string | undefined) {
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

  // Only the checked-out branch has a working tree. Review it as it stands — with
  // the uncommitted edits and the files never added, which is the point of reviewing
  // locally. Any other branch is committed history and nothing else.
  const live = branch === undefined || headRef === checkedOut
  const { patch: rawPatch, changed } = live
    ? await workingTreeDiff(dir, mergeBase)
    : await refDiff(git, mergeBase, headSha)
  if (rawPatch.trim() === '') {
    throw new Error(`Nothing to review: ${headRef} is identical to ${baseRef} in ${dir}.`)
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
  return finish(sandbox, meta, capped, changed, truncated, REPO_PATH, { repoDir, branch: headRef })
}

/**
 * The checked-out branch, working tree and all. `--cached` against a scratch index
 * seeded from HEAD, because a plain working-tree diff silently omits files that were
 * never `git add`ed — the newest code on the branch. The person's own index is never
 * touched, and the scratch file goes away whatever happens.
 */
async function workingTreeDiff(dir: string, mergeBase: string): Promise<{ patch: string; changed: string[] }> {
  const indexFile = resolve(tmpdir(), `pr-review-index-${process.pid}-${Date.now()}`)
  const staged = (args: string[]) =>
    run('git', ['-C', dir, ...args], { maxBuffer: MAX_TARBALL, env: { ...process.env, GIT_INDEX_FILE: indexFile } })
  try {
    for (const args of TEMP_INDEX_SETUP) await staged(args)
    return {
      patch: (await staged(cachedDiffArgs(mergeBase, false))).stdout,
      changed: parseChangedFiles((await staged(cachedDiffArgs(mergeBase, true))).stdout),
    }
  } finally {
    await rm(indexFile, { force: true })
  }
}

/** Any other branch: `main...branch`, straight out of the object database. */
async function refDiff(
  git: (args: string[]) => Promise<{ stdout: string }>,
  mergeBase: string,
  headSha: string,
): Promise<{ patch: string; changed: string[] }> {
  return {
    patch: (await git(refDiffArgs(mergeBase, headSha, false))).stdout,
    changed: parseChangedFiles((await git(refDiffArgs(mergeBase, headSha, true))).stdout),
  }
}

async function loadPatchOnly(sandbox: SandboxSession, patch: string) {
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
  return finish(sandbox, meta, capped, changed, truncated, null)
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
  local: { repoDir: string; branch: string } | null = null,
) {
  // A truncated patch does not contain every changed file, so changed_files.txt is
  // narrowed to what is actually in it — the seats are told to cite paths from that
  // file, and a path they cannot read is a wasted call and a bad finding.
  const { reviewed, dropped } = splitChanged(changed, patch, truncated)
  if (dropped.length > 0) await sandbox.writeTextFile({ path: FILES.changed, content: `${reviewed.join('\n')}\n` })

  const stats = patchStats(patch, reviewed.length, truncated)
  await sandbox.writeTextFile({ path: FILES.meta, content: renderPrMeta(meta, stats, reviewed, dropped) })
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
