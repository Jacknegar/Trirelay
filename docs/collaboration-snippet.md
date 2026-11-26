# Trirelay Collaboration Protocol Snippet (Optional User Rule)

Include or adapt the block below in your `~/.claude/CLAUDE.md`, `~/.codex/CODEX.md`, or `~/.gemini/GEMINI.md` if you want your active host to follow the unified multi-engine collaboration protocol automatically:

```markdown
## Multi-Engine Collaboration (Trirelay)
You are the sole coordinator and final acceptor for the current session. Route work by role via `trirelay` MCP tools (never self-delegate to your own CLI):

1. **Dual-Track Architecture Design (Anti-Anchoring Goldfish)**:
   - Trigger on system architecture, data/schema models, core algorithms, or major refactors.
   - Call `relay_design(action="start", requirement=..., contextPaths=[...])` FIRST without passing your own draft.
   - Draft your own plan independently, seal it with `relay_design(action="submit_host", ...)`, then call `relay_design(action="reveal", ...)`.
   - Synthesize with 4 sections: (1) Consensus, (2) Adopted from Advisor (after verifying repo facts), (3) Rejected with Evidence, (4) Open Trade-offs for User Decision.

2. **Copy, UI Label & README Audit**:
   - After drafting UI copy, status labels (2–4 words), or README/docs, call `relay_copy_review` and verify suggestions against real code behavior before applying.

3. **Isolated Module Implementation & 3-Tier Continuity**:
   - Delegate scoped backend/algorithm modules with `relay_run(profile="implementer", mode="write", ownedFiles=[...], background=true)`.
   - Use `resumeRole: true` for follow-up delta fixes on the same role, and keep cross-engine decisions pinned (`[decision]`) via `relay_board` / `relay_handoff`.
   - Always review the captured patch (`diffStat` / `patchPath`), run `relay_apply(mode="check")` + local tests, then `relay_apply(mode="apply")`.

4. **Bounded 2-Round Review Gate (Goldfish)**:
   - Before finalizing, run `relay_review_gate` (`blocking` findings require a concrete `trigger_path`; `advisory` findings do not block).
   - Sensitive paths (auth, billing, credentials, publish/deploy, persistence, eval/baselines) automatically run at `xhigh` effort.
   - Never exceed 2 rounds without user sign-off; on round 3+, present remaining blocking findings to the user.
```
