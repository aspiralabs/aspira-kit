import { defineState } from 'eve/context'
import type { Repo } from './github.ts'

// The one eve import in lib/: what checkout-repo cloned, so publish-branch pushes that repository
// and branch and nothing the model names. Root-session state; agent copies never see it.
export type Checkout = { repo: Repo; root: string; branch: string; base: string; commit: string }
export const checkout = defineState<Checkout | null>('implementor.checkout', () => null)
