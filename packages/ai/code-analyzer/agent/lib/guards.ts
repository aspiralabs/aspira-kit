import { insideRoot } from './executor.ts'

/** Files the fixer may never touch: it fixes code, not the rules that judge it. */
export const PROTECTED = [
  /(^|\/)(eslint\.config\.[cm]?[jt]s|\.eslintrc(\..*)?|\.eslintignore)$/,
  /(^|\/)(tsconfig(\..*)?\.json|jsconfig\.json)$/,
  /(^|\/)(biome\.jsonc?|\.prettierrc(\..*)?|prettier\.config\.[cm]?[jt]s|\.prettierignore|\.editorconfig)$/,
  /(^|\/)(pyproject\.toml|setup\.cfg|setup\.py|ruff\.toml|\.ruff\.toml|mypy\.ini|\.mypy\.ini|pyrightconfig\.json|\.flake8|tox\.ini)$/,
  /(^|\/)(\.golangci\.ya?ml|\.golangci\.toml|clippy\.toml|\.clippy\.toml|rustfmt\.toml|\.rustfmt\.toml|\.rubocop(_todo)?\.yml)$/,
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|Gemfile\.lock|poetry\.lock|uv\.lock|requirements[^/]*\.txt)$/,
  /(^|\/)(pnpm-workspace\.yaml|turbo\.json|nx\.json|lerna\.json|\.npmrc|\.nvmrc|\.node-version|\.tool-versions)$/,
  /^\.github\//, /^\.gitlab-ci\.yml$/, /^\.circleci\//, /(^|\/)\.husky\//, /^\.git\//,
  /(^|\/)(AGENTS|CLAUDE)\.md$/, /^\.env(\..*)?$/,
]
export const TEST_FILE = /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.go$|_spec\.rb$|(^|\/)test_[^/]+\.py$|(^|\/)[^/]+_test\.py$|(^|\/)tests\.rs$/

export const SUPPRESSIONS = [
  /eslint-disable/g, /@ts-ignore/g, /@ts-expect-error/g, /@ts-nocheck/g, /biome-ignore/g, /prettier-ignore/g,
  /#\s*noqa/g, /#\s*type:\s*ignore/g, /#\s*pyright:\s*ignore/g, /#\s*fmt:\s*(off|skip)/g, /#\s*nosec/g,
  /#\[\s*allow\(/g, /#!\[\s*allow\(/g, /#\[\s*rustfmt::skip\]/g, /\/\/\s*nolint/g, /\/\/\s*go:nolint/g, /rubocop:disable/g, /rubocop:todo/g, /\/\/\s*@ts-/g,
]
export const suppressionCount = (text: string): number => SUPPRESSIONS.reduce((sum, pattern) => sum + (text.match(pattern)?.length ?? 0), 0)

export type Edit = { path: string; before: string; after: string }
export type Rejection = { path: string; reason: string }

export function isProtected(path: string): string | null {
  if (PROTECTED.some((p) => p.test(path))) return 'analyzer configuration, manifest, lockfile, CI or agent instructions'
  if (TEST_FILE.test(path)) return 'test file'
  return null
}

/** Validates an edit against the current file content and returns the new content or a rejection reason. */
export function applyGuardedEdit(root: string, edit: Edit, current: string | null): { content: string } | { reason: string } {
  const rel = insideRoot(root, edit.path)
  if (rel === null) return { reason: 'path is outside the repository' }
  const protectedReason = isProtected(rel)
  if (protectedReason) return { reason: `protected path (${protectedReason})` }
  if (current === null) return { reason: 'file does not exist; the fixer may not create files' }
  if (!edit.before) return { reason: 'empty anchor' }
  const start = current.indexOf(edit.before)
  if (start < 0) return { reason: 'anchor text not found; re-read the file' }
  if (current.indexOf(edit.before, start + 1) >= 0) return { reason: 'anchor text is ambiguous; include more surrounding lines' }
  const content = current.slice(0, start) + edit.after + current.slice(start + edit.before.length)
  const rejected = contentRejection(current, content)
  return rejected === null ? { content } : { reason: rejected }
}

/** The checks on a file's new content against its current content, shared by edit_file and --local. */
export function contentRejection(current: string, content: string): string | null {
  if (!content.trim() && current.trim()) return 'edit would empty the file'
  if (suppressionCount(content) > suppressionCount(current)) return 'edit adds a suppression directive; fix the code instead'
  if (current.trim().length > 200 && content.trim().length < current.trim().length * 0.4) return 'edit removes most of the file; make a targeted fix'
  return null
}

/**
 * The same guards for a whole-file change made outside edit_file (the session's own edits in
 * --local): `before` is null for a file that did not exist, `after` null for one that was removed.
 */
export function changeRejection(root: string, path: string, before: string | null, after: string | null): string | null {
  const rel = insideRoot(root, path)
  if (rel === null) return 'path is outside the repository'
  const protectedReason = isProtected(rel)
  if (protectedReason) return `protected path (${protectedReason})`
  if (before === null) return 'file does not exist; the fixer may not create files'
  if (after === null) return 'file was deleted; the fixer may not delete files'
  return contentRejection(before, after)
}
