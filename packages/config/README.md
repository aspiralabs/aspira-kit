# @aspiralabs/config

Shared config as subpath exports. Config only, no runtime peers, so it installs cleanly into any JS project.

```js
// eslint.config.mjs
import next from '@aspiralabs/config/eslint/next'
export default next
```

```json
// tsconfig.json
{ "extends": "@aspiralabs/config/tsconfig/next.json" }
```

```js
// prettier.config.mjs
export { default } from '@aspiralabs/config/prettier'
```

The engineering rules live in Notion (Engineering Central). This package carries no agent files; the `AGENTS.md` block, the MCP config and the session hooks are written by `@aspiralabs/kit`.
