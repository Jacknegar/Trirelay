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

**Trirelay**（`trirelay`）是一个**零运行时依赖、简约耐用**的本地 MCP 服务 + CLI + 共享 Skill 集合，支持 Linux 与 macOS。**Antigravity (`agy`)、Claude Code (`claude`)、OpenAI Codex (`codex`) 中的任意一端都可以作为宿主主控**，安全调用、隔离写入、并行审查与平滑衔接其余两端——同时保证关键决策不丢失、MCP 返回不溢盘、进程不递归自调用。

| 三层看板记忆 | 跨引擎记忆召回与前缀缓存 | MCP 内联防溢盘 | SessionStart 上下文快照 |
| :---: | :---: | :---: | :---: |
| **-50.3%**<br><sub>`6,405 B → 3,182 B` · `5/5` 关键约束零丢失</sub> | **5 / 5 完整传递**<br><sub>`codex → claude → agy` + `73.8%` 缓存命中</sub> | **0 次溢盘 (-96.5%)**<br><sub>`28,203 B → 992 B` · 严守 `≤8.5 KB` 上限</sub> | **526 ms** *(464 B)*<br><sub>Git 状态 + 可续跑角色 + 交接包 + 看板摘要</sub> |

---

## 为什么选择 Trirelay？

1. **真·三端对称宿主（6 条有向路径）**
   - `agy → claude` / `agy → codex`
   - `claude → agy` / `claude → codex`
   - `codex → agy` / `codex → claude`
   按角色（`advisor` / `implementer` / `reviewer`）自动排除当前宿主，剥离嵌套环境变量（`CLAUDECODE`、`ANTIGRAVITY_*` 等），通过 `TRIRELAY_DEPTH` 严格阻断循环调用。
2. **大象-金鱼分流（简约高效同步 + 降 Token）**
   - **大象路径（长程衔接）**：采用 **Prefix-Cache 友好排序**（静态契约与固定约束置顶，动态看板和摘要置底）、**三层程序化看板记忆**（*固定 `[decision]`/`[pin]` → 120 字程序化 Stub → 按 ID 召回*，零 LLM 二次摘要费用）以及 `resumeRole: true` 增量续跑。
   - **金鱼路径（零历史抗锚定审查）**：`relay_review`、`relay_review_gate`、`relay_design(action="start")` 强制只接收原始需求或代码 diff，不看作者辩护和聊天历史，既防止锚定偏见，又大幅削减输入 Token。
3. **代码级护栏（不只靠提示词）**
   - **写操作强制隔离 `git worktree`**：所有 `mode: "write"` 任务都在独立 Worktree 中执行，无损捕获未暂存修改、未跟踪文件、二进制与脱离 HEAD 的提交为 `.patch`，并按 `--no-renames` 双向审计 `ownedFiles`/`forbiddenFiles`；未人工确认 `relay_apply(mode="apply")` 前绝不污染主工作区。
   - **双轨盲审设计（`relay_design`）**：先由独立顾问完成方案并封存，宿主再提交己方草案哈希后解锁四段式对照综合。
   - **有界两轮审查门禁（`relay_review_gate`）**：区分 `blocking`（必须附具体 `trigger_path`）与 `advisory`；敏感路径（`auth`、`billing`、`credentials`、`deploy`、`persistence`、`eval`）自动升级 `xhigh`，第 3 轮直接上报用户拍板。
   - **异步有界 MCP（`≤8.5 KB`）**：支持 `background: true` + `relay_jobs` 避开 3 分钟超时；大输出自动压缩并附带 `_recall` 召回指令（可用 `compact=false` 取回全文）。

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

以下数据全部来自 [`scripts/benchmark.mjs`](scripts/benchmark.mjs) 在 **Linux x64 (`Node.js v24.15.0`)**、**`claude 2.1.325`**、**`codex-cli 0.169.1`**、**`agy 1.5.18`** 上的真实测量（零虚构或推算）：

```bash
# 离线确定性验证（约 1 秒，适合 CI）
npm run benchmark

# 临时 /tmp 仓库中的三端真机对比测试
node ./scripts/benchmark.mjs --live
```

| 对比项目 | 基线 / 朴素做法 | Trirelay 方案 | 实测结果 |
|---|---|---|---|
| **12 条跨端协作看板** *(离线)* | `6,405 B` 全量平铺 | `3,182 B`（固定区 + Stub） | **体积下降 `50.3%`**，**`5/5` 关键约束完整** |
| **MCP 防溢盘压缩** *(离线)* | `28,203 B`（超过 `8.8 KB` 触发溢盘） | `992 B`（`_compacted` + `_recall`） | **体积下降 `96.5%`**，**`0` 次溢盘** |
| **前缀缓存稳定性** *(离线)* | 动态内容混合 | `488 B` 静态前缀置顶 | **跨轮次 100% 字节一致** |
| **SessionStart 启动注入** *(离线 3 次)* | 人工冷探索 | `598 / 496 / 526 ms` | **中位 `526 ms`**，快照仅 **`464 B`** |
| **三端跨引擎接力召回** *(`codex → claude → agy` 实测)* | 人工复制粘贴上下文 | `<HANDOFF_PACKET>` + 分层看板 | **Codex `5/5`** (31.1 s)、**Claude `5/5`** (8.5 s)、**Agy `5/5`** (101.0 s) |
| **Codex `resumeRole` 二轮增量** *(实测)* | 整包重传 | 仅传 `58 B` 增量指令 | **`5/5` 召回**、复用同会话、**`73.8%` (`34,432 / 46,651`) 输入缓存命中**（39.5 s） |
| **双引擎并行审查** *(`claude + codex` 实测)* | 串行总和 `103,598 ms` | 并行 `93,817 ms` | **缩短 `9.4%`**（`claude` 11.2 s + `codex` 92.4 s，双方均命中预设缺陷，共 4 条发现） |
| **隔离 Worktree 写入与校验** *(`claude` 实测)* | 直接改工作区 | 独立 `worktree` + `.patch` | **`ok: true` (`11.7 s`)**、0 越界、主目录零污染、`apply --check` 通过 |

> **关于 Codex 冷启动隔离的客观说明**：默认禁用外部 `[mcp_servers.*]` 能防止 Codex worker 卡在无效 OAuth MCP 上并杜绝递归；但在本地带网络代理与内置 `[plugins.*]` 的环境下，两次 `gpt-6-luna@low` 实测耗时的主要波动来自远端网络代理与插件本身（朴素 `16.4 s / 40.5 s`，隔离 `75.0 s / 56.2 s`）。真正带来稳定提速的是**并行 Fan-out**、**`resumeRole` 增量会话**、**前缀缓存命中**、**零溢盘返回**以及**轻量任务直走低延迟引擎（`claude` 8.5–11.7 s）**。

---

## 平台兼容说明

- **实机验证**：Linux x64（`Node v24.15.0`），已通过 15 组全量测试（`npm test`）、`agy plugin validate`（0 错误）和 `claude plugin validate --strict`（`success: true`，0 错误 0 警告）。
- **macOS 静态审计**：遵循 POSIX `sh`（含软链解析与 Homebrew/nvm/fnm/volta 路径发现）及标准 Node API，并在 CI 配置 `macos-latest`，但尚未在物理 macOS 机器上本地实机运行。

## 致谢

- 轻量低延迟规范、`SessionStart` 快照预算与严格防溢盘理念灵感来自 [**INK-Q/agy-fast**](https://github.com/INK-Q/agy-fast)。
- Claude Code 与 Codex 插件双向互操作模式借鉴自 [**openai/codex-plugin-cc**](https://github.com/openai/codex-plugin-cc)。

## 开源协议

MIT — 详见 [LICENSE](LICENSE)。
