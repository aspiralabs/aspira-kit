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

`agent/` holds the org's knowledge and the pipeline's plumbing: `constraints.md`, `guides/`, `pitfalls.md`, `slop-register.md`, `decisions.md`, `hooks/`, `personas/`, `templates/`. `kit init` copies the templates into a project and points the hooks at this package in `node_modules`.
