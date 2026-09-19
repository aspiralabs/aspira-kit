# docs

The design-system site: a renderer of the MDX that ships in `@aspiralabs/ui`, never a second copy. Ported from SAAS_BOILER's `admin/design-system` page on 2026-09-19 with two changes: the nav is derived from each doc's `group` frontmatter instead of a hardcoded list, and MDX is compiled with `next-mdx-remote` instead of contentlayer2 because Next 16 builds with Turbopack and `next-contentlayer2` is a webpack plugin.

Three views map to three folders in the package: `/overview` to `docs/overview`, `/components` to `docs`, `/patterns` to `docs/patterns`. Every doc renders with the same component map (`components/mdx.tsx`), which exposes the ui components to `<Demo>` blocks and grows as components migrate.

```bash
pnpm dev        # from the kit root: ui in watch mode plus this site on :3100
```
