# NOM-4: Explore pagination on web and mobile

- Review target: aspiralabs/nomnomzz#2
- Base: main (5ed8b29)
- Head: feat/nom-4-explore-pagination (e7e4a60)
- Author: dludemann
- URL: https://github.com/aspiralabs/nomnomzz/pull/2
- Diff: 68 files, +11664/-784

## Description

Ticket: NOM-4 Explore pagination (Notion Feature Board)
Spec: `docs/working-feature/nom-4-explore-pagination/spec.reviewed/spec.reviewed.md`
Plan and build log: `docs/working-feature/nom-4-explore-pagination/plan.review/` (`plan.reviewed.md`, `implementation.md`)

## What changes
- **API:** `/api/v1/search` gains opt-in cursor paging (`paginated=1`) with four sorts (relevance, newest, top, time), deterministic tie-breaks, viewer-bound cursors and authorization re-applied on every page. Without the opt-in it still returns the legacy bare array capped at 10, because installed mobile builds and the admin featured search use it. `/api/v1/users/{id}/cookbooks` now returns cursor pages.
- **Web:** Explore with a sort control kept in the URL and infinite scroll; My Recipes shows every recipe as cards; both profile tabs page inside their scroll area; the meal-plan picker pages. `RecipeCard`'s save control is now a sibling of the card link (keyboard reaches each separately).
- **Mobile:** `searchPage` validates responses with Zod; Explore pages with sort chips kept in route params (`?sort=`); the profile list and both picker tabs page.
- **Both:** cached pages are discarded on login, logout, account switch, block/unblock and recipe visibility changes, so another viewer's or a hidden recipe never shows.
- **Shared fetcher:** response schemas (`schema` option), `useCursorFetcher`, `resetCursorAccess`, viewer-scoped cache keys through `generateQueryKey`.

## Tests
- `pnpm check` (kit eslint rules, types, Prettier): pass
- Web unit: 1661/1663 (the 2 failures are the pre-existing flaky `pantry-viewer` test; it also fails on `main`)
- Integration (real Postgres on a throwaway Neon branch): 92/92, including 24 new pagination/authorization tests. These found and fixed a relevance-cursor precision bug.
- Mobile: 176/176, including screen-level acceptance tests
- Browser e2e (`e2e/search-pagination*.spec.ts`): written, **not yet run**. Per `RELEASE.md` they run before the next prod release.

## Also in this branch
- MSW (web tests) and Zod (mobile) added; rule decisions recorded in the plan and in Notion.
- `RELEASE.md` / `AGENTS.md`: integration tests gate dev; e2e runs before prod releases.

## Known gaps
- Picker rows stay `div role="button"` and the Explore sort select is wrapped in a native label, both because of `@aspiralabs/ui` gaps (recorded in the Aspira Kit "UI kit gaps" page).
- Follow-up tickets: Web CI checks and pre-commit hook; Move web tests to MSW.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01Nr55ToRRcVpMw6fpnLmVgc

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/aspiralabs/codesmith/nomnomzz/pr/2?autoLogin=true&ref=codesmith_pr_footer"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with [code]smith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1793768136&installation_model_id=437215&pr_number=2&ref=codesmith_pr_footer&repository=aspiralabs%2Fnomnomzz&return_to=https%3A%2F%2Fgithub.com%2Faspiralabs%2Fnomnomzz%2Fpull%2F2&signature=7c3daeab00824772f532ab2956da39bbaa332bdf241909d75e179536daf44946"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with [code]smith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Changed files

- `AGENTS.md`
- `RELEASE.md`
- `apps/mobile/__tests__/helpers/search-harness.ts`
- `apps/mobile/__tests__/screens/meal-plan.test.tsx`
- `apps/mobile/__tests__/screens/search-pagination.acceptance.test.tsx`
- `apps/mobile/__tests__/screens/search-pagination.test.tsx`
- `apps/mobile/__tests__/search-access.test.tsx`
- `apps/mobile/app/(auth)/login.tsx`
- `apps/mobile/app/(auth)/verify.tsx`
- `apps/mobile/app/(tabs)/explore.tsx`
- `apps/mobile/app/meal-plan.tsx`
- `apps/mobile/app/user/[id].tsx`
- `apps/mobile/hooks/useAuth.ts`
- `apps/mobile/lib/api.test.ts`
- `apps/mobile/lib/api.ts`
- `apps/mobile/lib/query-client.ts`
- `apps/mobile/lib/search-access.ts`
- `apps/mobile/package-lock.json`
- `apps/mobile/package.json`
- `apps/web/app/(app)/profile/[profile_id]/profile-content.test.tsx`
- `apps/web/app/(app)/profile/[profile_id]/profile-content.tsx`
- `apps/web/app/(app)/recipes/me/my-recipes-content.tsx`
- `apps/web/app/(app)/recipes/page.tsx`
- `apps/web/app/(app)/recipes/recipes-content.test.tsx`
- `apps/web/app/(app)/recipes/recipes-content.tsx`
- `apps/web/app/(auth)/logout/page.test.tsx`
- `apps/web/app/(auth)/logout/page.tsx`
- `apps/web/app/admin/featured-recipes/page.tsx`
- `apps/web/app/admin/moderation/moderation-queue.tsx`
- `apps/web/app/admin/moderation/moderation-reports.tsx`
- `apps/web/app/api/v1/search/route.test.ts`
- `apps/web/app/api/v1/search/route.ts`
- `apps/web/app/api/v1/users/[id]/cookbooks/route.test.ts`
- `apps/web/app/api/v1/users/[id]/cookbooks/route.ts`
- `apps/web/components/admin/moderation-recipe-drawer.tsx`
- `apps/web/components/modals/recipe-favorite-search.test.tsx`
- `apps/web/components/modals/recipe-favorite-search.tsx`
- `apps/web/components/profile/profile-actions-menu.test.tsx`
- `apps/web/components/profile/profile-actions-menu.tsx`
- `apps/web/components/recipe/recipe-card.test.tsx`
- `apps/web/components/recipe/recipe-card.tsx`
- `apps/web/components/recipe/recipe-main-search.tsx`
- `apps/web/components/recipe/recipe-title-section.access.test.tsx`
- `apps/web/components/recipe/recipe-title-section.tsx`
- `apps/web/components/ui/project/moderation-recipe-drawer.test.tsx`
- `apps/web/components/ui/project/recipe-title-section.test.tsx`
- `apps/web/e2e/helpers/search-pagination.ts`
- `apps/web/e2e/search-pagination.api.spec.ts`
- `apps/web/e2e/search-pagination.spec.ts`
- `apps/web/lib/api/api-fetcher.test.tsx`
- `apps/web/lib/api/api-fetcher.ts`
- `apps/web/lib/api/better-route.ts`
- `apps/web/lib/api/cursor.test.ts`
- `apps/web/lib/api/cursor.ts`
- `apps/web/lib/api/response.ts`
- `apps/web/lib/auth/session.ts`
- `apps/web/lib/hooks/use-cursor-sentinel.ts`
- `apps/web/package.json`
- `apps/web/pnpm-lock.yaml`
- `apps/web/tests/integration/helpers/search-pagination-seed.ts`
- `apps/web/tests/integration/search-pagination.test.ts`
- `apps/web/tests/msw.test.tsx`
- `apps/web/tests/msw.ts`
- `apps/web/types/search.ts`
- `docs/working-feature/nom-4-explore-pagination/plan.review/handoff-notes.md`
- `docs/working-feature/nom-4-explore-pagination/plan.review/implementation.md`
- `docs/working-feature/nom-4-explore-pagination/plan.review/plan.reviewed.md`
- `docs/working-feature/nom-4-explore-pagination/spec.reviewed/spec.reviewed.md`
