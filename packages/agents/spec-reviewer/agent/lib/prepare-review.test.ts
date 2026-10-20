// KIT-30: a rerun after needs-author or incomplete reads the answered spec.reviewed.md from the
// report directory itself (the Playbook's "answer in spec.reviewed/spec.reviewed.md and rerun"),
// with the previous review's header stripped and the ticked decisions read from trace/decisions.md.
// The guidelines may never live in the report directory, nor any other spec.
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { prepareReview, stripReviewHeader } from './runner.ts'

const SPEC = '# Feature\n## Intent\nPersist a named item.\n## Acceptance criteria\n### Features\n- [ ] F1: An authorized user can save an item once.\n'
const HEADER = '> Review status: **needs-author**. Not ready for implementation; resolve trace/decisions.md and trace/checks.md first. Original status metadata below has not been approved by this review.\n\n## Findings\n\n- R1 (medium): something\n\n---\n\n'

async function write(file: string, text: string) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text)
}

async function workspace() {
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'spec-reviewer-prepare-')))
  execFileSync('git', ['init', '-q', repo])
  await write(join(repo, 'src', 'items.ts'), 'export const save = () => {}\n')
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture'], { cwd: repo })
  const folder = join(repo, '.work', 'kit-9-cart-limit')
  const guidelines = join(repo, 'guidelines.md')
  await write(guidelines, '# Agent Instructions\n\nREV-001 Read the rules.\n')
  return { repo, folder, guidelines }
}

describe('stripReviewHeader', () => {
  it('removes the review callout, the findings and the rule above the candidate, and leaves any other text alone', () => {
    expect({ stripped: stripReviewHeader(`${HEADER}${SPEC}`), plain: stripReviewHeader(SPEC) }).toEqual({ stripped: SPEC, plain: SPEC })
  })
})

describe('prepareReview on a rerun', () => {
  it('accepts the report directory\'s own spec.reviewed.md as the spec, strips its header and reads the ticked decisions (KIT-30)', async () => {
    const { repo, folder, guidelines } = await workspace()
    const dir = join(folder, 'spec.reviewed')
    await write(join(dir, 'spec.reviewed.md'), `${HEADER}${SPEC}`)
    await write(join(dir, 'trace', 'decisions.md'), '# Decisions\n\n## D1 — Keep saved items forever?\n\n- [x] Yes\n- [ ] No\n')
    const prepared = await prepareReview({ specPath: join(dir, 'spec.reviewed.md'), repoPath: repo, guidelinesPath: guidelines, outputDir: dir }, new AbortController().signal)
    expect({ dir: prepared.dir, spec: prepared.spec, answered: prepared.answers.map((answer) => answer.id) }).toEqual({ dir, spec: SPEC, answered: ['D1'] })
  })

  it('still refuses the guidelines, or any other spec, inside the report directory', async () => {
    const { repo, folder, guidelines } = await workspace()
    const dir = join(folder, 'spec.reviewed')
    await write(join(dir, 'other.md'), SPEC)
    await write(join(dir, 'guidelines.md'), '# Agent Instructions\n')
    const signal = new AbortController().signal
    await expect(prepareReview({ specPath: join(dir, 'other.md'), repoPath: repo, guidelinesPath: guidelines, outputDir: dir }, signal)).rejects.toThrow('Output directory must not contain the source spec')
    await expect(prepareReview({ specPath: join(folder, 'spec.md'), repoPath: repo, guidelinesPath: join(dir, 'guidelines.md'), outputDir: dir }, signal)).rejects.toThrow('Output directory must not contain the guidelines')
  })
})
