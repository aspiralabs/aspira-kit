/** Business acceptance belongs in the spec; technical test design belongs in the plan. */
export function specFeatures(markdown: string) {
  let fence: string | undefined
  const text = markdown.split('\n').filter((line) => {
    const match = line.match(/^\s*(`{3,}|~{3,})/)
    if (match?.[1]) {
      if (!fence) fence = match[1]
      else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = undefined
      return false
    }
    return !fence
  }).join('\n')
  const acceptance = text.match(/^## Acceptance criteria\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/im)?.[1] ?? ''
  const features = acceptance.match(/^### Features\s*\n([\s\S]*?)(?=^### |$(?![\s\S]))/im)?.[1] ?? ''
  const rows = [...features.matchAll(/^\s*- \[ \] (F\d+):\s+(\S.+)$/gm)]
  return { text, features, items: rows.map((row) => ({ id: row[1]!, description: row[2]! })) }
}

export function checkBusinessSpec(markdown: string): string[] {
  const { text, features, items } = specFeatures(markdown)
  const errors: string[] = []
  if (!text.match(/^## Intent\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/im)?.[1]?.trim()) errors.push('Missing or empty ## Intent')
  if (!items.length) errors.push('Features need unchecked F1:, F2: checklist items')
  if (new Set(items.map((item) => item.id)).size !== items.length) errors.push('Duplicate feature IDs')
  // A feature is a top-level bullet; an indented bullet beneath it is part of that feature (KIT-27). A
  // top-level bullet without an unchecked F-number is named, so the writer sees which line to fix.
  const stray = (features.match(/^[-*+]\s+.+$/gm) ?? []).filter((line) => !/^- \[ \] F\d+:\s+\S/.test(line))
  if (stray.length > 0) errors.push(`Every feature must be a top-level "- [ ] F<n>: ..." item (detail may go in indented bullets beneath it); these lines are not: ${stray.map((line) => `"${line.slice(0, 80)}"`).join(', ')}`)
  return errors
}
