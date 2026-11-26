<div align="center">

<img src="assets/logo.svg" alt="Trirelay logo" width="80" />

# Trirelay

**面向 Antigravity (`agy`)、Claude Code (`claude`) 与 OpenAI Codex (`codex`) 的三端对等开源编排中继**

[![Node.js >= 18.18](https://img.shields.io/badge/node-%3E%3D18.18-22C55E?style=flat-square&logo=node.js&logoColor=white&labelColor=0F172A)](#快速开始)
[![Runtime Dependencies: 0](https://img.shields.io/badge/runtime%20deps-0-38BDF8?style=flat-square&labelColor=0F172A)](#核心架构)
[![Platforms: macOS | Linux](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-64748B?style=flat-square&labelColor=0F172A)](#平台兼容说明)
[![MIT License](https://img.shields.io/badge/license-MIT-22C55E?style=flat-square&labelColor=0F172A)](LICENSE)

[English](README.md) · 简体中文 · [快速开始](#快速开始) · [实测基准](#实测基准) · [工具清单](#mcp-与-cli-对照表) · [更新日志](CHANGELOG.md)

</div>

<br />

**Trirelay**（`trirelay`）是一个**零运行时依赖、简约耐用**的本地 MCP 服务 + CLI + 共享 Skill 集合，支持 Linux 与 macOS。**Antigravity (`agy`)、Claude Code (`claude`)、OpenAI Codex (`codex`) 中的任意一端都可以作为宿主主控**，实现**可追踪、可续跑、可校验的多轮跨代理交接**——将写操作隔离在独立 worktree 中，跨阶段继承显式约束、限制 MCP 返回体积并阻断循环自调用。

| 三层看板记忆 *(v1.1.0 离线)* | 跨端前缀与继承 *(v1.1.0 离线)* | MCP 内联防溢盘 *(v1.1.0 离线)* | SessionStart 快照 *(v1.1.0 离线)* |
| :---: | :---: | :---: | :---: |
| **-48.4%**<br><sub>`6,405 B → 3,305 B` · `5/5` 置顶约束完整</sub> | **前缀 + 链路 100%**<br><sub>`416 B` byte-0 静态前缀 · 多跳不变量保留</sub> | **0 次溢盘 (-96.5%)**<br><sub>`28,203 B → 992 B` · `≤8.5 KB` 保留 `blockingPreview`</sub> | **548 ms 中位** *(447 B)*<br><sub>Git + 可续跑角色 + 交接 + 置顶/Stub</sub> |

---

## 为什么选择 Trirelay？

1. **真·三端对称宿主（6 条有向路径）**
   - `agy → claude` / `agy → codex`
   - `claude → agy` / `claude → codex`
   - `codex → agy` / `codex → claude`
   按角色（`advisor` / `implementer` / `reviewer`）自动排除当前宿主，剥离嵌套环境变量（`CLAUDECODE`、`ANTIGRAVITY_*` 等），通过 `TRIRELAY_DEPTH` 严格阻断循环调用。
2. **大象-金鱼分流（可追踪衔接 + 降 Token）**
   - **大象路径（可续跑连续性）**：采用 **Byte-0 Prefix-Cache 排序**（静态 `<HANDOFF_CONTRACT>` 与固定约束置顶于分隔线之前，动态轮次上下文置底）、**三层看板索引**（*独立 `.pins.json` 置顶约束索引 → 120 字程序化 Stub → 省略告警与按序号/`view="full"` 召回*，零 LLM 二次摘要费用）、流水线 `parentHandoffId` 多跳约束继承（`invariants`、`decisionsMade`、`doNotRelitigate`、`forbiddenFiles` 及显式废弃标记）以及绑定 Worktree 的 `resumeRole: true` 增量续跑。
   - **金鱼路径（零历史抗锚定审查）**：`relay_review`、`relay_review_gate`、`relay_design(action="start")` 强制只接收原始需求或代码 diff，不看作者辩护和聊天历史，既防止锚定偏见，又大幅削减输入 Token。
3. **流程与作用域护栏（不只靠提示词）**
   - **写操作隔离 `git worktree` + 可恢复快照**：所有 `mode: "write"` 任务都在独立 Worktree 中执行，捕获未暂存修改、未跟踪文件、二进制与脱离 HEAD 的提交为 `.patch`（显式标注 `deliverableMode: "patch" | "ignored-only" | "none"`），并按 `--no-renames` 双向审计 `ownedFiles`/`forbiddenFiles`；未人工确认 `relay_apply(mode="apply")` 前绝不污染主工作区。`resumeRole: true` 续跑写角色时会重新绑定原 worktree 或将其 `.patch` 重放至 `baseSha`，无法恢复时直接报错失败。
   - **三端执行权限差异透明**：驱动按宿主能力与安全边界实施差异化控制——例如 `claude` 在 `mode: "write"` 下仅放行读写检索工具并**禁用 `Bash`**（`--disallowedTools Bash`），`codex` 使用 workspace-write 沙盒，`agy` 使用无头代理权限。
   - **不可变审查产物与周期化门禁（`relay_review` / `relay_review_gate`）**：双引擎审查结果持久化为不可变 `reviewId` 产物，支持零开销分页检视（`action: "inspect"`）；超过 `8.5 KB` 压缩阈值时仍保留 `blockingPreview[]`（`id`、`file`、`line`、`title`、`trigger`）；门禁显式区分 `blocking` 与 `advisory`，对敏感路径自动升 `xhigh`，并在通过后关闭当前周期以免后续无关审查误触发第 3 轮升级。
   - **双轨盲审设计（`relay_design`）**：先由独立顾问完成方案并封存，宿主再提交己方草案哈希后解锁四段式对照综合。
   - **异步有界 MCP（`≤8.5 KB`）**：支持 `background: true` + `relay_jobs` 避开 3 分钟超时；大输出自动压缩并附带可执行的 `_recall` 指针（显式传入 `inspect`/`pinsOnly`/`seqs`/`view="full"` 时放行全量召回）。

---

## 快速开始

### 环境要求

- **Node.js** `>= 18.18.0`（Linux / macOS）
- **Git**（隔离写入 Worktree 与 Diff 审查需要）
- 本地已安装并登录至少两个 CLI：`agy`、`claude`、`codex`

### 一键部署

```bash
git clone https://github.com/Jacknegar/Trirelay.git
cd Trirelay

# 1. 检测本地引擎与登录状态
node ./bin/trirelay.mjs doctor --json

# 2. 预览安装计划（默认 dry-run，绝不自动覆盖全局 CLAUDE.md/CODEX.md/GEMINI.md）
./scripts/install.sh --dry-run

# 3. 为 Antigravity、Claude Code、Codex 注册 MCP 与共享 Skills
./scripts/install.sh --apply
```

Claude Code 2.1.275+ 市场安装语法：
```text
/plugin install trirelay --marketplace Jacknegar/Trirelay
```

> **可选全局协作规则**：如需让宿主自动遵循统一协作流程，可参考 [`docs/collaboration-snippet.md`](docs/collaboration-snippet.md) 手动合并到 `~/.claude/CLAUDE.md`、`~/.codex/CODEX.md` 或 `~/.gemini/GEMINI.md`。

---

## MCP 与 CLI 对照表

所有 MCP 工具与 CLI（`./bin/trirelay.mjs`）100% 功能对等：

| MCP 工具 | CLI 命令 | 说明 |
|---|---|---|
| `relay_setup` | `trirelay doctor` | 检查三端可执行文件与登录态 |
| `relay_models` | `trirelay models` | 列出模型目录、别名与角色路由策略 |
| `relay_route` | `trirelay route` | 预览宿主感知的角色路由结果 |
| `relay_run` | `trirelay run` | 执行单任务（`readonly`/`write`、`background`、`resumeRole`） |
| `relay_review` | `trirelay review` | 金鱼零历史双引擎并行审查 |
| `relay_review_gate` | `trirelay review-gate` | 两轮有界门禁（敏感路径自动升 `xhigh`） |
| `relay_design` | `trirelay design` | 双轨抗锚定架构设计（`start`/`submit-host`/`reveal`） |
| `relay_copy_review` | `trirelay copy-review` | UI 文案/README 结构化审查表 |
| `relay_orchestrate` | `trirelay teamwork\|boost\|swarm\|pipeline` | 多任务分解、共识交叉批评、DAG 蜂群与流水线 |
| `relay_apply` | `trirelay apply` | 校验（`check`）或应用（`apply`）隔离区 `.patch` |
| `relay_handoff` | `trirelay handoff` | 创建/查看前缀优化 `<HANDOFF_PACKET>` 与作用域会话 |
| `relay_board` | `trirelay board` | 跨进程加锁共享看板（默认三层摘要视图，`view="full"` 取原文） |
| `relay_jobs` | `trirelay jobs` | `list` / `status` / `wait` / `result`（`compact=false` 全量取回）/ `cancel` |

---

## 实测基准

以下离线指标来自 `v1.1.0` 本地 [`scripts/benchmark.mjs`](scripts/benchmark.mjs) 的确定性验证；下方历史在线对比项为 `v1.0.0` 在 **Linux x64 (`Node.js v24.15.0`)**、**`claude 2.1.325`**、**`codex-cli 0.169.1`**、**`agy 1.5.18`** 上的单次真实记录，不随每次离线检查自动重跑：

```bash
# 离线确定性验证（约 1 秒，适合 CI）
npm run benchmark

# 临时 /tmp 仓库中的三端真机对比测试
node ./scripts/benchmark.mjs --live
```

### 离线组件校验（`v1.1.0`）

| 对比项目 | 基线 / 朴素做法 | Trirelay 方案 (`v1.1.0`) | 实测结果 |
|---|---|---|---|
| **12 条跨端协作看板** | `6,405 B` 全量平铺 | `3,305 B`（活跃置顶索引 + Stub + 召回提示） | **体积下降 `48.4%`**，**`5/5` 关键约束完整** |
| **MCP 防溢盘压缩** | `28,203 B`（超过 `8.8 KB` 触发溢盘） | `992 B`（`_compacted` + `_recall` + `blockingPreview`） | **体积下降 `96.5%`**，**`0` 次溢盘** |
| **Byte-0 前缀与链式继承** | 动态混排 / 无继承 | `416 B` byte-0 静态前缀 + 多跳继承链 | **跨轮次 byte-0 100% 一致**，**`chainedInheritanceIntact: true`** |
| **SessionStart 启动注入** *(3 次)* | 人工冷探索 | `548 / 813 / 522 ms` | **中位 `548 ms`**，快照仅 **`447 B`** |

### 历史单次实机记录（`v1.0.0` 参考）

| 对比项目 | 基线参考 | Trirelay 方案 | `v1.0.0` 单次记录 |
|---|---|---|---|
| **三端跨引擎接力召回** *(`codex → claude → agy`)* | 人工复制粘贴上下文 | `<HANDOFF_PACKET>` + 分层看板 | **Codex `5/5`** (31.1 s)、**Claude `5/5`** (8.5 s)、**Agy `5/5`** (101.0 s) |
| **Codex `resumeRole` 二轮增量** | 整包重传 | 仅传 `58 B` 增量指令 | **`5/5` 召回**、复用同会话、**`73.8%` (`34,432 / 46,651`) 输入缓存命中**（39.5 s） |
| **双引擎并行审查** *(`claude + codex`)* | `103,598 ms` *(两次单端耗时估算总和 `serialSum`)* | 并行 `93,817 ms` | 并行完成 **(`claude` 11.2 s + `codex` 92.4 s)**，双方均命中预设缺陷，共 4 条发现 |
| **隔离 Worktree 写入与校验** *(`claude`)* | 直接改工作区 | 独立 `worktree` + `.patch` | **`ok: true` (`11.7 s`)**、0 越界、主目录零污染、`apply --check` 通过 |

> **关于波动与冷启动开销的客观说明**：默认禁用外部 `[mcp_servers.*]` 能防止 Codex worker 卡在无效 OAuth MCP 上并杜绝递归；但在本地带网络代理与内置 `[plugins.*]` 的环境下，两次 `gpt-6-luna@low` 实测耗时的主要波动来自远端网络代理与插件本身（朴素 `16.4 s / 40.5 s`，隔离 `75.0 s / 56.2 s`）。真正带来稳定收益的是**并行 Fan-out**、**`resumeRole` 增量会话**、**Byte-0 前缀顺序**、**零溢盘返回**以及**轻量任务直走低延迟 CLI**——而非消除上游模型与网络波动。

---

## 平台兼容说明

- **实机验证**：Linux x64（`Node v24`），已通过 16 组全量测试（含 R1–R7 闭环回归，[`test/run-tests.mjs`](test/run-tests.mjs)）、`agy plugin validate`（0 错误）和 `claude plugin validate --strict`（`success: true`，0 错误 0 警告）。
- **macOS 静态审计**：遵循 POSIX `sh`（含软链解析与 Homebrew/nvm/fnm/volta 路径发现）及标准 Node API，并在 CI 配置 `macos-latest`，但尚未在物理 macOS 机器上本地实机运行。

## 致谢

- 轻量低延迟规范、`SessionStart` 快照预算与严格防溢盘理念灵感来自 [**INK-Q/agy-fast**](https://github.com/INK-Q/agy-fast)。
- Claude Code 与 Codex 插件双向互操作模式借鉴自 [**openai/codex-plugin-cc**](https://github.com/openai/codex-plugin-cc)。

## 开源协议

MIT — 详见 [LICENSE](LICENSE)。
