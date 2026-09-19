# docs

The design-system site: a renderer of the MDX that ships in `@aspiralabs/ui`, never a second copy. Ported from SAAS_BOILER's `admin/design-system` page on 2026-09-19 and now showing every component, layout pattern, and overview doc it showed.

Three views map to three folders in the package: `/overview` to `docs/overview`, `/components` to `docs`, `/patterns` to `docs/patterns`. The nav is derived from each doc's `group` frontmatter.

## How a doc renders

SAAS_BOILER used contentlayer2 and mdx-bundler. Next 16 builds with Turbopack and `next-contentlayer2` is a webpack plugin, and `next-mdx-remote` strips MDX `export` statements, which the docs rely on for interactive demos. So:

1. `lib/mdx.ts` compiles the body on the server with `@mdx-js/mdx` to a function-body module string (remark-gfm, rehype-slug).
2. `components/doc-body.tsx` (client) evaluates it with a scope: every `@aspiralabs/ui` export, React hooks, `dayjs`, `z`, `NiceModal`, `useModal`, `toast`, plus `Demo` and `Lead`. Names the doc declares itself are left out of the scope destructure. An error boundary shows a doc's runtime error inline instead of taking the page down.
3. `components/mdx.tsx` holds the markdown element styling (same classes as SAAS_BOILER's `design-system-mdx.tsx`) and the scope.

`components/providers.tsx` mounts the same providers as SAAS_BOILER (TanStack Query, NiceModal, Tooltip, Toaster, the BlockUI overlay). `app/api/design-system/cities` is the mock endpoint the InputSelect remote demos call.

```bash
pnpm dev        # from the kit root: ui in watch mode plus this site on :3100
```
