# UI input gaps

## Intent

Products can render every input they need through `@aspiralabs/ui`, so the org lint rule against raw `<input>` never has to be suppressed. Found while adopting the kit in nomnomzz: 11 raw inputs had no kit equivalent.

## Acceptance criteria

### Features

- [ ] F1: A `ref` passed to `Input` (object or callback) receives the underlying `<input>` element, and the mask keeps working. Callers can focus it, read `selectionStart` and set `.value`.
- [ ] F2: `Input type="hidden"` renders a bare hidden `<input>` with its `name` and `value`, with no label, wrapper, mask or styling, so it posts with a native form.
- [ ] F3: `FileInput` renders a native file picker that forwards every input prop and `ref` (so `react-dropzone`'s `getInputProps()` can be spread onto it), keeps `onChange`, and adds `onFilesChange(files: File[])`. It accepts `className` overrides, so it can be hidden and opened from a button or laid over a drop target.
- [ ] F4: `Input` and `FileInput` are documented in `packages/ui/docs` and served by the MCP server; `FileInput` is exported from the package root.

## Implementation and verification plan

- `input.tsx`: take `ref` out of the spread props and merge it into the internal ref callback; return a bare hidden input early for `type="hidden"`.
- `components/file-input/`: the component, an index and tests. Export it from `src/index.ts`. Add `docs/file-input.mdx` and a Refs/Hidden section to `docs/input.mdx`.
- Tests: an object ref and a callback ref both get the element, and the mask still formats typing; hidden renders with no textbox; FileInput forwards its ref, `onChange` and `onFilesChange`, and spreading dropzone-style props works.
- Changeset (minor, lockstep). Run `pnpm --filter @aspiralabs/ui test`, typecheck and lint.

## Out of scope

Native `type="number"`/`"email"` passthrough (imask needs a text input), a styled dropzone component, `InputSelect` aria props, and badge token utility classes.
