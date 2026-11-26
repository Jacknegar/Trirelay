# Changelog

## 1.1.0

- Fixed write-mode session resume worktree binding: `relay_run` with `resumeRole` / `resumeSessionId` now binds to the original worktree (under live-PID session lease, with `bySession` cross-role preservation) or deterministically replays SHA-256-verified `patchPath` onto `baseSha`, failing closed when a previous write artifact cannot be restored.
- Added per-job immutable patches (`patches/<jobId>.patch` + `patchSha256`) and apply-time scope re-audit via `applyJobPatch`, preventing resumed jobs from overwriting an earlier approved job's patch.
- Fixed `pipeline` constraint inheritance: `buildWorkerResultToHandoff` and `resolveInheritedConstraints` now propagate `invariants`, `decisionsMade`, `doNotRelitigate`, `acceptanceCriteria`, `verification`, and `forbiddenFiles` chronologically along `parentHandoffId` chains (up to depth 20, failing closed on missing direct parent) while keeping stage-local `ownedFiles`, `role`, and `toEngine` isolated and audited.
- Added write-once review artifacts (`reviewId`) and zero-cost paginated inspection (`relay_review` / `relay_review_gate` with `action: "inspect"`), preserving compact `blockingPreview[]` (`id`, `file`, `line`, `title`, `trigger`) on both review and `escalate_to_user` payloads past the 8.5 KB MCP cap.
- Hardened child process spawning and termination (`stdin` `EPIPE` guard, `-pid` process-group `SIGTERM`/`SIGKILL` sweep preserved across early `close` while group members survive, normal-exit orphan drain, stdio pipe teardown, and MCP shutdown cleanup).
- Fixed shared board pin persistence past >200 updates and >64 KB tails via watermark-reconciled `boards/<id>.pins.json` index under file lock, `pinsOnly` / `seqs` / `pinId` / `supersedes` support, explicit omission warnings, and unbounded `view: "full"` defaults.
- Fixed review gate cycle lifecycle (`open` -> `passed` -> new cycle) with `cycleId` compare-and-set on completion writeback, non-burning `incomplete` rounds, and `background: true` support.
- Distinguished `deliverableMode` (`"patch"`, `"ignored-only"`, `"none"`) without false `ownedFiles` violations on ignored caches, and stabilized cross-stage byte-0 static prefix ordering in rendered handoffs before the turn delimiter.
- Added CLI parity flags (`--parent-handoff`, `--decision`, `--do-not-relitigate`, `--supersede`, `--deprecate-invariant`, `--timeout`) and calibrated documentation/benchmarks.
- Completed release-gate adversarial hardening (R8–R26): segment-based zero-ReDoS glob scope matching (`**/.env*`, `**/secrets/**`, `packages/*/src/**`, `?` single-codepoint wildcard, newline/Unicode path support, POSIX literal-backslash isolation, and gitignore-style `forbiddenFiles` deny semantics), legacy v1.0 write-session canonical lookup & worktree-HEAD base diff, per-attempt `ConcurrencyPool` admission with post-grant & pre-spawn abort guards, synchronous callback error containment, `waitTimeoutMs` timer cleanup, `cwd`-preserving recall pointers, `seqs`-prioritized board reads, and stale review-gate `decision: "stale"` protection.

## 1.0.0

- Initial standalone open-source **Trirelay** (`trirelay`) release consolidating host-symmetric multi-engine orchestration across Antigravity (`agy`), Claude Code (`claude`), and OpenAI Codex (`codex`) for Linux and macOS.
- Added symmetric `agy` driver (`agy --output-format stream-json --print=...`), pure `codex exec --json` driver with headless worker MCP isolation (skipping unrelated OAuth/remote MCP startup stalls unless explicitly allowed), and hardened `claude -p` driver (`dontAsk` + `--tools` for readonly, `--strict-mcp-config`, nested env scrubbing, `TRIRELAY_DEPTH` recursion guard).
- Added 3-tier zero-LLM board & handoff continuity (`core/compact.mjs`: Pin → Programmatic Stub → On-Demand Recall), prefix-cache-friendly handoff rendering, and `≤8.5 KB` inline MCP payload compaction to prevent disk spills.
- Upgraded `SessionStart` hook (`scripts/session-hook.mjs`) to emit host-native continuity snapshots (`agy` `injectSteps` & `claude` `hookSpecificOutput`).
- Added async background job lifecycle (`relay_jobs`), sealed anti-anchoring dual-design (`relay_design`), copy review (`relay_copy_review`), bounded 2-round review gate (`relay_review_gate`), safe patch apply (`relay_apply`), and cross-process locked XDG state store.
