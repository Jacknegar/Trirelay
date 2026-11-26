import fs from "node:fs";
import path from "node:path";

import { resolveWorkspaceRoot } from "./env.mjs";
import {
  assertPathInside,
  ensureSubdir,
  generateId,
  listJobs,
  nowIso,
  readJobDetail,
  readLogTail,
  resolveJobLogFile,
  upsertJob,
  validateOpaqueId
} from "./state.mjs";

const activeInProcessJobs = new Map();

function resolveJobCancelFile(cwd, jobId) {
  const safeId = validateOpaqueId(jobId, "jobId");
  const jobsDir = ensureSubdir(cwd, "jobs");
  return assertPathInside(jobsDir, path.join(jobsDir, `${safeId}.cancel`), "jobCancelFile");
}

export function createJobRecord(cwd, meta = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobId = generateId(meta.prefix || "job");
  const logFile = resolveJobLogFile(workspaceRoot, jobId);

  const record = upsertJob(workspaceRoot, {
    id: jobId,
    kind: meta.kind || "run",
    workflowId: meta.workflowId || "default",
    role: meta.role || "worker",
    mode: meta.mode || "readonly",
    status: "running",
    engine: meta.engine ?? null,
    model: meta.model ?? null,
    effort: meta.effort ?? null,
    pid: process.pid,
    logFile,
    startedAt: nowIso()
  });

  return { jobId, workspaceRoot, logFile, record };
}

export function launchBackgroundJob(cwd, meta, asyncRunner) {
  const { jobId, workspaceRoot, logFile, record } = createJobRecord(cwd, meta);
  const controller = new AbortController();
  const cancelFile = resolveJobCancelFile(workspaceRoot, jobId);

  // Per-job external cancel watcher: polls only this job's .cancel marker so external
  // processes never SIGTERM a shared MCP server or disrupt sibling background jobs.
  const cancelPoll = setInterval(() => {
    if (!controller.signal.aborted && fs.existsSync(cancelFile)) {
      controller.abort();
    }
  }, 400);
  cancelPoll.unref?.();

  const promise = (async () => {
    try {
      const result = await asyncRunner({ jobId, workspaceRoot, logFile, signal: controller.signal });
      const wasAborted = controller.signal.aborted || Boolean(result?.cancelled);
      upsertJob(workspaceRoot, {
        id: jobId,
        status: wasAborted ? "cancelled" : result?.ok ? "completed" : "failed",
        completedAt: nowIso(),
        pid: null,
        engine: result?.engine ?? record.engine,
        model: result?.model ?? record.model,
        effort: result?.effort ?? record.effort,
        sessionId: result?.sessionId ?? null,
        worktreePath: result?.worktreePath ?? null,
        patchPath: result?.patchPath ?? null,
        finalHeadSha: result?.finalHeadSha ?? null,
        changedFiles: result?.changedFiles ?? [],
        scopeViolations: result?.scopeViolations ?? [],
        handoffId: result?.handoffId ?? null,
        routingDecision: result?.routingDecision ?? null,
        output: result?.output ?? null,
        structuredOutput: result?.structuredOutput ?? null,
        result,
        error: wasAborted ? "Cancelled by caller." : result?.error ?? null
      });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      upsertJob(workspaceRoot, {
        id: jobId,
        status: controller.signal.aborted ? "cancelled" : "failed",
        completedAt: nowIso(),
        pid: null,
        error: msg
      });
      return { ok: false, jobId, error: msg };
    } finally {
      clearInterval(cancelPoll);
      activeInProcessJobs.delete(jobId);
      try {
        if (fs.existsSync(cancelFile)) fs.unlinkSync(cancelFile);
      } catch {
        // Ignore cleanup failure.
      }
    }
  })();

  activeInProcessJobs.set(jobId, { controller, promise, workspaceRoot });

  return {
    ok: true,
    background: true,
    jobId,
    status: "running",
    logFile,
    workspaceRoot
  };
}

export async function handleJobControl(cwd, args = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const action = args.action || (args.jobId ? "result" : "list");

  if (action === "list") {
    const limit = Math.max(1, Math.min(100, Number(args.limit ?? 20)));
    return {
      workspaceRoot,
      jobs: listJobs(workspaceRoot).slice(0, limit)
    };
  }

  if (!args.jobId) {
    throw new Error(`relay_jobs action="${action}" requires "jobId".`);
  }

  if (action === "cancel") {
    const detail = readJobDetail(workspaceRoot, args.jobId);
    if (!detail) {
      throw new Error(`Job "${args.jobId}" not found.`);
    }

    const active = activeInProcessJobs.get(detail.id);
    if (active) {
      active.controller.abort();
      await Promise.race([active.promise, new Promise((r) => setTimeout(r, 4000))]);
      return readJobDetail(workspaceRoot, detail.id);
    }

    // Cross-process cancel: write a per-job cancel marker so only the target job's
    // owner aborts that job's AbortController & worker subprocess tree safely.
    if (detail.status === "running") {
      const cancelFile = resolveJobCancelFile(workspaceRoot, detail.id);
      fs.writeFileSync(cancelFile, JSON.stringify({ requestedAt: nowIso(), byPid: process.pid }), {
        encoding: "utf8",
        mode: 0o600
      });
      upsertJob(workspaceRoot, {
        id: detail.id,
        status: "cancel_requested",
        cancelRequestedAt: nowIso(),
        error: "Cancellation requested from external process."
      });
    }
    return readJobDetail(workspaceRoot, detail.id);
  }

  if (action === "wait") {
    const waitMs = Math.max(500, Math.min(90000, Number(args.waitTimeoutMs ?? 30000)));
    const active = activeInProcessJobs.get(args.jobId);
    if (active) {
      await Promise.race([active.promise, new Promise((r) => setTimeout(r, waitMs))]);
    } else {
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        const snap = readJobDetail(workspaceRoot, args.jobId);
        if (!snap || (snap.status !== "running" && snap.status !== "cancel_requested")) break;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }

  const detail = readJobDetail(workspaceRoot, args.jobId);
  if (!detail) {
    throw new Error(`Job "${args.jobId}" not found.`);
  }

  const logTail = detail.logFile ? readLogTail(detail.logFile, 40, 16384) : "";
  if (action === "status") {
    const { result: _omitResult, output: _omitOut, ...summary } = detail;
    return { job: summary, logTail };
  }

  return { job: detail, logTail };
}
