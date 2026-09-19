# Component docs

One MDX file per component. This folder is the source of truth for how the components are used; the docs site and the MCP server both render it. Frontmatter: `eyebrow`, `title`, `description` (must include the import path). Sections: Usage, Variants, Sizes, States, Props. `<Demo>` blocks render live in the docs site and are returned as code by the MCP server.

Copied from SAAS_BOILER `content/design-system/` as components migrate. `scripts/migrate-component.mjs` does the copy and rewrites import paths.
