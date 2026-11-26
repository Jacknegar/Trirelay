<div align="center">

<img src="assets/logo.svg" alt="Trirelay logo" width="80" />

# Trirelay

**Host-Symmetric Multi-Agent Orchestration Relay for Antigravity (`agy`), Claude Code (`claude`), and OpenAI Codex (`codex`)**

[![Node.js >= 18.18](https://img.shields.io/badge/node-%3E%3D18.18-22C55E?style=flat-square&logo=node.js&logoColor=white&labelColor=0F172A)](#quick-start)
[![Runtime Dependencies: 0](https://img.shields.io/badge/runtime%20deps-0-38BDF8?style=flat-square&labelColor=0F172A)](#architecture)
[![Platforms: macOS | Linux](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-64748B?style=flat-square&labelColor=0F172A)](#platform--compatibility-notes)
[![MIT License](https://img.shields.io/badge/license-MIT-22C55E?style=flat-square&labelColor=0F172A)](LICENSE)

English · [简体中文](README.zh-CN.md) · [Quick Start](#quick-start) · [Benchmarks](#benchmarks) · [MCP & CLI Reference](#mcp--cli-reference) · [Changelog](CHANGELOG.md)

</div>

<br />

**Trirelay** (`trirelay`) is a zero-dependency local MCP server, CLI, and shared Skill bundle that connects **Google Antigravity (`agy`)**, **Claude Code (`claude`)**, and **OpenAI Codex (`codex`)** symmetrically. Whichever agent hosts your session acts as coordinator and safely dispatches, isolates, reviews, and hands off work to the other two—without losing pinned decisions, spilling MCP outputs to disk, or triggering recursive CLI loops.

| Tiered Board Memory | Cross-Engine Recall & Cache | MCP Inline Payload Cap | SessionStart Continuity |
| :---: | :---: | :---: | :---: |
| **-50.3%**<br><sub>`6,405 B → 3,182 B` · `5/5` pins intact</sub> | **5 / 5 intact**<br><sub>`codex → claude → agy` + `73.8%` cached input</sub> | **0 spills (-96.5%)**<br><sub>`28,203 B → 992 B` · `≤8.5 KB` cap</sub> | **526 ms** *(464 B)*<br><sub>Git + roles + handoff + board stubs</sub> |

---

## Why Trirelay?

Most multi-agent bridges either lock one tool in as permanent boss, bloat prompts with raw chat history (hurting cost and latency), or write unguarded edits directly into your working tree. Trirelay stays **small, practical, and zero-dependency**:

1. **True 3-Way Host Symmetry (6 Directed Paths)**
   - From **Antigravity**: delegates to `claude` & `codex`
   - From **Claude Code**: delegates to `agy` & `codex`
   - From **OpenAI Codex**: delegates to `agy` & `claude`
   Role routing (`advisor`, `implementer`, `reviewer`) excludes the active host automatically, strips nested host env vars (`CLAUDECODE`, `ANTIGRAVITY_*`, etc.), and enforces `TRIRELAY_DEPTH` recursion guards.
2. **Elephant vs. Goldfish Context Routing**
   - **Elephant (Shared Continuity)**: Implementation & multi-turn roles receive **Prefix-Cache-ordered** `<HANDOFF_PACKET>` files, **3-tier board views** (*Pin → 120-char programmatic Stub → On-Demand Recall*, zero extra LLM summary calls), and `resumeRole: true` incremental deltas.
   - **Goldfish (Zero-Context Audit)**: `relay_review`, `relay_review_gate`, and `relay_design(action="start")` run with **0 prior chat history** and **no author defense**—eliminating anchoring bias while slashing input tokens.
3. **Production Guardrails (Not Just Prompts)**
   - **Mandatory Isolated Worktrees (`mode: "write"`)**: Every write worker edits inside an isolated `git worktree`, captures uncommitted edits, untracked files, AND detached-HEAD commits into binary `.patch` files, audits `ownedFiles`/`forbiddenFiles` (including `--no-renames` source+target paths), and never touches your main checkout until you run `relay_apply(mode="apply")`.
   - **Sealed Dual-Track Design (`relay_design`)**: Keeps the host draft hashed & sealed until the independent advisor finishes, then reveals both with a 4-section merge template.
   - **Bounded 2-Round Review Gate (`relay_review_gate`)**: Separates `blocking` defects (requiring a concrete `trigger_path`) from `advisory` notes, auto-upgrades sensitive paths (`auth`, `billing`, `credentials`, `deploy`, `persistence`, `eval`) to `xhigh`, and escalates on round 3+.
   - **Spill-Free Bounded Async MCP**: `background: true` + `relay_jobs` prevents 3-minute MCP RPC timeouts; responses over `8.5 KB` are deterministically compacted with explicit `_recall` IDs.

---

## Architecture

```mermaid
flowchart LR
  Host["Active Host (agy / claude / codex)"] -->|"SessionStart (<1.5KB)"| Hook["scripts/session-hook.mjs"]
  Host -->|"MCP stdio / CLI"| Core["Trirelay Core (Node >=18.18, 0 deps)"]

  Core -->|"Elephant: Pin+Stub+Resume"| Elephant["relay_run / orchestrate / handoff / board"]
  Core -->|"Goldfish: 0-History Audit"| Goldfish["relay_design / review / review_gate / copy_review"]

  Elephant -->|"mode='write' -> git worktree"| WT["Isolated Worktree + .patch + Scope Audit"]
  Core -->|"≤8.5 KB JSON compactor"| Cap["Spill-Free Response + _recall ID"]

  Elephant & Goldfish --> Drivers["CLI Drivers: agy | claude (--strict-mcp-config) | codex (MCP isolated)"]
```

---

## Quick Start

### Prerequisites

- **Node.js** `>= 18.18.0` (Linux or macOS)
- **Git** (required for isolated write worktrees and diff reviews)
- At least two locally installed and authenticated CLIs: `agy`, `claude`, and/or `codex`

### Install

```bash
git clone https://github.com/Jacknegar/Trirelay.git
cd Trirelay

# 1. Check detected CLIs & auth readiness
node ./bin/trirelay.mjs doctor --json

# 2. Preview host registrations (dry-run by default; never overwrites CLAUDE.md/CODEX.md/GEMINI.md)
./scripts/install.sh --dry-run

# 3. Apply symlinks / MCP registrations for Antigravity, Claude Code, and Codex
./scripts/install.sh --apply
```

For **Claude Code 2.1.275+** marketplace installs:
```text
/plugin install trirelay --marketplace Jacknegar/Trirelay
```

### Per-Host Integration Matrix

| Host | Manifest / Config Included | Skills & Hook Integration |
|---|---|---|
| **Antigravity (`agy`)** | [`plugin.json`](plugin.json), [`mcp_config.json`](mcp_config.json) (7 eager core tools), [`hooks.json`](hooks.json), [`rules/AGENTS.md`](rules/AGENTS.md), [`agents/*.md`](agents) | [`skills/*/SKILL.md`](skills/trirelay/SKILL.md), `SessionStart` `injectSteps` |
| **Claude Code (`claude`)** | [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json), [`.mcp.json`](.mcp.json), [`hooks/hooks.json`](hooks/hooks.json) | `skills/*/SKILL.md`, `claude mcp add --scope user trirelay`, `SessionStart` `additionalContext` |
| **OpenAI Codex (`codex`)** | [`.codex-plugin/plugin.json`](.codex-plugin/plugin.json), [`.mcp.json`](.mcp.json) | `~/.codex/skills/*`, `codex mcp add trirelay` |

> **Optional User Rule**: Review [`docs/collaboration-snippet.md`](docs/collaboration-snippet.md) and manually add it to `~/.claude/CLAUDE.md`, `~/.codex/CODEX.md`, or `~/.gemini/GEMINI.md` if desired. Trirelay never mutates global prompt files automatically.

---

## MCP & CLI Reference

Every MCP tool has 1:1 CLI parity (`./bin/trirelay.mjs <subcommand>`):

| MCP Tool | CLI Equivalent | Purpose |
|---|---|---|
| `relay_setup` | `trirelay doctor` | Inspect `agy`, `claude`, `codex` readiness & host context |
| `relay_models` | `trirelay models` | Live model catalog, aliases & role profiles |
| `relay_route` | `trirelay route` | Preview host-aware role routing (`excludeHost: true`) |
| `relay_run` | `trirelay run` | Scoped worker execution (`mode="readonly"\|"write"`, `background`, `resumeRole`) |
| `relay_review` | `trirelay review` | Goldfish single or parallel cross-engine diff review |
| `relay_review_gate` | `trirelay review-gate` | Bounded 2-round blocking/advisory gate (`xhigh` on sensitive paths) |
| `relay_design` | `trirelay design` | Sealed dual-track architecture design (`start` / `submit-host` / `reveal`) |
| `relay_copy_review` | `trirelay copy-review` | Structured `location \| current \| problem \| suggestion` copy audit |
| `relay_orchestrate` | `trirelay teamwork\|boost\|swarm\|pipeline` | Multi-worker DAG/fan-out workflows with worktree isolation |
| `relay_apply` | `trirelay apply` | `git apply --check` / `git apply` for captured worktree patches |
| `relay_handoff` | `trirelay handoff` | Create/inspect prefix-ordered `<HANDOFF_PACKET>` artifacts |
| `relay_board` | `trirelay board` | Process-locked JSONL board (3-tier Pin/Stub/Recall by default, `view="full"` recall) |
| `relay_jobs` | `trirelay jobs` | `list` / `status` / `wait` / `result` (`compact=false` for raw output) / `cancel` |

### Environment Controls

- `TRIRELAY_AGY_BIN` / `TRIRELAY_CLAUDE_BIN` / `TRIRELAY_CODEX_BIN` / `TRIRELAY_NODE_BIN`: explicit binary overrides.
- `TRIRELAY_CODEX_MCP_ALLOW`: comma-separated Codex MCP server names to keep enabled for workers (by default, headless Codex workers disable configured `[mcp_servers.*]` via `-c` overrides to skip unrelated OAuth/remote MCP startup).
- `TRIRELAY_CODEX_KEEP_MCP=1`: keep all non-Trirelay Codex MCP servers enabled (`trirelay`/`trimesh` always remain disabled inside workers to prevent recursion).
- `TRIRELAY_MCP_MAX_BYTES`: MCP inline cap in bytes (default `8500`, clamped to `1024..65536`).
- `TRIRELAY_ALLOWED_ROOTS`: optional path-delimiter-separated allowlist restricting workspace paths.

---

## Benchmarks

All metrics below were measured locally using [`scripts/benchmark.mjs`](scripts/benchmark.mjs) on **Linux x64 (`Node.js v24.15.0`)** with **`claude 2.1.325`**, **`codex-cli 0.169.1`**, and **`agy 1.5.18`**:

```bash
# Deterministic offline check (~1s, safe for CI)
npm run benchmark

# Live multi-engine benchmark inside a disposable /tmp repo
node ./scripts/benchmark.mjs --live
```

### Measured Results

| Task / Comparison | Baseline (Naive) | Trirelay | Measured Outcome |
|---|---|---|---|
| **12-Post Cross-Engine Board** *(offline)* | `6,405 B` full dump | `3,182 B` (Pin + Stub) | **`-50.3%` bytes**, **`5/5` pinned `INV_*` intact** |
| **MCP Inline Cap vs Disk Spill** *(offline)* | `28,203 B` (`>8.8 KB` spill) | `992 B` (`_compacted` + `_recall`) | **`-96.5%` bytes**, **`0` spills** |
| **Prefix-Cache Header Stability** *(offline)* | Dynamic ordering | `488 B` static prefix first | **100% byte-identical across turns** |
| **SessionStart Continuity Hook** *(offline, 3 runs)* | Manual cold inspection | `598 / 496 / 526 ms` | **`526 ms` median**, **`464 B`** payload |
| **3-Hop Memory Relay** *(`codex → claude → agy`, live)* | Ad-hoc prompt copy | `<HANDOFF_PACKET>` + tiered board | **Codex `5/5`** (31.1 s), **Claude `5/5`** (8.5 s), **Agy `5/5`** (101.0 s) |
| **Codex `resumeRole` Turn 2 Delta** *(live)* | Full re-prompt (`46k+` uncached) | `58 B` delta prompt | **`5/5` recalled**, same session, **`73.8%` (`34,432 / 46,651`) cached input tokens** (`39.5 s`) |
| **Parallel Dual-Engine Review** *(`claude + codex`, live)* | `103,598 ms` serial sum | `93,817 ms` parallel wall-clock | **`-9.4%` wall time** (`claude` 11.2 s + `codex` 92.4 s; both flagged seeded bug: 4 findings) |
| **Isolated Worktree Write + Check** *(`claude`, live)* | Direct working-tree mutation | Detached `git worktree` + `.patch` | **`ok: true` (`11.7 s`)**, `0` scope violations, main tree untouched, `apply --check` passed |

> **Honest Note on Codex Cold-Start Variance**: Disabling user `[mcp_servers.*]` protects Codex workers from hanging on unauthenticated OAuth MCP endpoints and prevents recursive MCP loops. However, across two noisy live network runs (`gpt-6-luna@low` via remote proxy), raw cold-start wall time was still dominated by API proxy variance and Codex `[plugins.*]` (`naive`: `16.4 s / 40.5 s`, median `28.4 s`; `isolated`: `75.0 s / 56.2 s`, median `65.6 s`). Trirelay's speed advantages come primarily from **parallel fan-out**, **`resumeRole` delta sessions**, **prefix-cache ordering**, **zero-spill bounded outputs**, and **fast non-Codex routing (`claude` ~8.5–11.7 s)**—not magical elimination of network variance.

---

## Testing & Verification

```bash
npm run check                                   # Syntax check across all .mjs files
npm test                                        # 15 unit & integration suites (fake CLI + live git/MCP/locks)
sh -n scripts/mcp-launcher.sh scripts/hook-launcher.sh scripts/install.sh
```

Validated against host tooling:
- `agy plugin validate . --json` — **0 errors** (2 expected cross-host notices for Claude's `.mcp.json` and `hooks/hooks.json`)
- `claude plugin validate . --strict --json` — **`success: true`, 0 errors, 0 warnings**

## Platform & Compatibility Notes

- **Live-tested**: Linux x64 (`Ubuntu`, `Node v24.15.0`).
- **Statically reviewed for macOS**: Uses POSIX `sh` launchers with symlink resolution and Homebrew/nvm/fnm/volta discovery, atomic `mkdir` cross-process locks, and CI matrix verification on `macos-latest` ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)), but has not yet been executed directly on local macOS hardware.

## Acknowledgements

- Lightweight latency hygiene, `SessionStart` snapshot budgets, and strict `<8.8 KB` spill-prevention concepts were inspired by [**INK-Q/agy-fast**](https://github.com/INK-Q/agy-fast).
- Claude/Codex plugin interoperability patterns draw inspiration from [**openai/codex-plugin-cc**](https://github.com/openai/codex-plugin-cc).

## License

MIT — see [LICENSE](LICENSE).
