import { describe, expect, it } from 'vitest'
import { clonePrCommand, compareApiUrl, patchStats, renderPrMeta, type PrMeta } from './pr.ts'

const source = { kind: 'github' as const, owner: 'acme', name: 'app', number: 7, label: 'acme/app#7' }
const meta: PrMeta = { label: 'acme/app#7', title: 'Change a', body: 'Body', baseRef: 'main', baseSha: 'a'.repeat(40), headRef: 'feat/x', headSha: 'b'.repeat(40), author: 'dev', url: 'https://github.com/acme/app/pull/7' }

describe('clonePrCommand', () => {
  it('diffs from the merge base by default', () => {
    const command = clonePrCommand(source, meta, undefined)
    expect(command).toContain('MB=$(git merge-base __base __pr)')
    expect(command).toContain('git diff --patch --no-color "$FROM" __pr > /workspace/pr.patch')
    expect(command).not.toContain('cat-file')
  })
  it('diffs from the previous head for a re-review, and fails plainly when it is gone', () => {
    const command = clonePrCommand(source, meta, 'tok', 'c'.repeat(40))
    expect(command).toContain(`git cat-file -e '${'c'.repeat(40)}'^{commit} || { echo "the previous head ccccccc is not in the repository; was the branch rewritten? Review in full instead." >&2; exit 3; }`)
    expect(command).toContain(`FROM='${'c'.repeat(40)}'`)
    expect(command).not.toContain('merge-base')
  })
})

describe('compareApiUrl', () => {
  it('names the two commits with three dots', () => {
    expect(compareApiUrl('acme', 'app', 'abc', 'def')).toBe('https://api.github.com/repos/acme/app/compare/abc...def')
  })
})

describe('renderPrMeta', () => {
  const stats = patchStats('+a\n-b\n', 1)
  it('records what was reviewed and says when it is a re-review of a delta', () => {
    const fresh = renderPrMeta(meta, stats, ['a.ts'], [], { baseSha: meta.baseSha, headSha: meta.headSha, since: null })
    expect(fresh).toContain(`- Reviewed: base \`${meta.baseSha}\` → head \`${meta.headSha}\``)
    expect(fresh).not.toContain('Re-review')
    const again = renderPrMeta(meta, stats, ['a.ts'], [], { baseSha: meta.baseSha, headSha: meta.headSha, since: { sha: 'c'.repeat(40), dir: '/r/.work/x/pr-review' } })
    expect(again).toContain(`- Re-review: \`${'c'.repeat(40)}\`..\`${meta.headSha}\` (base \`${meta.baseSha}\`)`)
    expect(again).toContain('- **Re-review.** The previous review in `/r/.work/x/pr-review` was of `ccccccc`. The diff below is only what changed since; the previous findings are in `/workspace/previous-findings.md`.')
  })
  it('is unchanged without a target', () => {
    expect(renderPrMeta(meta, stats, ['a.ts'])).not.toContain('Reviewed:')
  })
})
