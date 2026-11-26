---
name: trirelay
description: >-
  Host-symmetric orchestration guide connecting Antigravity (`agy`), Claude Code
  (`claude`), and OpenAI Codex (`codex`). Use from ANY host to inspect engine
  readiness, route by role or explicit `engine:model@effort`, run isolated
  worktree tasks, seal dual-track designs, audit copy, or enforce 2-round review gates.
---

# Trirelay: Host-Symmetric Multi-Engine Relay

`trirelay` lets **any** of **Antigravity (`agy`)**, **Claude Code (`claude`)**, or **OpenAI Codex (`codex`)** act as the primary coordinator and delegate seamlessly to the other two over a single stdio MCP server (`trirelay`) and full-parity CLI (`trirelay`).

## 1. Host Symmetry & Role Routing

Instead of hardcoding engine names, prefer **role profiles** (`advisor`, `implementer`, `reviewer`), which automatically exclude the active host so you never self-delegate via CLI:

| Active Host | `advisor` | `implementer` | `reviewer` |
|---|---|---|---|
| `agy` | `claude` | `codex` | `codex` (2nd opinion: `claude`) |
| `claude` | `agy` | `codex` | `codex` (2nd opinion: `agy`) |
| `codex` | `agy` | `claude` | `claude` (2nd opinion: `agy`) |

Explicit `spec` overrides (`agy:gemini-4-neon-high@high`, `claude:opus@high`, `codex:gpt-6.2-astra@max`) always win and never cross-provider fallback.

## 2. Long-Running Calls & Bounded Payloads

For non-trivial tasks, pass `background: true` on `relay_run`, `relay_review`, `relay_design(action="start")`, or `relay_orchestrate`, then poll via `relay_jobs(action="wait", jobId=..., waitTimeoutMs=30000)` and read `relay_jobs(action="result", jobId=...)`. Large responses are auto-compacted (`<=8.5 KB`) with `_recall` pointers (`compact=false` to inspect raw full output when needed).

## 3. Isolated Writes & Patch Acceptance

- Every `mode: "write"` run executes in an isolated git worktree (never mutating the main tree directly) and captures both uncommitted edits and detached-HEAD commits into a `.patch` file.
- Always audit `changedFiles`, `scopeViolations`, and `diffStat`, verify via `relay_apply(jobId=..., mode="check")` and local tests, and only then run `relay_apply(jobId=..., mode="apply")`.

## 4. Playbook Skills

- `dual-design`: Sealed anti-anchoring dual-track architecture design (`relay_design`).
- `copy-review`: UI/README/doc wording audit table (`relay_copy_review`).
- `review-gate`: Bounded 2-round blocking/advisory gate (`relay_review_gate`).
- `tri-teamwork`: Architect -> Parallel isolated writers -> Opposite-engine verifier.
- `tri-boost`: Parallel multi-model analysis + forked peer cross-critique.
- `tri-swarm`: Pre-validated dependency DAG workers + locked shared JSONL board (3-tier Pin/Stub/Recall).
