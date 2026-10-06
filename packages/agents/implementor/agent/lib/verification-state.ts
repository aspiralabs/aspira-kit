import { defineState } from 'eve/context'
import type { z } from 'zod'
import type { SCHEMAS } from './local-plan.ts'

// The one other eve import in lib/: the final verification record-verification took, so
// publish-branch pushes nothing a build has not written down. Root-session state; copies never see it.
export type Verification = z.infer<typeof SCHEMAS.VERIFICATION>
export const verification = defineState<Verification | null>('implementor.verification', () => null)
