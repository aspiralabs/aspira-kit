---
'@aspiralabs/ui': minor
---

Add `FileInput`, a native file picker that forwards every input prop and `ref` and adds `onFilesChange(files)`. `Input` now forwards a caller's `ref` (merged with the mask's) and renders `type="hidden"` as a bare hidden input. Spec: specs/ui-input-gaps.md
