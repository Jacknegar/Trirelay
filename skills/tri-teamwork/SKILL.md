---
name: tri-teamwork
description: >-
  Run Teamwork mode across Antigravity, Claude Code, and Codex: architect
  decomposition, parallel isolated git worktree writers with disjoint ownedFiles,
  and opposite-engine cross-verification.
---

# Tri-Engine Teamwork (`relay_orchestrate(pattern="teamwork")`)

1. Provide `goal` (for automatic architect decomposition into 1–4 tasks with disjoint `ownedFiles`) or explicit `tasks[]`.
2. Every `mode: "write"` task runs in an isolated git worktree (`worktree: true`), captures full diffs (including detached-HEAD commits), and audits `ownedFiles` / `forbiddenFiles`.
3. Verification routes automatically to an engine distinct from the primary author (`opposite-verifier`).
4. Inspect patches and apply approved changes via `relay_apply(jobId=..., mode="check")` then `mode="apply"`.
