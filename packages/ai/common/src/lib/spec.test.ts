// The business spec contract (spec.ts checkBusinessSpec): the Features list the spec writer, the
// spec reviewer and the planner hold a spec to. KIT-27: a feature is a top-level "- [ ] F<n>:" bullet;
// indented bullets beneath it are its detail, and a stray top-level bullet is named in the error.
import { describe, expect, it } from 'vitest'
import { checkBusinessSpec, specFeatures } from './spec.ts'

const spec = (features: string) => `# Feature\n\n## Intent\n\nPersist a named item.\n\n## Acceptance criteria\n\n### Features\n\n${features}\n\n## Out of scope\n\nNothing.\n`

describe('checkBusinessSpec', () => {
  it('accepts a feature whose detail sits in indented bullets beneath it (KIT-27)', () => {
    const text = spec(['- [ ] F1: An authorized user can save an item once.', '- [ ] F2: Retry behaviour for every other case is unchanged:', '  - a redrivable execution is redriven', '  - a file with shards retries its shards', '    - nested detail stays detail', '- [ ] F3: The docs name the new endpoint.'].join('\n'))
    expect({ errors: checkBusinessSpec(text), ids: specFeatures(text).items.map((item) => item.id) }).toEqual({ errors: [], ids: ['F1', 'F2', 'F3'] })
  })

  it('names a top-level bullet without an F-number instead of a bare count mismatch', () => {
    const text = spec(['- [ ] F1: An authorized user can save an item once.', '- The retry endpoint keeps the file id.', '- [x] F2: A checked item is not a feature either.'].join('\n'))
    const errors = checkBusinessSpec(text)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('"- The retry endpoint keeps the file id."')
    expect(errors[0]).toContain('"- [x] F2: A checked item is not a feature either."')
  })

  it('still requires at least one feature and unique ids', () => {
    expect(checkBusinessSpec(spec('Nothing here.'))).toEqual(['Features need unchecked F1:, F2: checklist items'])
    expect(checkBusinessSpec(spec('- [ ] F1: One.\n- [ ] F1: Two.'))).toEqual(['Duplicate feature IDs'])
  })
})
