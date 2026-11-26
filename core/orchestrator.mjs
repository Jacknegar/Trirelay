import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runAgyTurn } from "./drivers/agy.mjs";
import { runClaudeTurn } from "./drivers/claude.mjs";
import { runCodexNativeReview, runCodexTurn } from "./drivers/codex.mjs";
import {
  VALID_ENGINES,
  getMaxRecursionDepth,
  getRecursionDepth,
  normalizeEngineName,
  resolveHost,
  resolvePathInsideWorkspace,
  resolveWorkspaceRoot,
  runSync
} from "./env.mjs";
import {
  buildWorkerResultToHandoff,
  createHandoffPacket,
  formatTieredBoardDigest,
  loadHandoffPacket,
  renderHandoffMarkdown
} from "./handoff.mjs";
import { loadRoutingConfig, resolveRoute } from "./router.mjs";
import {
  acquireSessionLease,
  appendJobLog,
  generateId,
  isInsideManagedWorktree,
  loadDesignVault,
  lookupRoleSession,
  nowIso,
  postBoardMessage,
  readJsonSafe,
  recordRoleSession,
  releaseSessionLease,
  resolveJobLogFile,
  saveDesignVault,
  saveReviewGateState,
  updateDesignVault,
  upsertJob,
  validateOpaqueId,
  withReviewGateLock
} from "./state.mjs";
import {
  auditFileScope,
  captureWorktreeChanges,
  createIsolatedWorktree,
  isGitRepo,
  removeIsolatedWorktree
} from "./worktree.mjs";

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = readJsonSafe(path.join(PACKAGE_ROOT, "schemas", "review-output.schema.json"));
const WORKER_SCHEMA = readJsonSafe(path.join(PACKAGE_ROOT, "schemas", "worker-result.schema.json"));
const COPY_REVIEW_SCHEMA = readJsonSafe(path.join(PACKAGE_ROOT, "schemas", "copy-review.schema.json"));

const BLOCKED_CALLER_KEYS = new Set([
  "sandbox",
  "permissionMode",
  "allowedTools",
  "disallowedTools",
  "jobId",
  "dangerouslySkipPermissions",
  "_internalJobId",
  "_internalLogFile",
  "signal"
]);

export function assertRecursionSafe(cwd = process.cwd()) {
  const depth = getRecursionDepth();
  const maxDepth = getMaxRecursionDepth();
  if (depth >= maxDepth) {
    throw new Error(
      `Trirelay recursion guard blocked nested delegation (TRIRELAY_DEPTH=${depth} >= TRIRELAY_MAX_DEPTH=${maxDepth}). Finish your scoped task directly without re-delegating.`
    );
  }
  if (isInsideManagedWorktree(cwd)) {
    throw new Error(
      `Trirelay recursion guard blocked nested delegation from inside a managed worker worktree (${cwd}).`
    );
  }
}

export function validateCallerArgs(params = {}) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Arguments must be a JSON object.");
  }
  for (const forbidden of BLOCKED_CALLER_KEYS) {
    if (params[forbidden] !== undefined) {
      throw new Error(`Security error: caller-supplied "${forbidden}" is not permitted; policy is derived from mode.`);
    }
  }
  if (params.engine !== undefined && params.engine !== null) {
    if (!normalizeEngineName(params.engine) && params.engine !== "both") {
      throw new Error(`Invalid engine "${params.engine}". Valid engines: ${VALID_ENGINES.join(", ")}.`);
    }
  }
  if (params.mode !== undefined && params.mode !== null && params.mode !== "readonly" && params.mode !== "write") {
    throw new Error(`Invalid mode "${params.mode}". Must be "readonly" or "write".`);
  }
  if (params.handoffId) {
    validateOpaqueId(params.handoffId, "handoffId");
  }
  if (params.workflowId) {
    validateOpaqueId(params.workflowId, "workflowId");
  }
  if (params.boardId) {
    validateOpaqueId(params.boardId, "boardId");
  }
  if (params.resumeSessionId) {
    validateOpaqueId(params.resumeSessionId, "resumeSessionId");
  }
  for (const arrKey of ["ownedFiles", "forbiddenFiles", "invariants", "acceptanceCriteria", "contextPaths", "models"]) {
    if (params[arrKey] !== undefined && params[arrKey] !== null) {
      if (!Array.isArray(params[arrKey]) || !params[arrKey].every((item) => typeof item === "string")) {
        throw new Error(`Invalid "${arrKey}": must be an array of strings.`);
      }
    }
  }
}

class ConcurrencyPool {
  constructor(maxGlobal = 4, maxPerEngine = 2) {
    this.maxGlobal = Math.max(1, maxGlobal);
    this.maxPerEngine = Math.max(1, maxPerEngine);
    this.activeGlobal = 0;
    this.activeByEngine = { agy: 0, codex: 0, claude: 0 };
    this.waiters = [];
  }

  async run(engine, fn) {
    await this.acquire(engine);
    try {
      return await fn();
    } finally {
      this.release(engine);
    }
  }

  acquire(engine) {
    if (this.canRun(engine)) {
      this.activeGlobal += 1;
      this.activeByEngine[engine] = (this.activeByEngine[engine] ?? 0) + 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push({ engine, resolve });
    });
  }

  canRun(engine) {
    return this.activeGlobal < this.maxGlobal && (this.activeByEngine[engine] ?? 0) < this.maxPerEngine;
  }

  release(engine) {
    this.activeGlobal = Math.max(0, this.activeGlobal - 1);
    this.activeByEngine[engine] = Math.max(0, (this.activeByEngine[engine] ?? 1) - 1);
    for (let i = 0; i < this.waiters.length; i += 1) {
      const waiter = this.waiters[i];
      if (this.canRun(waiter.engine)) {
        this.waiters.splice(i, 1);
        this.activeGlobal += 1;
        this.activeByEngine[waiter.engine] = (this.activeByEngine[waiter.engine] ?? 0) + 1;
        waiter.resolve();
        return;
      }
    }
  }
}

async function executeWithEngine(target, params) {
  if (target.engine === "agy") {
    return runAgyTurn({
      cwd: params.cwd,
      prompt: params.prompt,
      model: target.model,
      effort: target.effort,
      mode: params.mode,
      resumeSessionId: params.resumeSessionId,
      outputSchema: params.outputSchema,
      appendSystemPrompt: params.appendSystemPrompt,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
      onProgress: params.onProgress
    });
  }
  if (target.engine === "codex") {
    return runCodexTurn({
      cwd: params.cwd,
      prompt: params.prompt,
      model: target.model,
      effort: target.effort,
      mode: params.mode,
      resumeSessionId: params.resumeSessionId,
      forkSession: params.forkSession,
      outputSchema: params.outputSchema,
      appendSystemPrompt: params.appendSystemPrompt,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
      onProgress: params.onProgress
    });
  }
  if (target.engine === "claude") {
    return runClaudeTurn({
      cwd: params.cwd,
      prompt: params.prompt,
      model: target.model,
      effort: target.effort,
      fallbackModel: params.fallbackModel,
      mode: params.mode,
      resumeSessionId: params.resumeSessionId,
      forkSession: params.forkSession,
      outputSchema: params.outputSchema,
      appendSystemPrompt: params.appendSystemPrompt,
      maxBudgetUsd: params.maxBudgetUsd,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
      onProgress: params.onProgress
    });
  }
  throw new Error(`Unsupported engine "${target.engine}".`);
}

export async function runSingleTask(cwd, params = {}, internalOpts = {}) {
  assertRecursionSafe(cwd);
  validateCallerArgs(params);

  const signal = internalOpts.signal ?? null;
  if (signal?.aborted) {
    return {
      ok: false,
      cancelled: true,
      error: "Cancelled before start."
    };
  }

  const cleanPrompt = String(params.prompt ?? "").trim();
  if (!cleanPrompt) {
    throw new Error("`prompt` is required and must be non-empty.");
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const workflowId = params.workflowId || "default";
  const role = params.role || "worker";
  const mode = params.mode === "write" ? "write" : "readonly";
  const host = resolveHost(params.host);
  const jobId = internalOpts.jobId ? validateOpaqueId(internalOpts.jobId, "jobId") : generateId("run");
  const logFile = internalOpts.logFile || resolveJobLogFile(workspaceRoot, jobId);

  const route = resolveRoute({
    profile: params.profile,
    spec: params.spec,
    engine: params.engine,
    model: params.model,
    effort: params.effort,
    prompt: cleanPrompt,
    mode,
    host,
    excludeHost: params.excludeHost !== false,
    authorEngine: params.authorEngine,
    strict: Boolean(params.strictEffort)
  });

  if (route.fanout) {
    throw new Error(
      `Profile "${route.profile}" is a fan-out profile. Use relay_orchestrate or relay_review instead of relay_run.`
    );
  }

  // Mandatory worktree isolation for write mode; callers cannot bypass it.
  if (mode === "write" && params.worktree === false) {
    throw new Error('Security error: mode="write" always requires isolated git worktree (`worktree` cannot be false).');
  }
  const useWorktree = mode === "write" ? true : Boolean(params.worktree);
  let worktree = null;
  let effectiveCwd = workspaceRoot;

  if (useWorktree) {
    if (!isGitRepo(workspaceRoot)) {
      throw new Error(
        `Isolated git worktree required for mode="${mode}" (or worktree=true), but "${workspaceRoot}" is not a git repository.`
      );
    }
    worktree = createIsolatedWorktree(workspaceRoot, {
      id: `${role}-${jobId}`.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 72),
      branch: params.worktreeBranch || null
    });
    effectiveCwd = worktree.worktreePath;
    appendJobLog(logFile, `Created isolated worktree at ${worktree.worktreePath} (base=${worktree.baseSha})`);
  }

  let leaseAcquired = false;
  let leasedEngine = null;
  let leasedSessionId = null;

  upsertJob(workspaceRoot, {
    id: jobId,
    kind: "run",
    workflowId,
    role,
    mode,
    status: "running",
    engine: route.primary.engine,
    model: route.primary.model,
    effort: route.primary.effort,
    worktreePath: worktree?.worktreePath ?? null,
    logFile,
    startedAt: nowIso()
  });

  try {
    let handoffInfo = null;
    let fullPrompt = cleanPrompt;
    let ownedFiles = Array.isArray(params.ownedFiles) ? [...params.ownedFiles] : [];
    let forbiddenFiles = Array.isArray(params.forbiddenFiles) ? [...params.forbiddenFiles] : ["docs/handoff.md"];

    const isGoldfish =
      role === "reviewer" ||
      role.endsWith("-reviewer") ||
      role === "advisor" ||
      role === "copy-reviewer" ||
      role === "cross-verifier";
    const wantBoardDigest =
      typeof params.includeBoardDigest === "boolean"
        ? params.includeBoardDigest
        : Boolean(params.boardId && !isGoldfish);

    if (params.handoffId) {
      const loaded = loadHandoffPacket(workspaceRoot, params.handoffId);
      if (!loaded) {
        throw new Error(`Handoff packet "${params.handoffId}" not found.`);
      }
      handoffInfo = { packet: loaded };
      // Inherit loaded handoff's scope ownership rules for post-run audit.
      if (Array.isArray(loaded.scope?.ownedFiles) && loaded.scope.ownedFiles.length > 0) {
        ownedFiles = [...new Set([...ownedFiles, ...loaded.scope.ownedFiles])];
      }
      if (Array.isArray(loaded.scope?.forbiddenFiles) && loaded.scope.forbiddenFiles.length > 0) {
        forbiddenFiles = [...new Set([...forbiddenFiles, ...loaded.scope.forbiddenFiles])];
      }
      fullPrompt = `${renderHandoffMarkdown(loaded)}\n\n${fullPrompt}`;
    } else if (
      params.handoff ||
      params.includeHostDigest ||
      params.includeAgyDigest ||
      params.includeRepoHandoff ||
      params.includeBoardDigest ||
      ownedFiles.length > 0 ||
      params.invariants?.length ||
      params.acceptanceCriteria?.length ||
      worktree
    ) {
      handoffInfo = createHandoffPacket(workspaceRoot, {
        workflowId,
        boardId: params.boardId || workflowId,
        fromHost: host,
        fromEngine: params.fromEngine || host,
        toEngine: route.primary.engine,
        role,
        goal: params.goal || cleanPrompt.slice(0, 240),
        ownedFiles,
        forbiddenFiles,
        worktreePath: worktree?.worktreePath ?? null,
        invariants: params.invariants ?? [],
        decisionsMade: params.decisionsMade ?? [],
        doNotRelitigate: params.doNotRelitigate ?? [],
        openQuestions: params.openQuestions ?? [],
        verification: params.verification ?? [],
        contextDigest: params.contextDigest ?? "",
        evidence: params.evidence ?? [],
        acceptanceCriteria: params.acceptanceCriteria ?? [],
        includeHostDigest: Boolean(params.includeHostDigest || params.includeAgyDigest),
        includeRepoHandoff: Boolean(params.includeRepoHandoff),
        includeBoardDigest: wantBoardDigest
      });
      fullPrompt = `${renderHandoffMarkdown(handoffInfo.packet)}\n\n${fullPrompt}`;
    } else if (wantBoardDigest && params.boardId) {
      const bDigest = formatTieredBoardDigest(workspaceRoot, params.boardId);
      if (bDigest) {
        fullPrompt = `<BOARD_CONTINUITY>\n${bDigest}\n</BOARD_CONTINUITY>\n\n${fullPrompt}`;
      }
    }

    let resumeSessionId = params.resumeSessionId || null;
    let sessionCwd = null;
    if (!resumeSessionId && params.resumeRole) {
      const entry = lookupRoleSession(workspaceRoot, {
        workflowId,
        role,
        engine: route.primary.engine
      });
      if (entry?.sessionId) {
        resumeSessionId = entry.sessionId;
        sessionCwd = entry.sessionCwd ?? null;
      }
    }

    if (!worktree && resumeSessionId && sessionCwd && fs.existsSync(sessionCwd)) {
      effectiveCwd = sessionCwd;
    }

    // Only Claude and Codex actually fork sessions; agy always requires single-writer lease.
    const willFork = Boolean(params.forkSession) && (route.primary.engine === "claude" || route.primary.engine === "codex");
    if (resumeSessionId && !willFork) {
      leaseAcquired = acquireSessionLease(workspaceRoot, route.primary.engine, resumeSessionId, jobId);
      if (!leaseAcquired) {
        throw new Error(
          `Session "${resumeSessionId}" (${route.primary.engine}) already has an active writer; use a fresh session or an engine supporting fork.`
        );
      }
      leasedEngine = route.primary.engine;
      leasedSessionId = resumeSessionId;
    }

    const onProgress = (msg) => appendJobLog(logFile, msg);
    const candidates = [route.primary, ...(params.allowFallback === false ? [] : route.fallback)];
    let finalResult = null;
    let usedTarget = route.primary;
    const attempts = [];

    for (let i = 0; i < candidates.length; i += 1) {
      if (signal?.aborted) {
        break;
      }
      const target = candidates[i];
      usedTarget = target;
      appendJobLog(logFile, `Attempt ${i + 1}: ${target.engine}:${target.model ?? "default"}@${target.effort ?? "default"}`);
      const res = await executeWithEngine(target, {
        cwd: effectiveCwd,
        prompt: fullPrompt,
        mode,
        resumeSessionId: i === 0 ? resumeSessionId : null,
        forkSession: Boolean(params.forkSession),
        outputSchema: params.outputSchema ?? null,
        appendSystemPrompt: params.appendSystemPrompt ?? null,
        fallbackModel: params.fallbackModel ?? null,
        maxBudgetUsd: params.maxBudgetUsd ?? null,
        timeoutMs: params.timeoutMs ?? 600000,
        signal,
        onProgress
      });

      attempts.push({
        engine: target.engine,
        model: res.model || target.model,
        effort: target.effort,
        ok: res.ok,
        incomplete: Boolean(res.incomplete),
        preDispatchFailure: Boolean(res.preDispatchFailure),
        durationMs: res.durationMs,
        error: res.error
      });

      finalResult = res;
      if (res.ok) {
        break;
      }

      if (i < candidates.length - 1 && res.preDispatchFailure) {
        appendJobLog(logFile, `Pre-dispatch fallback triggered after error: ${res.error}`);
        continue;
      }
      break;
    }

    if (signal?.aborted && !finalResult) {
      finalResult = {
        ok: false,
        cancelled: true,
        engine: usedTarget.engine,
        model: usedTarget.model,
        effort: usedTarget.effort,
        sessionId: null,
        output: "",
        structuredOutput: null,
        touchedFiles: [],
        error: "Cancelled by caller."
      };
    }

    let worktreeDiff = {
      hasChanges: false,
      captureComplete: true,
      error: null,
      changedFiles: [],
      ignoredFiles: [],
      patchPath: null,
      diffStat: "",
      finalHeadSha: null
    };
    let scopeViolations = [];

    if (worktree) {
      worktreeDiff = captureWorktreeChanges(workspaceRoot, worktree.worktreePath, worktree.worktreeId, worktree.baseSha);
      const auditedFiles = [...new Set([...(worktreeDiff.changedFiles ?? []), ...(worktreeDiff.ignoredFiles ?? [])])];
      if (auditedFiles.length > 0) {
        scopeViolations = auditFileScope(auditedFiles, { ownedFiles, forbiddenFiles });
      }
      if (worktreeDiff.captureComplete && !worktreeDiff.hasChanges && params.keepEmptyWorktree !== true) {
        removeIsolatedWorktree(workspaceRoot, worktree.worktreePath);
        appendJobLog(logFile, "Removed empty worktree (no file changes).");
      }
    }

    if (finalResult?.sessionId) {
      recordRoleSession(workspaceRoot, {
        workflowId,
        role,
        engine: usedTarget.engine,
        sessionId: finalResult.sessionId,
        sessionCwd: effectiveCwd,
        model: finalResult.model || usedTarget.model,
        effort: usedTarget.effort
      });
    }

    const captureFailed = Boolean(worktree && !worktreeDiff.captureComplete);
    const overallOk = Boolean(finalResult?.ok) && !captureFailed && scopeViolations.length === 0 && !signal?.aborted;
    const combinedError =
      [
        signal?.aborted ? "Cancelled by caller." : null,
        finalResult?.error,
        captureFailed ? `Worktree capture incomplete: ${worktreeDiff.error}` : null,
        scopeViolations.length ? `Scope violation(s): ${scopeViolations.join("; ")}` : null
      ]
        .filter(Boolean)
        .join(" | ") || null;

    const normalized = {
      ...finalResult,
      ok: overallOk,
      cancelled: Boolean(signal?.aborted || finalResult?.cancelled),
      error: combinedError,
      jobId,
      workflowId,
      role,
      mode,
      routingDecision: {
        source: route.source,
        host: route.host,
        profile: route.profile,
        reason: route.reason,
        selected: `${usedTarget.engine}${usedTarget.model ? `:${usedTarget.model}` : ""}${usedTarget.effort ? `@${usedTarget.effort}` : ""}`,
        attempts
      },
      handoffId: handoffInfo?.packet?.handoffId ?? null,
      handoffMdPath: handoffInfo?.mdPath ?? null,
      worktreePath:
        worktree && (worktreeDiff.hasChanges || !worktreeDiff.captureComplete || params.keepEmptyWorktree)
          ? worktree.worktreePath
          : null,
      baseSha: worktree?.baseSha ?? null,
      finalHeadSha: worktreeDiff.finalHeadSha,
      patchPath: worktreeDiff.patchPath,
      diffStat: worktreeDiff.diffStat,
      changedFiles: worktreeDiff.changedFiles.length ? worktreeDiff.changedFiles : finalResult?.touchedFiles ?? [],
      ignoredFiles: worktreeDiff.ignoredFiles ?? [],
      scopeViolations
    };

    upsertJob(workspaceRoot, {
      id: jobId,
      status: normalized.cancelled ? "cancelled" : normalized.ok ? "completed" : "failed",
      completedAt: nowIso(),
      engine: usedTarget.engine,
      model: normalized.model,
      effort: normalized.effort,
      sessionId: normalized.sessionId,
      worktreePath: normalized.worktreePath,
      patchPath: normalized.patchPath,
      finalHeadSha: normalized.finalHeadSha,
      changedFiles: normalized.changedFiles,
      scopeViolations: normalized.scopeViolations,
      handoffId: normalized.handoffId,
      routingDecision: normalized.routingDecision,
      output: normalized.output,
      structuredOutput: normalized.structuredOutput,
      error: normalized.error
    });

    if (params.boardId) {
      postBoardMessage(workspaceRoot, params.boardId, {
        author: `${usedTarget.engine}:${role}`,
        tag: normalized.ok ? "[done]" : "[blocker]",
        text: normalized.ok
          ? (normalized.output || "Completed.").slice(0, 800)
          : `Failed (${normalized.routingDecision.selected}): ${normalized.error}`,
        handoffId: normalized.handoffId,
        patchPath: normalized.patchPath,
        sessionId: normalized.sessionId,
        model: normalized.routingDecision.selected
      });
    }

    return normalized;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    upsertJob(workspaceRoot, {
      id: jobId,
      status: signal?.aborted ? "cancelled" : "failed",
      completedAt: nowIso(),
      error: errMsg
    });
    throw err;
  } finally {
    if (leaseAcquired && leasedEngine && leasedSessionId) {
      releaseSessionLease(workspaceRoot, leasedEngine, leasedSessionId, jobId);
    }
  }
}

function collectGitDiffForReview(repoRoot, { scope = "auto", base = null, maxBytes = 120000 } = {}) {
  const statusRes = runSync("git", ["status", "--porcelain=v1", "-uall"], { cwd: repoRoot, timeoutMs: 5000 });
  if (statusRes.status !== 0) {
    return {
      targetLabel: "git status",
      status: "",
      stat: "",
      diff: "",
      untrackedFiles: [],
      changedFiles: [],
      truncated: false,
      gitError: String(statusRes.stderr).trim() || `git status failed (${statusRes.status})`
    };
  }
  const status = String(statusRes.stdout).trim();
  let diffCmd = ["diff", "HEAD"];
  let targetLabel = "working tree changes";

  if (base) {
    const cleanBase = String(base).trim();
    if (!cleanBase || cleanBase.startsWith("-")) {
      return {
        targetLabel: `branch diff against ${cleanBase || "(empty)"}`,
        status: "",
        stat: "",
        diff: "",
        untrackedFiles: [],
        changedFiles: [],
        truncated: false,
        gitError: `Invalid base ref "${cleanBase}": must not be empty or start with "-".`
      };
    }
    const revCheck = runSync("git", ["rev-parse", "--verify", "--end-of-options", `${cleanBase}^{commit}`], {
      cwd: repoRoot,
      timeoutMs: 3000
    });
    if (revCheck.status !== 0 || !String(revCheck.stdout).trim()) {
      return {
        targetLabel: `branch diff against ${cleanBase}`,
        status: "",
        stat: "",
        diff: "",
        untrackedFiles: [],
        changedFiles: [],
        truncated: false,
        gitError: `Invalid base commit "${cleanBase}": ${String(revCheck.stderr).trim() || "revision not found"}`
      };
    }
    const resolvedSha = String(revCheck.stdout).trim();
    diffCmd = ["diff", `${resolvedSha}...HEAD`];
    targetLabel = `branch diff against ${cleanBase} (${resolvedSha.slice(0, 8)})`;
  } else if (scope === "branch") {
    let baseBranch = null;
    for (const candidate of ["main", "master"]) {
      const check = runSync("git", ["rev-parse", "--verify", candidate], { cwd: repoRoot, timeoutMs: 3000 });
      if (check.status === 0) {
        const mb = runSync("git", ["merge-base", "HEAD", candidate], { cwd: repoRoot, timeoutMs: 5000 });
        if (mb.status === 0 && String(mb.stdout).trim()) {
          baseBranch = String(mb.stdout).trim();
          break;
        }
      }
    }
    const ref = baseBranch || "HEAD~1";
    diffCmd = ["diff", `${ref}...HEAD`];
    targetLabel = `branch diff (${ref}...HEAD)`;
  } else if (scope === "auto" && !status) {
    diffCmd = ["diff", "HEAD~1..HEAD"];
    targetLabel = "latest commit (HEAD~1..HEAD)";
  }

  const statRes = runSync("git", [...diffCmd, "--stat"], { cwd: repoRoot, timeoutMs: 10000 });
  const diffRes = runSync("git", diffCmd, { cwd: repoRoot, timeoutMs: 15000, maxBuffer: 20 * 1024 * 1024 });

  const untrackedRes = runSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: repoRoot, timeoutMs: 5000 });
  const untrackedFiles = String(untrackedRes.stdout || "").split(/\r?\n/).filter(Boolean);

  const nameOnlyRes = runSync("git", [...diffCmd, "--name-only"], { cwd: repoRoot, timeoutMs: 5000 });
  const changedFiles = [
    ...new Set([
      ...String(nameOnlyRes.stdout || "").split(/\r?\n/).filter(Boolean),
      ...untrackedFiles
    ])
  ];

  let diff = String(diffRes.stdout || "");
  let truncated = false;
  if (diff.length > maxBytes) {
    diff = `${diff.slice(0, maxBytes)}\n\n[TRUNCATED at ${maxBytes} bytes — inspect files directly]`;
    truncated = true;
  }

  const gitError =
    diffRes.status !== 0
      ? String(diffRes.stderr).trim() || `git diff failed (${diffRes.status})`
      : statRes.status !== 0
        ? String(statRes.stderr).trim() || `git diff --stat failed (${statRes.status})`
        : null;

  return {
    targetLabel,
    status,
    stat: String(statRes.stdout).trim(),
    diff,
    untrackedFiles,
    changedFiles,
    truncated,
    gitError
  };
}

function isValidReviewPayload(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (obj.verdict !== "approve" && obj.verdict !== "needs-attention") return false;
  if (typeof obj.summary !== "string") return false;
  if (!Array.isArray(obj.findings)) return false;
  if (!Array.isArray(obj.next_steps)) return false;
  return true;
}

function normalizeFindings(findings = [], engineLabel) {
  return (Array.isArray(findings) ? findings : []).map((f) => ({
    severity: f?.severity || "advisory",
    title: f?.title || "Untitled finding",
    body: f?.body || "",
    file: f?.file || "unknown",
    line_start: Number.isInteger(f?.line_start) ? f.line_start : null,
    line_end: Number.isInteger(f?.line_end) ? f.line_end : null,
    trigger_path: f?.trigger_path || "",
    recommendation: f?.recommendation || "",
    engines: [engineLabel]
  }));
}

function severityScore(sev) {
  return { blocking: 0, critical: 0, high: 1, medium: 2, advisory: 3, low: 3 }[String(sev).toLowerCase()] ?? 4;
}

function isBlockingSeverity(sev) {
  const s = String(sev).toLowerCase();
  return s === "blocking" || s === "critical" || s === "high";
}

function mergeDualFindings(findingsLists) {
  const merged = [];
  for (const item of findingsLists.flat()) {
    const match = merged.find(
      (existing) =>
        existing.file === item.file &&
        existing.line_start === item.line_start &&
        existing.title.toLowerCase().slice(0, 28) === item.title.toLowerCase().slice(0, 28)
    );
    if (match) {
      for (const eng of item.engines) {
        if (!match.engines.includes(eng)) match.engines.push(eng);
      }
      if (severityScore(item.severity) < severityScore(match.severity)) {
        match.severity = item.severity;
      }
      if (!match.trigger_path && item.trigger_path) {
        match.trigger_path = item.trigger_path;
      }
    } else {
      merged.push({ ...item });
    }
  }
  return merged.sort((a, b) => severityScore(a.severity) - severityScore(b.severity));
}

export async function runDualReview(cwd, params = {}, internalOpts = {}) {
  assertRecursionSafe(cwd);
  validateCallerArgs(params);

  const signal = internalOpts.signal ?? null;
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const host = resolveHost(params.host);
  const routing = loadRoutingConfig();
  const rawEngine = params.engine || "both";
  const focus = params.focus ? String(params.focus).trim() : "General correctness, edge cases, security, and maintainability.";

  let targetEngines = [];
  if (rawEngine === "both") {
    const nonHost = VALID_ENGINES.filter((e) => e !== host);
    targetEngines = nonHost.length >= 2 ? nonHost.slice(0, 2) : ["codex", "claude"];
  } else {
    const norm = normalizeEngineName(rawEngine);
    if (!norm) {
      throw new Error(`Invalid review engine "${rawEngine}". Use "both", "agy", "claude", or "codex".`);
    }
    targetEngines = [norm];
  }

  if (targetEngines.length === 1 && targetEngines[0] === "codex" && params.native) {
    return runCodexNativeReview({
      cwd: workspaceRoot,
      base: params.base ?? null,
      focus,
      model: params.model ?? null,
      effort: params.effort ?? "high",
      signal
    });
  }

  const diffCtx = isGitRepo(workspaceRoot)
    ? collectGitDiffForReview(workspaceRoot, { scope: params.scope ?? "auto", base: params.base ?? null })
    : { targetLabel: "workspace files", status: "", stat: "", diff: "", untrackedFiles: [], changedFiles: [], truncated: false, gitError: null };

  if (diffCtx.gitError) {
    return {
      ok: false,
      engine: rawEngine,
      enginesUsed: targetEngines,
      effort: params.effort || "high",
      sensitiveUpgrade: false,
      target: diffCtx.targetLabel,
      verdict: "incomplete",
      error: `Diff collection failed: ${diffCtx.gitError}`,
      findings: [],
      reviews: []
    };
  }

  const sensitivePatterns = routing.sensitivePathPatterns ?? [];
  const touchesSensitive = diffCtx.changedFiles.some((f) =>
    sensitivePatterns.some((pat) => f.toLowerCase().includes(pat.toLowerCase()))
  );
  const effectiveEffort = params.effort || (touchesSensitive ? "xhigh" : "high");

  const reviewPrompt = [
    "Perform a strict, adversarial code review of the changes below using two severity tiers:",
    "- `blocking`: causes wrong data/math/billing, data loss, metric distortion/leakage, privilege escalation, unintended external action, or release breakage; MUST provide a concrete `trigger_path`.",
    "- `advisory`: style, low-probability edge cases, or non-essential refactors (non-blocking).",
    "Return strictly JSON matching the provided schema: verdict (approve|needs-attention), summary, findings[], next_steps[].",
    `\nTarget: ${diffCtx.targetLabel}`,
    `Focus: ${focus}`,
    diffCtx.status ? `\nGit status:\n${diffCtx.status}` : "",
    diffCtx.untrackedFiles.length ? `\nUntracked files (inspect directly): ${diffCtx.untrackedFiles.join(", ")}` : "",
    diffCtx.stat ? `\nDiff stat:\n${diffCtx.stat}` : "",
    diffCtx.diff ? `\nDiff:\n\`\`\`diff\n${diffCtx.diff}\n\`\`\`` : "\nNo git diff captured; inspect relevant files in the workspace directly."
  ]
    .filter(Boolean)
    .join("\n");

  const tasks = targetEngines.map((eng) => {
    const perEngineModel =
      eng === "codex"
        ? params.codexModel ?? (targetEngines.length === 1 ? params.model : null)
        : eng === "claude"
          ? params.claudeModel ?? (targetEngines.length === 1 ? params.model : null)
          : params.agyModel ?? (targetEngines.length === 1 ? params.model : null);

    return runSingleTask(
      workspaceRoot,
      {
        role: `${eng}-reviewer`,
        engine: eng,
        model: perEngineModel,
        effort: effectiveEffort,
        mode: "readonly",
        host,
        allowFallback: false,
        prompt: reviewPrompt,
        outputSchema: REVIEW_SCHEMA,
        workflowId: params.workflowId || "review"
      },
      { signal }
    );
  });

  if (tasks.length === 0) {
    throw new Error("No reviewer engines selected.");
  }

  const results = await Promise.all(tasks);
  const allSucceededWithSchema = results.every((r) => r.ok && isValidReviewPayload(r.structuredOutput));

  const findingsLists = results.map((r) => normalizeFindings(r.structuredOutput?.findings, r.engine));
  const mergedFindings = mergeDualFindings(findingsLists);

  let verdict;
  if (!allSucceededWithSchema) {
    verdict = "incomplete";
  } else {
    const needsAttention =
      results.some((r) => r.structuredOutput?.verdict === "needs-attention") ||
      mergedFindings.some((f) => isBlockingSeverity(f.severity));
    verdict = needsAttention ? "needs-attention" : "approve";
  }

  return {
    ok: allSucceededWithSchema,
    engine: rawEngine,
    enginesUsed: targetEngines,
    effort: effectiveEffort,
    sensitiveUpgrade: touchesSensitive && !params.effort,
    target: diffCtx.targetLabel,
    verdict,
    findings: mergedFindings,
    reviews: results.map((r) => ({
      engine: r.engine,
      model: r.model,
      effort: r.effort,
      ok: r.ok,
      sessionId: r.sessionId,
      durationMs: r.durationMs,
      structuredOutput: r.structuredOutput,
      output: r.structuredOutput ? null : r.output,
      error: r.error
    }))
  };
}

export async function runReviewGate(cwd, params = {}) {
  assertRecursionSafe(cwd);
  validateCallerArgs(params);

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const routing = loadRoutingConfig();
  const gateKey = validateOpaqueId(params.gateKey || params.workflowId || "default-gate", "gateKey");
  const maxRounds = Math.max(1, Math.min(5, Number(params.maxRounds ?? routing.defaults?.maxReviewGateRounds ?? 2)));

  if (params.reset) {
    saveReviewGateState(workspaceRoot, gateKey, { gateKey, round: 0, history: [] });
    return { ok: true, gateKey, reset: true, round: 0 };
  }

  // Reserve round number atomically BEFORE executing review so concurrent calls cannot overwrite each other.
  const reservation = withReviewGateLock(workspaceRoot, gateKey, (state, save) => {
    const nextRound = (state.round || 0) + 1;
    if (nextRound > maxRounds) {
      const lastEntry = state.history?.at(-1) ?? {};
      const remainingBlocking = (lastEntry.findings ?? []).filter((f) => isBlockingSeverity(f.severity));
      return { escalated: true, state, remainingBlocking };
    }
    save({ ...state, gateKey, round: nextRound });
    return { escalated: false, round: nextRound };
  });

  if (reservation.escalated) {
    return {
      ok: false,
      gateKey,
      decision: "escalate_to_user",
      round: reservation.state.round,
      maxRounds,
      message: `Review gate reached max ${maxRounds} round(s) without convergence. Escalating remaining blocking items to user.`,
      remainingBlockingFindings: reservation.remainingBlocking
    };
  }

  const review = await runDualReview(workspaceRoot, {
    ...params,
    engine: params.engine || "both"
  });

  const blockingFindings = review.findings.filter((f) => isBlockingSeverity(f.severity));
  const advisoryFindings = review.findings.filter((f) => !isBlockingSeverity(f.severity));
  const decision = !review.ok
    ? "incomplete"
    : blockingFindings.length > 0 || review.verdict === "needs-attention"
      ? "fix_required"
      : "pass";

  withReviewGateLock(workspaceRoot, gateKey, (latest, save) => {
    const history = [
      ...(latest.history ?? []),
      {
        round: reservation.round,
        timestamp: nowIso(),
        decision,
        verdict: review.verdict,
        effort: review.effort,
        findings: review.findings
      }
    ].sort((a, b) => (a.round ?? 0) - (b.round ?? 0));
    save({ gateKey, round: Math.max(latest.round || 0, reservation.round), history });
  });

  return {
    ok: decision === "pass",
    gateKey,
    decision,
    round: reservation.round,
    maxRounds,
    effort: review.effort,
    sensitiveUpgrade: review.sensitiveUpgrade,
    blockingFindings,
    advisoryFindings,
    reviews: review.reviews
  };
}

export async function runDualDesign(cwd, params = {}) {
  assertRecursionSafe(cwd);
  validateCallerArgs(params);

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const action = params.action || "start";
  const host = resolveHost(params.host);

  if (action === "start") {
    const requirement = String(params.requirement ?? "").trim();
    if (!requirement) {
      throw new Error("`requirement` is required for relay_design action=\"start\".");
    }
    if (params.hostDraft !== undefined || params.hostDraftPath !== undefined) {
      throw new Error(
        "Anti-anchoring violation: host draft cannot be passed to `start`. Call `submit_host` separately, then `reveal`."
      );
    }

    const designId = params.designId ? validateOpaqueId(params.designId, "designId") : generateId("design");
    const rawContextPaths = Array.isArray(params.contextPaths) ? params.contextPaths : [];
    const contextPaths = rawContextPaths.map((cp) =>
      path.relative(workspaceRoot, resolvePathInsideWorkspace(workspaceRoot, cp, "contextPath")) || "."
    );

    saveDesignVault(workspaceRoot, designId, {
      designId,
      host,
      requirement,
      contextPaths,
      status: "pending_host_draft",
      hostDraft: null,
      hostDraftSha256: null,
      advisorResult: null
    });

    const advisorPrompt = [
      "Provide an independent architectural/technical design for the requirement below.",
      "Do NOT assume any pre-existing draft. Clearly state:",
      "1. Core architecture & data flow",
      "2. Exact files/symbols referenced (mark anything unverified as inferred)",
      "3. Key trade-offs, risks, and verification plan",
      `\nRequirement:\n${requirement}`,
      contextPaths.length ? `\nRelevant context paths to inspect:\n- ${contextPaths.join("\n- ")}` : ""
    ]
      .filter(Boolean)
      .join("\n");

    const advisorResult = await runSingleTask(workspaceRoot, {
      role: "advisor",
      profile: params.advisorSpec ? null : "advisor",
      spec: params.advisorSpec ?? null,
      mode: "readonly",
      host,
      workflowId: designId,
      prompt: advisorPrompt
    });

    updateDesignVault(workspaceRoot, designId, (cur) => ({
      ...cur,
      advisorResult: {
        ok: advisorResult.ok,
        engine: advisorResult.engine,
        model: advisorResult.model,
        sessionId: advisorResult.sessionId,
        output: advisorResult.output,
        error: advisorResult.error
      }
    }));

    return {
      ok: advisorResult.ok,
      designId,
      status: "sealed_pending_host_draft",
      advisorEngine: advisorResult.engine,
      advisorModel: advisorResult.model,
      message: "Advisor design is sealed. Submit the host's independent draft via `submit_host`, then call `reveal`."
    };
  }

  if (action === "submit_host") {
    const designId = validateOpaqueId(params.designId, "designId");
    let draftText = String(params.hostDraft ?? "").trim();
    if (!draftText && params.hostDraftPath) {
      const safePath = resolvePathInsideWorkspace(workspaceRoot, params.hostDraftPath, "hostDraftPath");
      if (!fs.existsSync(safePath)) {
        throw new Error(`hostDraftPath not found: ${safePath}`);
      }
      draftText = fs.readFileSync(safePath, "utf8").trim();
    }
    if (!draftText) {
      throw new Error("`submit_host` requires non-empty `hostDraft` or `hostDraftPath`.");
    }

    const sha256 = createHash("sha256").update(draftText).digest("hex");
    updateDesignVault(workspaceRoot, designId, (cur) => ({
      ...cur,
      status: "ready_to_reveal",
      hostDraft: draftText,
      hostDraftSha256: sha256,
      hostSubmittedAt: nowIso()
    }));

    return {
      ok: true,
      designId,
      status: "ready_to_reveal",
      hostDraftSha256: sha256
    };
  }

  if (action === "reveal") {
    const designId = validateOpaqueId(params.designId, "designId");
    const vault = loadDesignVault(workspaceRoot, designId);
    if (!vault) {
      throw new Error(`Design session "${designId}" not found.`);
    }
    if (!vault.hostDraft || !vault.hostDraftSha256) {
      throw new Error(
        `Anti-anchoring guard: cannot reveal advisor design for "${designId}" before host submits its own independent draft via \`submit_host\`.`
      );
    }

    return {
      ok: Boolean(vault.advisorResult?.ok),
      designId,
      requirement: vault.requirement,
      hostDraftSha256: vault.hostDraftSha256,
      hostDraft: vault.hostDraft,
      advisor: vault.advisorResult,
      mergeTemplate: [
        "1. 两边一致的结论 (Consensus)",
        "2. 采纳顾问的部分 (Adopted from Advisor — after verifying codebase facts)",
        "3. 不采纳顾问的部分及实证理由 (Rejected with Evidence)",
        "4. 各有道理、需用户拍板的取舍点 (Open Trade-offs for User Decision)"
      ]
    };
  }

  throw new Error(`Unknown relay_design action: "${action}". Use start | submit_host | reveal.`);
}

export async function runCopyReview(cwd, params = {}) {
  assertRecursionSafe(cwd);
  validateCallerArgs(params);

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const host = resolveHost(params.host);
  let target = String(params.content ?? "").trim();
  if (!target && params.filePath) {
    const safePath = resolvePathInsideWorkspace(workspaceRoot, params.filePath, "filePath");
    if (!fs.existsSync(safePath)) {
      throw new Error(`filePath not found: ${safePath}`);
    }
    target = fs.readFileSync(safePath, "utf8");
  }
  if (!target.trim()) {
    throw new Error("relay_copy_review requires non-empty `content` or `filePath`.");
  }

  const audience = params.audience || "developers / end users";
  const purpose = params.purpose || "clear, accurate, concise technical/UI communication";

  const res = await runSingleTask(workspaceRoot, {
    role: "copy-reviewer",
    profile: params.advisorSpec ? null : "advisor",
    spec: params.advisorSpec ?? null,
    mode: "readonly",
    host,
    outputSchema: COPY_REVIEW_SCHEMA,
    workflowId: params.workflowId || "copy-review",
    prompt: [
      "Review the draft copy below for clarity, conciseness, and factual discipline.",
      `Target audience: ${audience}`,
      `Purpose: ${purpose}`,
      "Guidelines: keep status labels concise (2-4 chars/words); move explanatory detail to helper text; remove filler; do not invent features.",
      "Return strictly JSON matching the schema (`summary`, `rows[{location, current, problem, suggestion}]`).",
      `\nDraft:\n${target}`
    ].join("\n")
  });

  return {
    ok: Boolean(res.ok && res.structuredOutput),
    engine: res.engine,
    model: res.model,
    sessionId: res.sessionId,
    summary: res.structuredOutput?.summary ?? null,
    rows: res.structuredOutput?.rows ?? [],
    rawOutput: res.structuredOutput ? null : res.output,
    error: res.error
  };
}

export async function runOrchestration(cwd, params = {}, internalOpts = {}) {
  assertRecursionSafe(cwd);
  validateCallerArgs(params);

  const signal = internalOpts.signal ?? null;
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const routing = loadRoutingConfig();
  const host = resolveHost(params.host);
  const pattern = params.pattern || "teamwork";
  const workflowId = params.workflowId ? validateOpaqueId(params.workflowId, "workflowId") : generateId(pattern);
  const boardId = params.boardId ? validateOpaqueId(params.boardId, "boardId") : workflowId;
  const pool = new ConcurrencyPool(
    params.maxConcurrency ?? routing.defaults?.maxConcurrency ?? 4,
    params.maxPerEngine ?? routing.defaults?.maxPerEngine ?? 2
  );

  postBoardMessage(workspaceRoot, boardId, {
    author: `${host}:coordinator`,
    tag: "[brief]",
    text: `Starting ${pattern} workflow (${workflowId}): ${String(params.goal ?? params.prompt ?? "").slice(0, 300)}`
  });

  if (pattern === "boost") {
    const question = String(params.prompt ?? params.goal ?? "").trim();
    if (!question) {
      throw new Error("`boost` pattern requires `prompt` or `goal`.");
    }
    const modelSpecs =
      Array.isArray(params.models) && params.models.length > 0
        ? params.models
        : resolveRoute({ profile: "boost-trio", host, excludeHost: false }).fanout.map((f) => f.spec);

    const phase1Results = await Promise.all(
      modelSpecs.map((spec, idx) => {
        const route = resolveRoute({ spec, host });
        return pool.run(route.primary.engine, () =>
          runSingleTask(
            workspaceRoot,
            {
              workflowId,
              boardId,
              host,
              role: `boost-${idx + 1}-${route.primary.engine}`,
              spec,
              mode: "readonly",
              includeHostDigest: Boolean(params.includeHostDigest || params.includeAgyDigest),
              includeRepoHandoff: Boolean(params.includeRepoHandoff),
              prompt: [
                "Provide an independent, rigorous, first-principles analysis for the following problem.",
                "State assumptions, key risks, concrete recommendation, and verification checks.",
                `\nProblem:\n${question}`
              ].join("\n")
            },
            { signal }
          )
        );
      })
    );

    let critiques = [];
    if (!signal?.aborted && params.crossCritique && phase1Results.length >= 2) {
      critiques = await Promise.all(
        phase1Results.map((own, idx) => {
          const peers = phase1Results
            .filter((_, j) => j !== idx)
            .map((p, k) => `### Peer Perspective ${k + 1} (${p.engine}:${p.model ?? "default"})\n${(p.output || p.error || "").slice(0, 2500)}`)
            .join("\n\n");
          const spec = `${own.engine}${own.model ? `:${own.model}` : ""}${own.effort ? `@${own.effort}` : ""}`;
          const canFork = own.engine === "claude" || own.engine === "codex";
          return pool.run(own.engine, () =>
            runSingleTask(
              workspaceRoot,
              {
                workflowId,
                boardId,
                host,
                role: `critique-${idx + 1}-${own.engine}`,
                spec,
                mode: "readonly",
                resumeSessionId: canFork ? own.sessionId : null,
                forkSession: canFork,
                prompt: [
                  "Cross-critique round: inspect the peer perspectives below against your own analysis.",
                  "Identify: (1) flaws or blind spots in peer reasoning, (2) points where a peer caught something you missed, (3) your revised concise verdict.",
                  !canFork && own.output ? `\nYour Phase 1 Analysis:\n${own.output.slice(0, 2500)}` : "",
                  `\n${peers}`
                ]
                  .filter(Boolean)
                  .join("\n")
              },
              { signal }
            )
          );
        })
      );
    }

    return {
      ok: !signal?.aborted && phase1Results.every((r) => r.ok),
      cancelled: Boolean(signal?.aborted),
      pattern: "boost",
      workflowId,
      boardId,
      perspectives: phase1Results.map((r) => ({
        role: r.role,
        engine: r.engine,
        model: r.model,
        effort: r.effort,
        ok: r.ok,
        sessionId: r.sessionId,
        durationMs: r.durationMs,
        output: r.output,
        error: r.error
      })),
      critiques: critiques.map((r) => ({
        role: r.role,
        engine: r.engine,
        model: r.model,
        ok: r.ok,
        output: r.output,
        error: r.error
      }))
    };
  }

  if (pattern === "pipeline") {
    const stages = Array.isArray(params.stages) ? params.stages : [];
    if (stages.length === 0) {
      throw new Error("`pipeline` pattern requires a non-empty `stages` array.");
    }
    const stageResults = [];
    let currentHandoffId = params.handoffId ?? null;
    let lastResult = null;

    for (let i = 0; i < stages.length; i += 1) {
      if (signal?.aborted) break;
      const stage = stages[i];
      validateCallerArgs(stage);
      if (!currentHandoffId && lastResult) {
        const nextRoute = resolveRoute({
          profile: stage.profile,
          spec: stage.spec,
          engine: stage.engine,
          model: stage.model,
          effort: stage.effort,
          prompt: stage.prompt,
          mode: stage.mode ?? "readonly",
          host
        });
        const compiled = buildWorkerResultToHandoff(workspaceRoot, lastResult, {
          workflowId,
          toEngine: nextRoute.primary.engine,
          role: stage.role || `stage-${i + 1}`,
          goal: stage.goal || stage.prompt
        });
        currentHandoffId = compiled.packet.handoffId;
      }

      const res = await runSingleTask(
        workspaceRoot,
        {
          ...stage,
          host,
          workflowId,
          boardId,
          role: stage.role || `stage-${i + 1}`,
          handoffId: currentHandoffId
        },
        { signal }
      );
      stageResults.push(res);
      lastResult = res;
      currentHandoffId = null;
      if (!res.ok && stage.stopOnFailure !== false) {
        break;
      }
    }

    return {
      ok: !signal?.aborted && stageResults.every((r) => r.ok),
      cancelled: Boolean(signal?.aborted),
      pattern: "pipeline",
      workflowId,
      boardId,
      stages: stageResults
    };
  }

  if (pattern === "swarm") {
    const workers = Array.isArray(params.workers) ? params.workers : [];
    if (workers.length === 0) {
      throw new Error("`swarm` pattern requires a non-empty `workers` array.");
    }

    const byName = new Map();
    for (let idx = 0; idx < workers.length; idx += 1) {
      const w = workers[idx];
      validateCallerArgs(w);
      const name = w.name || `worker-${idx + 1}`;
      if (byName.has(name)) {
        throw new Error(`Swarm contains duplicate worker name "${name}".`);
      }
      byName.set(name, { ...w, name, dependsOn: Array.isArray(w.dependsOn) ? w.dependsOn : [] });
    }

    for (const w of byName.values()) {
      for (const dep of w.dependsOn) {
        if (!byName.has(dep)) {
          throw new Error(`Swarm worker "${w.name}" depends on unknown worker "${dep}".`);
        }
      }
    }

    const remainingCheck = new Set(byName.keys());
    const resolvedCheck = new Set();
    while (remainingCheck.size > 0) {
      const ready = [...remainingCheck].filter((n) => byName.get(n).dependsOn.every((d) => resolvedCheck.has(d)));
      if (ready.length === 0) {
        throw new Error(`Swarm dependency cycle detected among: ${[...remainingCheck].join(", ")}`);
      }
      for (const n of ready) {
        resolvedCheck.add(n);
        remainingCheck.delete(n);
      }
    }

    const completed = new Map();
    const remaining = new Set(byName.keys());

    while (remaining.size > 0) {
      if (signal?.aborted) break;
      const readyNames = [...remaining].filter((name) =>
        byName.get(name).dependsOn.every((dep) => completed.has(dep))
      );

      const waveResults = await Promise.all(
        readyNames.map(async (name) => {
          if (signal?.aborted) {
            return { ok: false, cancelled: true, role: name, error: "Cancelled by caller." };
          }
          const w = byName.get(name);
          const failedDeps = w.dependsOn.filter((d) => !completed.get(d)?.ok);
          if (failedDeps.length > 0 && w.allowFailedDependency !== true) {
            const blockedResult = {
              ok: false,
              blocked: true,
              role: name,
              engine: null,
              model: null,
              error: `Blocked because prerequisite worker(s) failed: ${failedDeps.join(", ")}`
            };
            postBoardMessage(workspaceRoot, boardId, {
              author: `swarm:${name}`,
              tag: "[blocker]",
              text: blockedResult.error
            });
            return blockedResult;
          }

          const depEvidence = w.dependsOn.map((d) => {
            const dr = completed.get(d);
            return `Dependency "${d}" (${dr.engine}:${dr.model ?? "default"}, ok=${dr.ok}): ${(dr.output || dr.error || "").slice(0, 500)}${dr.patchPath ? ` [patch: ${dr.patchPath}]` : ""}`;
          });

          const route = resolveRoute({
            profile: w.profile || (w.mode === "write" ? "swarm-worker" : "explorer"),
            spec: w.spec,
            engine: w.engine,
            model: w.model,
            effort: w.effort,
            prompt: w.prompt,
            mode: w.mode ?? "readonly",
            host
          });

          return pool.run(route.primary.engine, () =>
            runSingleTask(
              workspaceRoot,
              {
                workflowId,
                boardId,
                host,
                role: name,
                profile: w.profile || (w.mode === "write" ? "swarm-worker" : "explorer"),
                spec: w.spec,
                engine: w.engine,
                model: w.model,
                effort: w.effort,
                mode: w.mode ?? "readonly",
                ownedFiles: w.ownedFiles ?? [],
                forbiddenFiles: w.forbiddenFiles ?? ["docs/handoff.md"],
                evidence: depEvidence,
                invariants: w.invariants ?? [],
                acceptanceCriteria: w.acceptanceCriteria ?? [],
                handoff: true,
                prompt: w.prompt
              },
              { signal }
            )
          );
        })
      );

      for (let i = 0; i < readyNames.length; i += 1) {
        completed.set(readyNames[i], waveResults[i]);
        remaining.delete(readyNames[i]);
      }
    }

    const ordered = [...completed.values()];
    return {
      ok: !signal?.aborted && ordered.every((r) => r.ok),
      cancelled: Boolean(signal?.aborted),
      pattern: "swarm",
      workflowId,
      boardId,
      workers: ordered
    };
  }

  // Default: "teamwork"
  let architectResult = null;
  let tasks = Array.isArray(params.tasks) ? params.tasks : [];

  if (tasks.length === 0 && params.goal) {
    architectResult = await runSingleTask(
      workspaceRoot,
      {
        workflowId,
        boardId,
        host,
        role: "architect",
        profile: params.architectSpec ? null : params.architectProfile || "architect",
        spec: params.architectSpec ?? null,
        mode: "readonly",
        includeHostDigest: Boolean(params.includeHostDigest || params.includeAgyDigest),
        includeRepoHandoff: Boolean(params.includeRepoHandoff),
        outputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["plan_summary", "tasks"],
          properties: {
            plan_summary: { type: "string" },
            tasks: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["role", "profile", "mode", "ownedFiles", "prompt"],
                properties: {
                  role: { type: "string" },
                  profile: { type: "string" },
                  mode: { type: "string", enum: ["readonly", "write"] },
                  ownedFiles: { type: "array", items: { type: "string" } },
                  prompt: { type: "string" }
                }
              }
            }
          }
        },
        prompt: [
          "Decompose this goal into 1 to 4 non-overlapping worker tasks with disjoint ownedFiles.",
          "Return strict JSON matching the schema.",
          `\nGoal:\n${params.goal}`
        ].join("\n")
      },
      { signal }
    );
    if (Array.isArray(architectResult.structuredOutput?.tasks)) {
      tasks = architectResult.structuredOutput.tasks;
    }
  }

  if (signal?.aborted) {
    return {
      ok: false,
      cancelled: true,
      pattern: "teamwork",
      workflowId,
      boardId,
      architect: architectResult,
      workers: [],
      verification: null
    };
  }

  if (tasks.length === 0) {
    throw new Error("`teamwork` pattern requires `tasks[]` or a `goal` that decomposes into tasks.");
  }

  const seenOwned = new Map();
  for (const t of tasks) {
    validateCallerArgs(t);
    if (t.mode === "write" && Array.isArray(t.ownedFiles)) {
      for (const f of t.ownedFiles) {
        if (seenOwned.has(f)) {
          throw new Error(`Overlapping ownedFiles "${f}" between "${seenOwned.get(f)}" and "${t.role || "worker"}".`);
        }
        seenOwned.set(f, t.role || "worker");
      }
    }
  }

  const workerResults = await Promise.all(
    tasks.map((task, idx) => {
      const role = task.role || `worker-${idx + 1}`;
      const mode = task.mode === "write" ? "write" : "readonly";
      const route = resolveRoute({
        profile: task.profile || (mode === "write" ? "implementer" : "explorer"),
        spec: task.spec,
        engine: task.engine,
        model: task.model,
        effort: task.effort,
        prompt: task.prompt,
        mode,
        host
      });
      return pool.run(route.primary.engine, () =>
        runSingleTask(
          workspaceRoot,
          {
            workflowId,
            boardId,
            host,
            role,
            profile: task.profile || (mode === "write" ? "implementer" : "explorer"),
            spec: task.spec,
            engine: task.engine,
            model: task.model,
            effort: task.effort,
            mode,
            ownedFiles: task.ownedFiles ?? [],
            forbiddenFiles: task.forbiddenFiles ?? ["docs/handoff.md"],
            invariants: task.invariants ?? [],
            acceptanceCriteria: task.acceptanceCriteria ?? [],
            handoff: true,
            outputSchema: task.outputSchema ?? WORKER_SCHEMA,
            prompt: task.prompt
          },
          { signal }
        )
      );
    })
  );

  let verificationResult = null;
  if (!signal?.aborted && params.crossVerify !== false) {
    const primaryAuthorEngine = workerResults.find((r) => r.mode === "write")?.engine ?? workerResults[0]?.engine ?? "codex";
    const evidenceLines = workerResults.map(
      (r) =>
        `- Worker ${r.role} (${r.engine}:${r.model ?? "default"}, ok=${r.ok}): ${(r.output || r.error || "").slice(0, 500)}${r.patchPath ? ` | patch: ${r.patchPath}` : ""}`
    );
    const patchContents = workerResults
      .filter((r) => r.patchPath && fs.existsSync(r.patchPath))
      .map((r) => {
        const raw = fs.readFileSync(r.patchPath, "utf8");
        const truncatedNotice = raw.length > 20000 ? "\n[TRUNCATED at 20000 bytes — inspect full patch file]" : "";
        return `### Patch from ${r.role} (${r.patchPath})\n\`\`\`diff\n${raw.slice(0, 20000)}${truncatedNotice}\n\`\`\``;
      })
      .join("\n\n");

    verificationResult = await runSingleTask(
      workspaceRoot,
      {
        workflowId,
        boardId,
        host,
        role: "cross-verifier",
        profile: params.verifierSpec ? null : "opposite-verifier",
        spec: params.verifierSpec ?? null,
        authorEngine: primaryAuthorEngine,
        mode: "readonly",
        outputSchema: REVIEW_SCHEMA,
        evidence: evidenceLines,
        handoff: true,
        prompt: [
          "Cross-verify all worker outputs and patches below for correctness, regressions, edge cases, and adherence to acceptance criteria.",
          patchContents ? `\n${patchContents}` : "",
          "\nReturn strict JSON matching the review schema."
        ]
          .filter(Boolean)
          .join("\n")
      },
      { signal }
    );
  }

  const workersAccepted = workerResults.every((r) => r.ok && r.structuredOutput?.status !== "blocked");
  const verifierAccepted = verificationResult
    ? Boolean(verificationResult.ok && verificationResult.structuredOutput?.verdict === "approve")
    : true;

  return {
    ok: !signal?.aborted && workersAccepted && verifierAccepted,
    cancelled: Boolean(signal?.aborted),
    pattern: "teamwork",
    workflowId,
    boardId,
    architect: architectResult,
    workers: workerResults,
    verification: verificationResult
  };
}
