---
name: tri-swarm
description: >-
  Run Swarm mode with pre-validated dependency DAGs, failure-blocking propagation,
  isolated git worktrees, and process-locked shared JSONL coordination boards.
---

# Tri-Engine Swarm (`relay_orchestrate(pattern="swarm")`)

1. Define `workers[]` with `name`, `role`/`profile`/`spec`, `mode` (`readonly`|`write`), `ownedFiles`, and `dependsOn`.
2. Trirelay validates duplicate names, unknown `dependsOn`, and dependency cycles before Wave 1 starts.
3. Failed prerequisites automatically mark dependent workers as `blocked` (unless `allowFailedDependency: true`).
4. Inspect or steer progress via `relay_board(action="read" | "post", boardId=...)` (tiered Pin/Stub/Recall by default; pass `view="full"` for raw records).
