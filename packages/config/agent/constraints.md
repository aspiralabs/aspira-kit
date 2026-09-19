# Aspira Labs engineering constraints

Always-on rules. Short on purpose: everything that can be a lint rule, a type, or a gate already is (see `@aspiralabs/config/eslint`). What is here is what a check cannot catch, plus pointers to where the checks live.

## Rule zero

No spec, no code. A feature starts as an approved spec (intent, constraints, acceptance criteria, out of scope, expected blast radius). Commits on a feature branch carry a `Spec: <path>` trailer.

## Enforced by lint (do not argue with the linter, fix the code)

- No ternaries in JSX. Use `&&`, an early return, or a lookup map.
- File names are kebab-case.
- No raw `<button>`, `<input>`, `<select>`, `<textarea>`, or `<table>`. Use `@aspiralabs/ui`.
- No Tailwind palette colors or hex values in class strings. Use semantic tokens.
- No `@radix-ui/*` imports outside `@aspiralabs/ui`.
- No `any`.

## Judgment calls (what the linter cannot see)

- Use the design-system component even when hand-rolling would be faster. If the component does not exist, the fix is a PR to `@aspiralabs/ui`, not a local copy.
- Customize through tokens and variants. Never through `className` color or size overrides at the call site. A new variant goes on the component.
- Pure logic lives outside React so it can be tested without a DOM.
- Match the neighboring code before writing new code. The codebase is the style guide.
- Do not widen scope. If the spec is wrong, finish it and report the gap.
- Surface blockers immediately. Working around one silently is the failure mode.

## Where things are

- Component docs, variants, props, and patterns: the `aspiralabs-ui` MCP server (`list_components`, `get_component`, `search`, `get_tokens`, `get_pattern`). Call `get_component` before writing or editing component markup.
- Guides, pitfalls, decisions, the slop register: the knowledge MCP server, or `node_modules/@aspiralabs/config/agent/`.
- Personas for the pipeline agents: `@aspiralabs/config/agent/personas/`.
