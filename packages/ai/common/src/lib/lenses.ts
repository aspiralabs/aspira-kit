// The spec reviewer's specialist lenses, by name. The spec reviewer keeps each lens's prompt
// paragraph (review.ts); the groomer seeds one design-tree branch per lens. One list, so the two
// never drift apart.

export const LENSES = ['security', 'architecture', 'data', 'behavior', 'ui', 'acceptance'] as const
export type Lens = (typeof LENSES)[number]
