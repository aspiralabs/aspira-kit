<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# docs

The design-system site for `@aspiralabs/ui`. It renders the MDX that ships inside the package; it is never a second copy of the docs. To change what a component page says, edit `packages/ui/docs/<name>.mdx`, not this app.

The org rules apply here as everywhere: `../../packages/config/agent/constraints.md`. How a doc renders, and why it is compiled the way it is, is in `README.md` next to this file. Changes to this app alone do not need a changeset.
