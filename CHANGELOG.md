# Changelog

## 1.0.0

- Initial standalone open-source **Trirelay** (`trirelay`) release consolidating host-symmetric multi-engine orchestration across Antigravity (`agy`), Claude Code (`claude`), and OpenAI Codex (`codex`) for Linux and macOS.
- Added symmetric `agy` driver (`agy --output-format stream-json --print=...`), pure `codex exec --json` driver with headless worker MCP isolation (skipping unrelated OAuth/remote MCP startup stalls unless explicitly allowed), and hardened `claude -p` driver (`dontAsk` + `--tools` for readonly, `--strict-mcp-config`, nested env scrubbing, `TRIRELAY_DEPTH` recursion guard).
- Added 3-tier zero-LLM board & handoff continuity (`core/compact.mjs`: Pin → Programmatic Stub → On-Demand Recall), prefix-cache-friendly handoff rendering, and `≤8.5 KB` inline MCP payload compaction to prevent disk spills.
- Upgraded `SessionStart` hook (`scripts/session-hook.mjs`) to emit sub-50ms host-native continuity snapshots (`agy` `injectSteps` & `claude` `hookSpecificOutput`).
- Added async background job lifecycle (`relay_jobs`), sealed anti-anchoring dual-design (`relay_design`), copy review (`relay_copy_review`), bounded 2-round review gate (`relay_review_gate`), safe patch apply (`relay_apply`), and cross-process locked XDG state store.
