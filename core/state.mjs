import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { canonicalizePath, resolveBaseStateRoot, resolveWorkspaceRoot } from "./env.mjs";
import { withFileLockSync } from "./lock.mjs";

const MAX_JOBS = 100;
const OPAQUE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/;

export function nowIso() {
  return new Date().toISOString();
}

export function generateId(prefix = "mesh") {
  const rand = randomBytes(4).toString("hex");
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

export function validateOpaqueId(id, label = "id") {
  const value = String(id ?? "").trim();
  if (!value || !OPAQUE_ID_RE.test(value) || value.includes("..")) {
    throw new Error(`Invalid ${label}: "${id}". Must match ${OPAQUE_ID_RE.source} without "..".`);
  }
  return value;
}

export function assertPathInside(parentDir, targetPath, label = "path") {
  const base = canonicalizePath(parentDir);
  const resolved = canonicalizePath(targetPath);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error(`Security error: ${label} escapes allowed directory (${resolved} outside ${base}).`);
  }
  return resolved;
}

export function isInsideManagedWorktree(targetPath) {
  const baseRoot = canonicalizePath(resolveBaseStateRoot());
  const resolved = canonicalizePath(targetPath);
  if (!resolved.startsWith(`${baseRoot}${path.sep}`)) {
    return false;
  }
  const rel = path.relative(baseRoot, resolved);
  const parts = rel.split(path.sep);
  return parts.length >= 3 && parts[1] === "worktrees";
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const canonical = canonicalizePath(workspaceRoot);
  const slug =
    (path.basename(canonical) || "workspace")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);

  const root = resolveBaseStateRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = path.join(root, `${slug}-${hash}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function ensureSubdir(cwd, sub) {
  const dir = path.join(resolveStateDir(cwd), sub);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function readJsonSafe(filePath, fallback = null) {
  if (!filePath || !fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

// --- Host session snapshots (keyed by host + conversationId) ---

function hostSessionIndexPath(cwd) {
  return path.join(resolveStateDir(cwd), "host-sessions.json");
}

export function saveHostSession(cwd, payload, { timeoutMs = 15000 } = {}) {
  const file = hostSessionIndexPath(cwd);
  return withFileLockSync(
    file,
    () => {
      const data = readJsonSafe(file, { latestByHost: {}, sessions: {} });
      const host = payload.host || "agy";
      const convId = payload.conversationId || "default";
      const entry = { ...payload, host, conversationId: convId, updatedAt: nowIso() };
      data.sessions[`${host}::${convId}`] = entry;
      data.latestByHost[host] = `${host}::${convId}`;
      writeJsonAtomic(file, data);
      return file;
    },
    { timeoutMs }
  );
}

export function loadHostSession(cwd, { host = null, conversationId = null } = {}) {
  const data = readJsonSafe(hostSessionIndexPath(cwd), null);
  if (!data) return null;
  if (host && conversationId) {
    return data.sessions?.[`${host}::${conversationId}`] ?? null;
  }
  if (host) {
    const key = data.latestByHost?.[host];
    return key ? data.sessions?.[key] ?? null : null;
  }
  const all = Object.values(data.sessions ?? {}).sort((a, b) =>
    String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""))
  );
  return all[0] ?? null;
}

// --- Session Ledger & Lease ---

export function sessionLedgerPath(cwd) {
  return path.join(resolveStateDir(cwd), "sessions.json");
}

export function loadSessionLedger(cwd) {
  return readJsonSafe(sessionLedgerPath(cwd), { entries: {}, bySession: {}, leases: {} });
}

export function recordRoleSession(
  cwd,
  {
    workflowId = "default",
    role,
    engine,
    sessionId,
    sessionCwd = null,
    model = null,
    effort = null,
    worktreeId = null,
    worktreePath = null,
    baseSha = null,
    patchPath = null,
    patchSha256 = null,
    deliverableMode = null,
    finalHeadSha = null,
    captureComplete = true,
    isWriteRun = false
  }
) {
  if (!role || !engine || !sessionId) {
    return;
  }
  const file = sessionLedgerPath(cwd);
  withFileLockSync(file, () => {
    const ledger = readJsonSafe(file, { entries: {}, bySession: {}, leases: {} });
    ledger.entries = ledger.entries || {};
    ledger.bySession = ledger.bySession || {};
    const key = `${workflowId}::${role}::${engine}`;
    const byIdKey = `${engine}::${sessionId}`;
    let existingById = ledger.bySession[byIdKey] || null;
    if (!existingById) {
      const legacyMatches = Object.values(ledger.entries)
        .filter((e) => e && e.engine === engine && e.sessionId === sessionId)
        .sort((a, b) => {
          const hwDiff = (b.hadWorktree ? 1 : 0) - (a.hadWorktree ? 1 : 0);
          return hwDiff !== 0 ? hwDiff : String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""));
        });
      existingById = legacyMatches[0] || null;
    }

    // Never inherit worktree/patch bindings from a DIFFERENT sessionId under the same key.
    // On a non-write (readonly) run, preserve existing worktree binding only if it belongs
    // to this exact (engine, sessionId) so cross-role resume never strips write state.
    const preserveExistingWrite = !isWriteRun && Boolean(existingById?.hadWorktree);
    const resolvedEntry = {
      workflowId,
      role,
      engine,
      sessionId,
      sessionCwd,
      model,
      effort,
      worktreeId: isWriteRun ? worktreeId ?? existingById?.worktreeId ?? null : preserveExistingWrite ? existingById.worktreeId ?? null : null,
      worktreePath: isWriteRun ? worktreePath ?? null : preserveExistingWrite ? existingById.worktreePath ?? null : null,
      baseSha: isWriteRun ? baseSha ?? existingById?.baseSha ?? null : preserveExistingWrite ? existingById.baseSha ?? null : null,
      patchPath: isWriteRun ? patchPath ?? null : preserveExistingWrite ? existingById.patchPath ?? null : null,
      patchSha256: isWriteRun ? patchSha256 ?? null : preserveExistingWrite ? existingById.patchSha256 ?? null : null,
      deliverableMode: isWriteRun ? deliverableMode ?? null : preserveExistingWrite ? existingById.deliverableMode ?? null : null,
      finalHeadSha: isWriteRun ? finalHeadSha ?? null : preserveExistingWrite ? existingById.finalHeadSha ?? null : null,
      captureComplete: isWriteRun ? Boolean(captureComplete) : preserveExistingWrite ? existingById.captureComplete !== false : true,
      hadWorktree: Boolean(isWriteRun || preserveExistingWrite),
      updatedAt: nowIso()
    };

    ledger.entries[key] = resolvedEntry;
    ledger.bySession[byIdKey] = resolvedEntry;
    writeJsonAtomic(file, ledger);
  });
}

export function lookupRoleSession(cwd, { workflowId = "default", role, engine }) {
  const ledger = loadSessionLedger(cwd);
  const exact = ledger.entries?.[`${workflowId}::${role}::${engine}`];
  if (exact) {
    return exact;
  }
  if (workflowId === "latest") {
    const matches = Object.values(ledger.entries ?? {})
      .filter((entry) => entry.role === role && entry.engine === engine)
      .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
    return matches[0] ?? null;
  }
  return null;
}

export function lookupSessionById(cwd, { engine, sessionId }) {
  if (!engine || !sessionId) return null;
  const ledger = loadSessionLedger(cwd);
  const indexed = ledger.bySession?.[`${engine}::${sessionId}`];
  if (indexed) {
    return indexed;
  }
  const matches = Object.values(ledger.entries ?? {})
    .filter((entry) => entry.engine === engine && entry.sessionId === sessionId)
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  return matches[0] ?? null;
}

export function acquireSessionLease(cwd, engine, sessionId, ownerId) {
  if (!engine || !sessionId) return true;
  const file = sessionLedgerPath(cwd);
  return withFileLockSync(file, () => {
    const ledger = readJsonSafe(file, { entries: {}, bySession: {}, leases: {} });
    ledger.leases = ledger.leases || {};
    const key = `${engine}::${sessionId}`;
    const existing = ledger.leases[key];
    if (existing && existing.ownerId !== ownerId) {
      let alive = false;
      if (Number.isInteger(existing.pid) && existing.pid > 0) {
        try {
          process.kill(existing.pid, 0);
          alive = true;
        } catch (e) {
          alive = e?.code === "EPERM";
        }
      }
      if (alive) {
        return false;
      }
    }
    ledger.leases[key] = { ownerId, pid: process.pid, acquiredAt: nowIso() };
    writeJsonAtomic(file, ledger);
    return true;
  });
}

export function releaseSessionLease(cwd, engine, sessionId, ownerId) {
  if (!engine || !sessionId) return;
  const file = sessionLedgerPath(cwd);
  withFileLockSync(file, () => {
    const ledger = readJsonSafe(file, { entries: {}, leases: {} });
    const key = `${engine}::${sessionId}`;
    if (ledger.leases?.[key]?.ownerId === ownerId) {
      delete ledger.leases[key];
      writeJsonAtomic(file, ledger);
    }
  });
}

// --- Job Registry ---

function jobsIndexPath(cwd) {
  return path.join(resolveStateDir(cwd), "jobs.json");
}

export function resolveJobFile(cwd, jobId) {
  const safeId = validateOpaqueId(jobId, "jobId");
  const jobsDir = ensureSubdir(cwd, "jobs");
  return assertPathInside(jobsDir, path.join(jobsDir, `${safeId}.json`), "jobFile");
}

export function resolveJobLogFile(cwd, jobId) {
  const safeId = validateOpaqueId(jobId, "jobId");
  const jobsDir = ensureSubdir(cwd, "jobs");
  return assertPathInside(jobsDir, path.join(jobsDir, `${safeId}.log`), "jobLogFile");
}

export function formatProgressLine(msg) {
  if (typeof msg === "string") {
    return msg.trimEnd();
  }
  if (msg && typeof msg === "object") {
    const phase = msg.phase ? `[${msg.phase}] ` : "";
    const text = msg.message || msg.text || msg.stderrMessage || msg.logTitle || JSON.stringify(msg);
    return `${phase}${String(text).trimEnd()}`;
  }
  return String(msg ?? "").trimEnd();
}

export function appendJobLog(logFile, msg) {
  if (!logFile || msg == null) {
    return;
  }
  const line = formatProgressLine(msg);
  if (!line) return;
  fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  fs.appendFileSync(logFile, `[${nowIso()}] ${line}\n`, { encoding: "utf8", mode: 0o600 });
}

export function readLogTail(logFile, maxLines = 40, maxBytes = 16384) {
  if (!logFile || !fs.existsSync(logFile)) {
    return "";
  }
  const st = fs.statSync(logFile);
  if (st.size === 0) return "";
  const readSize = Math.min(st.size, maxBytes);
  const start = st.size - readSize;
  const fd = fs.openSync(logFile, "r");
  try {
    const buf = Buffer.allocUnsafe(readSize);
    fs.readSync(fd, buf, 0, readSize, start);
    let text = buf.toString("utf8");
    if (start > 0) {
      const firstNl = text.indexOf("\n");
      if (firstNl !== -1) text = text.slice(firstNl + 1);
    }
    return text.split(/\r?\n/).filter(Boolean).slice(-maxLines).join("\n");
  } finally {
    fs.closeSync(fd);
  }
}

export function listJobs(cwd) {
  const data = readJsonSafe(jobsIndexPath(cwd), { jobs: [] });
  return Array.isArray(data.jobs) ? data.jobs : [];
}

function summarizeJobForIndex(fullJob) {
  return {
    id: fullJob.id,
    kind: fullJob.kind,
    workflowId: fullJob.workflowId,
    role: fullJob.role,
    mode: fullJob.mode,
    status: fullJob.status,
    engine: fullJob.engine,
    model: fullJob.model,
    effort: fullJob.effort,
    pid: fullJob.pid ?? null,
    sessionId: fullJob.sessionId ?? null,
    worktreePath: fullJob.worktreePath ?? null,
    patchPath: fullJob.patchPath ?? null,
    handoffId: fullJob.handoffId ?? null,
    logFile: fullJob.logFile ?? null,
    startedAt: fullJob.startedAt ?? null,
    completedAt: fullJob.completedAt ?? null,
    createdAt: fullJob.createdAt ?? null,
    updatedAt: fullJob.updatedAt ?? null,
    error: fullJob.error ?? null
  };
}

export function upsertJob(cwd, patch) {
  const safeId = validateOpaqueId(patch.id, "jobId");
  const indexFile = jobsIndexPath(cwd);
  return withFileLockSync(indexFile, () => {
    const index = readJsonSafe(indexFile, { jobs: [] });
    const jobs = Array.isArray(index.jobs) ? index.jobs : [];
    const ts = nowIso();

    const detailFile = resolveJobFile(cwd, safeId);
    const existingDetail = readJsonSafe(detailFile, {});
    const mergedDetail = {
      createdAt: existingDetail.createdAt || ts,
      ...existingDetail,
      ...patch,
      id: safeId,
      updatedAt: ts
    };
    writeJsonAtomic(detailFile, mergedDetail);

    const summary = summarizeJobForIndex(mergedDetail);
    const idx = jobs.findIndex((j) => j.id === safeId);
    if (idx === -1) {
      jobs.unshift(summary);
    } else {
      jobs[idx] = { ...jobs[idx], ...summary };
    }

    const sorted = jobs.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
    const kept = sorted.slice(0, MAX_JOBS);
    const evicted = sorted.slice(MAX_JOBS);
    writeJsonAtomic(indexFile, { jobs: kept });

    for (const old of evicted) {
      try {
        const oldDetail = resolveJobFile(cwd, old.id);
        if (fs.existsSync(oldDetail)) fs.unlinkSync(oldDetail);
        const oldLog = resolveJobLogFile(cwd, old.id);
        if (fs.existsSync(oldLog)) fs.unlinkSync(oldLog);
      } catch {
        // Ignore pruning errors.
      }
    }

    return mergedDetail;
  });
}

export function readJobDetail(cwd, jobId, { exact = false } = {}) {
  const safeId = validateOpaqueId(jobId, "jobId");
  const jobs = listJobs(cwd);
  const match = exact
    ? jobs.find((j) => j.id === safeId)
    : (jobs.find((j) => j.id === safeId) ?? jobs.find((j) => j.id.startsWith(safeId)));
  const targetId = match ? match.id : safeId;
  if (exact && !match) {
    const exactFile = resolveJobFile(cwd, safeId);
    if (!fs.existsSync(exactFile)) return null;
  }
  const detailFile = resolveJobFile(cwd, targetId);
  const detail = readJsonSafe(detailFile, null);
  if (!match && !detail) {
    return null;
  }
  return { ...(match ?? {}), ...(detail ?? {}) };
}

// --- Shared Board (boards/<boardId>.jsonl) ---

export function resolveBoardFile(cwd, boardId = "default") {
  const safeId = validateOpaqueId(boardId || "default", "boardId");
  const boardsDir = ensureSubdir(cwd, "boards");
  return assertPathInside(boardsDir, path.join(boardsDir, `${safeId}.jsonl`), "boardFile");
}

export function resolveBoardPinsFile(cwd, boardId = "default") {
  const safeId = validateOpaqueId(boardId || "default", "boardId");
  const boardsDir = ensureSubdir(cwd, "boards");
  return assertPathInside(boardsDir, path.join(boardsDir, `${safeId}.pins.json`), "boardPinsFile");
}

function isPinTag(tag) {
  const t = String(tag ?? "").toLowerCase();
  return t === "[decision]" || t === "[pin]" || t === "[blocker]";
}

function isRetireTag(tag) {
  const t = String(tag ?? "").toLowerCase();
  return t === "[unpin]" || t === "[resolve]";
}

function applyPinTransition(pins, record) {
  const next = Array.isArray(pins) ? pins.map((p) => ({ ...p })) : [];
  if (record.supersedes !== undefined && record.supersedes !== null && record.supersedes !== "") {
    const target = String(record.supersedes);
    for (const p of next) {
      if (p.status === "active" && (String(p.seq) === target || (p.pinId && p.pinId === target))) {
        p.status = isRetireTag(record.tag) ? "resolved" : "superseded";
        p.supersededBySeq = record.seq;
        p.supersededAt = record.timestamp;
      }
    }
  }
  if (isPinTag(record.tag)) {
    next.push({
      seq: record.seq,
      ...(record.pinId ? { pinId: record.pinId } : {}),
      timestamp: record.timestamp,
      author: record.author,
      tag: record.tag,
      ...(record.mentions?.length ? { mentions: record.mentions } : {}),
      text: record.text,
      ...(record.handoffId ? { handoffId: record.handoffId } : {}),
      ...(record.patchPath ? { patchPath: record.patchPath } : {}),
      ...(record.model ? { model: record.model } : {}),
      status: "active"
    });
  }
  return next;
}

function computeFileEdgeHashes(filePath, size) {
  if (!size || size <= 0) {
    return { headHash: null, tailHash: null };
  }
  const edgeBytes = Math.min(512, size);
  const fd = fs.openSync(filePath, "r");
  try {
    const headBuf = Buffer.alloc(edgeBytes);
    const hRead = fs.readSync(fd, headBuf, 0, edgeBytes, 0);
    const headHash = createHash("sha256").update(headBuf.subarray(0, hRead)).digest("hex").slice(0, 16);
    const tailOffset = Math.max(0, size - edgeBytes);
    const tailBuf = Buffer.alloc(edgeBytes);
    const tRead = fs.readSync(fd, tailBuf, 0, edgeBytes, tailOffset);
    const tailHash = createHash("sha256").update(tailBuf.subarray(0, tRead)).digest("hex").slice(0, 16);
    return { headHash, tailHash };
  } finally {
    fs.closeSync(fd);
  }
}

function repairBoardTailLocked(boardFile) {
  if (!fs.existsSync(boardFile)) return;
  const st = fs.statSync(boardFile);
  if (st.size === 0) return;

  const fd = fs.openSync(boardFile, "r");
  try {
    const lastByte = Buffer.alloc(1);
    fs.readSync(fd, lastByte, 0, 1, st.size - 1);
    if (lastByte[0] === 0x0a) {
      return;
    }
    // Unterminated tail: read trailing window, keep complete JSON if valid else truncate torn fragment.
    const scanLen = Math.min(st.size, 65536);
    const scanOffset = st.size - scanLen;
    const tailBuf = Buffer.alloc(scanLen);
    const n = fs.readSync(fd, tailBuf, 0, scanLen, scanOffset);
    const slice = tailBuf.subarray(0, n);
    const lastNl = slice.lastIndexOf(0x0a);
    const fragOffset = lastNl === -1 ? scanOffset : scanOffset + lastNl + 1;
    const fragText = slice.subarray(lastNl + 1).toString("utf8").trim();
    if (fragText) {
      try {
        JSON.parse(fragText);
        fs.closeSync(fd);
        fs.appendFileSync(boardFile, "\n", "utf8");
        return;
      } catch {
        // Fall through and truncate incomplete JSON line.
      }
    }
    fs.closeSync(fd);
    fs.truncateSync(boardFile, fragOffset);
    return;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Already closed on repair path.
    }
  }
}

function rebuildPinsFromBoardLocked(boardFile, pinsFile, boardId) {
  repairBoardTailLocked(boardFile);
  const st = fs.statSync(boardFile);
  const lines = fs.readFileSync(boardFile, "utf8").split(/\r?\n/).filter(Boolean);
  let pins = [];
  let lastSeq = 0;
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      pins = applyPinTransition(pins, rec);
      if (Number.isFinite(Number(rec.seq))) {
        lastSeq = Math.max(lastSeq, Number(rec.seq));
      }
    } catch {
      // Skip malformed line.
    }
  }
  const { headHash, tailHash } = computeFileEdgeHashes(boardFile, st.size);
  writeJsonAtomic(pinsFile, {
    boardId,
    indexedSeq: lastSeq,
    logSize: st.size,
    headHash,
    tailHash,
    updatedAt: nowIso(),
    pins
  });
  return pins;
}

export function readActiveBoardPins(cwd, boardId = "default") {
  const boardFile = resolveBoardFile(cwd, boardId);
  if (!fs.existsSync(boardFile)) {
    return [];
  }
  const pinsFile = resolveBoardPinsFile(cwd, boardId);
  const st = fs.statSync(boardFile);
  const { headHash, tailHash } = computeFileEdgeHashes(boardFile, st.size);
  const data = fs.existsSync(pinsFile) ? readJsonSafe(pinsFile, null) : null;

  const hasValidIdentity =
    data &&
    Array.isArray(data.pins) &&
    typeof data.logSize === "number" &&
    data.headHash &&
    data.headHash === headHash;

  if (hasValidIdentity) {
    if (data.logSize === st.size && data.tailHash === tailHash) {
      return data.pins.filter((p) => p.status === "active");
    }
    if (data.logSize >= 0 && data.logSize < st.size) {
      const deltaSize = st.size - data.logSize;
      const fd = fs.openSync(boardFile, "r");
      let tailText = "";
      try {
        const buf = Buffer.alloc(deltaSize);
        const bytesRead = fs.readSync(fd, buf, 0, deltaSize, data.logSize);
        tailText = buf.slice(0, bytesRead).toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
      if (tailText.endsWith("\n")) {
        let pins = data.pins.map((p) => ({ ...p }));
        let parseOk = true;
        let sawPinChange = false;
        for (const line of tailText.split(/\r?\n/).filter(Boolean)) {
          try {
            const rec = JSON.parse(line);
            if (isPinTag(rec.tag) || isRetireTag(rec.tag) || rec.supersedes !== undefined) {
              sawPinChange = true;
            }
            pins = applyPinTransition(pins, rec);
          } catch {
            parseOk = false;
            break;
          }
        }
        if (parseOk) {
          if (sawPinChange || deltaSize > 8192) {
            const reconciled = withFileLockSync(boardFile, () => rebuildPinsFromBoardLocked(boardFile, pinsFile, boardId));
            return reconciled.filter((p) => p.status === "active");
          }
          return pins.filter((p) => p.status === "active");
        }
      }
    }
  }

  // Missing, corrupt, torn-tail, or replaced log: rebuild strictly under the board lock.
  const pins = withFileLockSync(boardFile, () => rebuildPinsFromBoardLocked(boardFile, pinsFile, boardId));
  return pins.filter((p) => p.status === "active");
}

export function readBoardPostsBySeqs(cwd, boardId = "default", seqs = []) {
  const want = new Set((Array.isArray(seqs) ? seqs : []).map((n) => Number(n)).filter(Number.isFinite));
  if (want.size === 0) return [];
  const file = resolveBoardFile(cwd, boardId);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (want.has(Number(parsed.seq))) {
        out.push(parsed);
      }
    } catch {
      // Skip malformed line.
    }
  }
  return out;
}

export function readBoardPosts(cwd, boardId = "default", { since = 0, limit = 100 } = {}) {
  const file = resolveBoardFile(cwd, boardId);
  if (!fs.existsSync(file)) {
    return [];
  }
  const st = fs.statSync(file);
  let raw;
  // Bound tail read for large boards when only recent `limit` entries from the end are requested.
  if (since === 0 && limit > 0 && st.size > 65536) {
    const readSize = Math.min(st.size, Math.max(65536, limit * 2048));
    raw = readLogTail(file, Math.max(limit * 2, limit), readSize);
  } else {
    raw = fs.readFileSync(file, "utf8");
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const posts = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if ((parsed.seq ?? 0) > since) {
        posts.push(parsed);
      }
    } catch {
      // Skip malformed line.
    }
  }
  return limit > 0 ? posts.slice(-limit) : posts;
}

export function postBoardMessage(cwd, boardId = "default", entry = {}) {
  const safeBoardId = validateOpaqueId(boardId || "default", "boardId");
  const file = resolveBoardFile(cwd, safeBoardId);
  const pinsFile = resolveBoardPinsFile(cwd, safeBoardId);
  return withFileLockSync(file, () => {
    repairBoardTailLocked(file);
    let tail = readBoardPosts(cwd, safeBoardId, { since: 0, limit: 1 });
    if (tail.length === 0 && fs.existsSync(file) && fs.statSync(file).size > 0) {
      tail = readBoardPosts(cwd, safeBoardId, { since: 0, limit: 0 });
    }
    const nextSeq = (tail.at(-1)?.seq ?? 0) + 1;
    const text = String(entry.text ?? "").trim();
    const mentions = Array.isArray(entry.mentions)
      ? entry.mentions
      : [...new Set((text.match(/@([a-zA-Z0-9._-]+)/g) ?? []).map((m) => m.slice(1)))];
    const record = {
      seq: nextSeq,
      boardId: safeBoardId,
      timestamp: nowIso(),
      author: entry.author ?? "coordinator",
      tag: entry.tag ?? "[update]",
      mentions,
      text,
      ...(entry.pinId ? { pinId: String(entry.pinId) } : {}),
      ...(entry.supersedes !== undefined && entry.supersedes !== null && entry.supersedes !== ""
        ? { supersedes: entry.supersedes }
        : {}),
      ...(entry.handoffId ? { handoffId: entry.handoffId } : {}),
      ...(entry.patchPath ? { patchPath: entry.patchPath } : {}),
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      ...(entry.model ? { model: entry.model } : {})
    };
    const oldSize = fs.existsSync(file) ? fs.statSync(file).size : 0;
    const prevHeadHash = oldSize > 0 ? computeFileEdgeHashes(file, oldSize).headHash : null;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    const newSize = fs.statSync(file).size;
    const { headHash, tailHash } = computeFileEdgeHashes(file, newSize);

    // Keep dedicated active pins index watermark-aligned atomically under the board lock,
    // advancing the watermark on ordinary updates too so later pin posts don't force a full replay.
    const existingIndex = fs.existsSync(pinsFile) ? readJsonSafe(pinsFile, null) : null;
    const needsPinUpdate = isPinTag(record.tag) || isRetireTag(record.tag) || record.supersedes !== undefined;
    const indexAligned =
      existingIndex &&
      Array.isArray(existingIndex.pins) &&
      existingIndex.logSize === oldSize &&
      (!prevHeadHash || existingIndex.headHash === prevHeadHash);

    if (indexAligned) {
      const updatedPins = needsPinUpdate ? applyPinTransition(existingIndex.pins, record) : existingIndex.pins;
      writeJsonAtomic(pinsFile, {
        boardId: safeBoardId,
        indexedSeq: record.seq,
        logSize: newSize,
        headHash,
        tailHash,
        updatedAt: nowIso(),
        pins: updatedPins
      });
    } else if (needsPinUpdate || !existingIndex) {
      rebuildPinsFromBoardLocked(file, pinsFile, safeBoardId);
    }
    return record;
  });
}

// --- Sealed Design Vault & Review Gate Counters ---

export function resolveDesignVaultFile(cwd, designId) {
  const safeId = validateOpaqueId(designId, "designId");
  const dir = ensureSubdir(cwd, "designs");
  return assertPathInside(dir, path.join(dir, `${safeId}.json`), "designVaultFile");
}

export function saveDesignVault(cwd, designId, data) {
  const file = resolveDesignVaultFile(cwd, designId);
  return withFileLockSync(file, () => {
    writeJsonAtomic(file, { ...data, updatedAt: nowIso() });
    return file;
  });
}

export function loadDesignVault(cwd, designId) {
  const file = resolveDesignVaultFile(cwd, designId);
  return readJsonSafe(file, null);
}

export function updateDesignVault(cwd, designId, updater) {
  const file = resolveDesignVaultFile(cwd, designId);
  return withFileLockSync(file, () => {
    const current = readJsonSafe(file, null);
    if (!current) {
      throw new Error(`Design session "${designId}" not found.`);
    }
    const next = updater(current);
    writeJsonAtomic(file, { ...next, updatedAt: nowIso() });
    return next;
  });
}

export function resolveReviewGateFile(cwd, gateKey) {
  const safeId = validateOpaqueId(gateKey, "gateKey");
  const dir = ensureSubdir(cwd, "review-gates");
  return assertPathInside(dir, path.join(dir, `${safeId}.json`), "reviewGateFile");
}

export function loadReviewGateState(cwd, gateKey) {
  return readJsonSafe(resolveReviewGateFile(cwd, gateKey), { gateKey, round: 0, history: [] });
}

export function saveReviewGateState(cwd, gateKey, state) {
  const file = resolveReviewGateFile(cwd, gateKey);
  return withFileLockSync(file, () => {
    writeJsonAtomic(file, { ...state, updatedAt: nowIso() });
    return state;
  });
}

export function withReviewGateLock(cwd, gateKey, fn) {
  const file = resolveReviewGateFile(cwd, gateKey);
  return withFileLockSync(file, () => {
    const current = readJsonSafe(file, { gateKey, round: 0, history: [] });
    return fn(current, (nextState) => {
      writeJsonAtomic(file, { ...nextState, updatedAt: nowIso() });
      return nextState;
    });
  });
}

// --- Immutable Review Artifacts ---

export function resolveReviewArtifactFile(cwd, reviewId) {
  const safeId = validateOpaqueId(reviewId, "reviewId");
  const dir = ensureSubdir(cwd, "reviews");
  return assertPathInside(dir, path.join(dir, `${safeId}.json`), "reviewArtifactFile");
}

export function saveReviewArtifact(cwd, reviewId, payload) {
  const file = resolveReviewArtifactFile(cwd, reviewId);
  return withFileLockSync(file, () => {
    if (fs.existsSync(file)) {
      throw new Error(`Review artifact "${reviewId}" already exists (write-once).`);
    }
    writeJsonAtomic(file, { ...payload, reviewId, updatedAt: nowIso() });
    return file;
  });
}

export function loadReviewArtifact(cwd, reviewId) {
  const file = resolveReviewArtifactFile(cwd, reviewId);
  return readJsonSafe(file, null);
}
