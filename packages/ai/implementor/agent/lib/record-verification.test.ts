// Lives in lib/ because eve discovers every file in agent/tools/ as a tool, test files included.
import { expect, it } from 'vitest'
import tool from '../tools/record-verification.ts'
import { SCHEMAS } from './local-plan.ts'

it('applies the verification schema the --local driver applies, so the cloud path cannot report done without the three fields', () => {
  expect(tool.inputSchema).toBe(SCHEMAS.VERIFICATION)
  expect(tool.availableInSubagents).toBe(false)
  expect(tool.description).toContain('publish-branch')
})
