import { defineTool } from 'eve/tools'
import { SCHEMAS } from '../lib/local-plan.ts'
import { verification } from '../lib/verification-state.ts'

// The cloud run has no --local driver to check its final verification, so the schema the driver
// applies is applied here: the input is the verification output, and publish-branch refuses to
// run until it has been recorded.
export default defineTool({
  availableInSubagents: false,
  description: 'Record the final verification of the build, in the shape the procedure\'s section 6 and 7 produce: the feature table, every dependency the build added with its native and approval flags, every mid-build notes file as rewritten or deleted, and the proposed Slop Repo entries (or, when there are none, why). Call once after implementation.md is written and before publish-branch, which refuses to run without it.',
  inputSchema: SCHEMAS.VERIFICATION,
  execute(input) {
    verification.update(() => input)
    return { recorded: true, status: input.status, features: input.features.length, dependenciesAdded: input.dependenciesAdded.length, notesRewritten: input.notesRewritten.length, slopEntries: input.slopEntries.length }
  },
})
