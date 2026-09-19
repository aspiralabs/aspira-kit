# Component docs

One MDX file per component. This folder is the source of truth for how the components are used; the docs site and the MCP server both render it. Frontmatter: `eyebrow`, `title`, `group` (sidebar group), `description` (must include the import path). Sections: Usage, Variants, Sizes, States, Props. `<Demo>` blocks render live in the docs site and are returned as code by the MCP server.

Groups: Surfaces, Actionable, Form, Tables, Overlays, Layout, Misc for components; Page Chrome, Tables, Marketing for `patterns/`; Foundations for `overview/`. The docs site derives its nav from `group`; there is no hardcoded list.

Docs may `export const` interactive demos that use hooks. Every `@aspiralabs/ui` export, `useState` and friends, `dayjs`, `z` (zod v3 API), `NiceModal`, `useModal`, and `toast` are in scope; do not add `import` lines (they are stripped on the way in from SAAS_BOILER and the renderer does not support them).
