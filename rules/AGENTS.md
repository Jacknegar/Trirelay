# Trirelay Multi-Engine Relay Rules

Use the `trirelay` MCP tools (preferring eager core tools directly without reading JSON schemas first) to orchestrate Antigravity (`agy`), Claude Code (`claude`), and OpenAI Codex (`codex`) with zero self-delegation.

## Core Principles (Small, Fast, Continuous)

1. **Elephant vs. Goldfish Split**:
   - **Elephant (Continuity)**: Implementation (`relay_run(mode="write")`), handoffs (`relay_handoff`), and coordination (`relay_board`) preserve pinned decisions (`[decision]`/`[pin]`/`[blocker]`), programmatic 1-line stubs, and `resumeRole: true` deltas.
   - **Goldfish (Zero-Context Audit)**: `relay_review`, `relay_review_gate`, and `relay_design(action="start")` intentionally receive **0 chat history** and **no author defense**—eliminating anchoring bias and reducing prompt overhead.
2. **Async & Bounded (`<=8.5 KB` inline)**:
   - Pass `background: true` for multi-second runs/reviews/orchestrations, then poll `relay_jobs(action="wait", jobId=..., waitTimeoutMs=30000)`.
   - Large MCP outputs are deterministically compacted (`_compacted: true`) with explicit `_recall` pointers (`relay_jobs(action="result", jobId=..., compact=false)`) to prevent host disk spills.
3. **Host-Symmetric Routing & Isolated Writes**:
   - Route by role (`advisor`, `implementer`, `reviewer`) to auto-exclude the active host, or pass explicit `spec` (`codex:gpt-6.2-astra@max`, `claude:opus@high`, `agy@high`).
   - Require isolated git worktrees (`mode: "write"`) with disjoint `ownedFiles` (strict segment globs) and `forbiddenFiles: ["docs/handoff.md"]` (gitignore-style deny globs); inspect `relay_apply(mode="check")` + tests before `mode="apply"`.

## Tool Reference (Compact Schemas)

- `relay_setup`: `{ cwd?, host?: "agy"|"claude"|"codex"|"cli" }`
- `relay_models`: `{ includeHidden?, includeAgyProbe? }`
- `relay_route`: `{ host?, excludeHost?, profile?, spec?, engine?, model?, effort?, mode?, authorEngine?, strict? }`
- `relay_run`: `{ prompt, cwd?, host?, background?, role?, workflowId?, boardId?, profile?, spec?, engine?, model?, effort?, mode?: "readonly"|"write", ownedFiles?, forbiddenFiles?, invariants?, decisionsMade?, doNotRelitigate?, supersededDecisions?, deprecatedInvariants?, acceptanceCriteria?, handoffId?, parentHandoffId?, handoff?, includeHostDigest?, includeRepoHandoff?, includeBoardDigest?, resumeRole?, resumeSessionId?, forkSession?, outputSchema?, timeoutMs? }`
- `relay_review`: `{ action?: "run"|"inspect", reviewId?, offset?, limit?, severity?, cwd?, host?, background?, engine?: "both"|"agy"|"claude"|"codex", scope?: "auto"|"working-tree"|"branch", base?, focus?, model?, effort?, native?, timeoutMs? }`
- `relay_review_gate`: `{ action?: "run"|"inspect", reviewId?, offset?, limit?, severity?, cwd?, host?, background?, gateKey?, workflowId?, maxRounds?: 2, reset?, engine?, scope?, base?, focus?, effort?, timeoutMs? }`
- `relay_design`: `{ action: "start"|"submit_host"|"reveal", cwd?, host?, background?, designId?, requirement?, contextPaths?, advisorSpec?, hostDraft?, hostDraftPath? }`
- `relay_copy_review`: `{ cwd?, host?, content?, filePath?, audience?, purpose?, advisorSpec?, workflowId? }`
- `relay_orchestrate`: `{ pattern: "teamwork"|"boost"|"swarm"|"pipeline", cwd?, host?, background?, workflowId?, boardId?, goal?, prompt?, models?, crossCritique?, crossVerify?, tasks?, workers?, stages?, maxConcurrency?, maxPerEngine?, timeoutMs? }`
- `relay_apply`: `{ jobId, cwd?, mode?: "check"|"apply" }`
- `relay_handoff`: `{ action: "create"|"inspect"|"list_claude_sessions", cwd?, handoffId?, parentHandoffId?, workflowId?, toEngine?, role?, goal?, ownedFiles?, forbiddenFiles?, invariants?, decisionsMade?, doNotRelitigate?, supersededDecisions?, deprecatedInvariants?, evidence?, acceptanceCriteria?, includeHostDigest?, includeRepoHandoff?, includeBoardDigest? }`
- `relay_board`: `{ action: "read"|"post", cwd?, boardId?, view?: "tiered"|"full", pinsOnly?, seqs?, pinId?, supersedes?, since?, limit?, author?, tag?, text? }`
- `relay_jobs`: `{ action?: "list"|"status"|"wait"|"result"|"cancel", cwd?, jobId?, waitTimeoutMs?, limit?, compact?: true }`
