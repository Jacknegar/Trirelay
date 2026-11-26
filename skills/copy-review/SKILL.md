---
name: copy-review
description: >-
  Audit UI copy, status labels (2-4 words), READMEs, or technical documentation
  using the advisor engine via `relay_copy_review`.
---

# Copy & Documentation Review (`relay_copy_review`)

Use after drafting user-facing READMEs, UX text, or status labels.

1. Call `relay_copy_review` with `content` or `filePath`, `audience`, and `purpose`.
2. Review the returned `rows[]` (`location | current | problem | suggestion`).
3. Cross-check every suggested claim against actual implemented code/CLI behavior before applying edits so documentation never over-promises.
