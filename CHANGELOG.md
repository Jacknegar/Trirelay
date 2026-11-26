# Changelog

## 1.1.0

- Fixed write-mode session resume worktree binding: `relay_run` with `resumeRole` / `resumeSessionId` now binds to the original worktree (under session lease) or deterministically replays `patchPath` onto `baseSha`, failing closed when a previous write artifact cannot be restored.
- Fixed `pipeline` constraint inheritance: `buildWorkerResultToHandoff` and `resolveInheritedConstraints` now propagate `invariants`, `decisionsMade`, `doNotRelitigate`, `acceptanceCriteria`, `verification`, and `forbiddenFiles` along `parentHandoffId` chains (up to depth 20) while keeping stage-local `ownedFiles`, `role`, and `toEngine` isolated, with explicit `supersededDecisions` / `deprecatedInvariants` tombstones.
- Added immutable review artifacts (`reviewId`) and zero-cost paginated inspection (`relay_review` / `relay_review_gate` with `action: "inspect"`), preserving compact `blockingPreview[]` (`id`, `file`, `line`, `title`, `trigger`) when MCP payloads compact past 8.5 KB.
- Hardened child process spawning and termination (`stdin` `EPIPE` guard, unconditional `-pid` process-group `SIGTERM`/`SIGKILL` sweep, stdio pipe teardown, and forced settlement timer).
- Fixed shared board pin persistence past >200 updates and >64 KB tails via dedicated `boards/<id>.pins.json` index, `pinsOnly` / `seqs` / `pinId` / `supersedes` support, explicit omission warnings, and unbounded `view: "full"` defaults.
- Fixed review gate cycle lifecycle (`open` -> `passed` -> new cycle) so unrelated post-pass reviews do not falsely escalate.
- Distinguished `deliverableMode` (`"patch"`, `"ignored-only"`, `"none"`) during worktree artifact capture, and stabilized byte-0 static prefix ordering in rendered handoffs before the turn delimiter.
- Calibrated documentation and benchmark metrics to match reproducible offline verification and explicitly document engine permission profiles.

## 1.0.0

- Initial standalone open-source **Trirelay** (`trirelay`) release consolidating host-symmetric multi-engine orchestration across Antigravity (`agy`), Claude Code (`claude`), and OpenAI Codex (`codex`) for Linux and macOS.
- Added symmetric `agy` driver (`agy --output-format stream-json --print=...`), pure `codex exec --json` driver with headless worker MCP isolation (skipping unrelated OAuth/remote MCP startup stalls unless explicitly allowed), and hardened `claude -p` driver (`dontAsk` + `--tools` for readonly, `--strict-mcp-config`, nested env scrubbing, `TRIRELAY_DEPTH` recursion guard).
- Added 3-tier zero-LLM board & handoff continuity (`core/compact.mjs`: Pin → Programmatic Stub → On-Demand Recall), prefix-cache-friendly handoff rendering, and `≤8.5 KB` inline MCP payload compaction to prevent disk spills.
- Upgraded `SessionStart` hook (`scripts/session-hook.mjs`) to emit sub-50ms host-native continuity snapshots (`agy` `injectSteps` & `claude` `hookSpecificOutput`).
- Added async background job lifecycle (`relay_jobs`), sealed anti-anchoring dual-design (`relay_design`), copy review (`relay_copy_review`), bounded 2-round review gate (`relay_review_gate`), safe patch apply (`relay_apply`), and cross-process locked XDG state store.
