import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { canonicalizePath, runSync } from "./env.mjs";
import { assertPathInside, ensureSubdir, generateId, validateOpaqueId } from "./state.mjs";

export function isGitRepo(cwd) {
  const res = runSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeoutMs: 3000 });
  return res.status === 0 && String(res.stdout).trim() === "true";
}

export function getGitHeadSha(cwd) {
  const res = runSync("git", ["rev-parse", "--verify", "HEAD"], { cwd, timeoutMs: 3000 });
  return res.status === 0 ? String(res.stdout).trim() : null;
}

export function getGitBranch(cwd) {
  const res = runSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutMs: 3000 });
  return res.status === 0 ? String(res.stdout).trim() : null;
}

/**
 * Parse `git status --porcelain=v1 -z -uall` safely, handling spaces, unicode,
 * and renames/copies (`XY newPath\0oldPath\0`) while preserving BOTH paths.
 */
export function parsePorcelainZ(bufStr) {
  if (!bufStr) return [];
  const entries = bufStr.split("\0");
  const files = [];
  for (let i = 0; i < entries.length; i += 1) {
    const token = entries[i];
    if (!token) continue;
    const status = token.slice(0, 2);
    const filePath = token.slice(3);
    if (filePath) {
      files.push(filePath);
    }
    if ((status[0] === "R" || status[0] === "C") && i + 1 < entries.length) {
      const origPath = entries[i + 1];
      if (origPath) {
        files.push(origPath);
      }
      i += 1;
    }
  }
  return [...new Set(files)];
}

export function createIsolatedWorktree(repoRoot, { id = null, branch = null, baseSha: explicitBaseSha = null } = {}) {
  if (!isGitRepo(repoRoot)) {
    throw new Error(`Cannot create isolated git worktree: ${repoRoot} is not inside a git repository.`);
  }
  let baseSha = getGitHeadSha(repoRoot);
  if (explicitBaseSha) {
    const cleanBase = String(explicitBaseSha).trim();
    if (!cleanBase || cleanBase.startsWith("-")) {
      throw new Error(`Invalid worktree baseSha "${cleanBase}".`);
    }
    const check = runSync("git", ["rev-parse", "--verify", "--end-of-options", `${cleanBase}^{commit}`], {
      cwd: repoRoot,
      timeoutMs: 3000
    });
    if (check.status !== 0 || !String(check.stdout).trim()) {
      throw new Error(`Worktree baseSha "${cleanBase}" does not resolve to a valid commit.`);
    }
    baseSha = String(check.stdout).trim();
  }
  if (!baseSha) {
    throw new Error(
      `Cannot create isolated git worktree in ${repoRoot}: repository has no commits (HEAD is unborn). Create an initial commit first.`
    );
  }

  const worktreeId = validateOpaqueId(id || generateId("wt"), "worktreeId");
  const worktreesDir = ensureSubdir(repoRoot, "worktrees");
  const worktreePath = assertPathInside(worktreesDir, path.join(worktreesDir, worktreeId), "worktreePath");
  if (fs.existsSync(worktreePath)) {
    throw new Error(`Worktree directory already exists (refusing to overwrite): ${worktreePath}`);
  }

  const args = branch
    ? ["worktree", "add", "-b", branch, worktreePath, baseSha]
    : ["worktree", "add", "--detach", worktreePath, baseSha];

  const res = runSync("git", args, { cwd: repoRoot, timeoutMs: 30000 });
  if (res.status !== 0) {
    throw new Error(`git worktree add failed: ${String(res.stderr).trim() || String(res.stdout).trim()}`);
  }

  return {
    worktreeId,
    repoRoot,
    worktreePath,
    branch: branch || null,
    baseSha
  };
}

function matchPathRule(filePath, rule) {
  const normFile = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const normRule = String(rule || "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (!normRule) return false;
  if (normRule.endsWith("/**")) {
    const prefix = normRule.slice(0, -3);
    return normFile === prefix || normFile.startsWith(`${prefix}/`);
  }
  if (normRule.endsWith("/")) {
    return normFile.startsWith(normRule);
  }
  if (normRule.includes("*")) {
    const escaped = normRule.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(normFile);
  }
  return normFile === normRule || normFile.startsWith(`${normRule}/`);
}

export function auditFileScope(changedFiles = [], { ownedFiles = [], forbiddenFiles = [] } = {}) {
  const violations = [];
  for (const file of changedFiles) {
    for (const forbidden of forbiddenFiles) {
      if (matchPathRule(file, forbidden)) {
        violations.push(`Modified forbidden path "${file}" (matches "${forbidden}").`);
      }
    }
    if (ownedFiles.length > 0 && !ownedFiles.some((owned) => matchPathRule(file, owned))) {
      violations.push(`Modified unowned path "${file}" (outside ownedFiles: ${ownedFiles.join(", ")}).`);
    }
  }
  return violations;
}

/**
 * Capture ALL changes produced inside an isolated worktree since `baseSha`,
 * including uncommitted edits, untracked files (even with showUntrackedFiles=no),
 * ignored deliverables, AND any commits made on detached HEAD.
 * Captures raw bytes losslessly via Buffer.
 */
export function captureWorktreeChanges(repoRoot, worktreePath, worktreeId, baseSha, { patchId = null } = {}) {
  const finalHeadSha = getGitHeadSha(worktreePath);
  const statusRes = runSync("git", ["status", "--porcelain=v1", "-z", "-uall"], {
    cwd: worktreePath,
    timeoutMs: 10000
  });
  if (statusRes.status !== 0 || statusRes.error) {
    return {
      hasChanges: true,
      deliverableMode: "incomplete",
      ignoredOnlyDeliverables: false,
      captureComplete: false,
      error: `git status failed in worktree: ${statusRes.stderr || statusRes.error?.message || statusRes.status}`,
      changedFiles: [],
      ignoredFiles: [],
      ignoredFilesTotal: 0,
      allIgnoredFiles: [],
      patchPath: null,
      patchSha256: null,
      diffStat: "",
      finalHeadSha
    };
  }

  const ignoredRes = runSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], {
    cwd: worktreePath,
    timeoutMs: 10000
  });
  if (ignoredRes.status !== 0 || ignoredRes.error) {
    return {
      hasChanges: true,
      deliverableMode: "incomplete",
      ignoredOnlyDeliverables: false,
      captureComplete: false,
      error: `git ls-files --ignored failed in worktree: ${ignoredRes.stderr || ignoredRes.error?.message || ignoredRes.status}`,
      changedFiles: parsePorcelainZ(String(statusRes.stdout)),
      ignoredFiles: [],
      ignoredFilesTotal: 0,
      allIgnoredFiles: [],
      patchPath: null,
      patchSha256: null,
      diffStat: "",
      finalHeadSha
    };
  }
  const allIgnoredFiles = String(ignoredRes.stdout).split("\0").filter(Boolean);
  const ignoredFilesTotal = allIgnoredFiles.length;
  const ignoredFiles = allIgnoredFiles.slice(0, 50);

  const workingChanged = parsePorcelainZ(String(statusRes.stdout));
  let committedChanged = [];
  if (baseSha && finalHeadSha && finalHeadSha !== baseSha) {
    const committedRes = runSync("git", ["diff", "--name-only", "--no-renames", "-z", baseSha, finalHeadSha], {
      cwd: worktreePath,
      timeoutMs: 10000
    });
    if (committedRes.status !== 0 || committedRes.error) {
      return {
        hasChanges: true,
        deliverableMode: "incomplete",
        ignoredOnlyDeliverables: false,
        captureComplete: false,
        error: `git diff --name-only failed in worktree: ${committedRes.stderr || committedRes.error?.message}`,
        changedFiles: workingChanged,
        ignoredFiles,
        ignoredFilesTotal,
        allIgnoredFiles,
        patchPath: null,
        patchSha256: null,
        diffStat: "",
        finalHeadSha
      };
    }
    committedChanged = String(committedRes.stdout).split("\0").filter(Boolean);
  }

  let changedFiles = [...new Set([...committedChanged, ...workingChanged])];
  if (changedFiles.length === 0) {
    return {
      hasChanges: ignoredFilesTotal > 0,
      deliverableMode: ignoredFilesTotal > 0 ? "ignored-only" : "none",
      ignoredOnlyDeliverables: ignoredFilesTotal > 0,
      captureComplete: true,
      error: null,
      changedFiles: [],
      ignoredFiles,
      ignoredFilesTotal,
      allIgnoredFiles,
      patchPath: null,
      patchSha256: null,
      diffStat: "",
      finalHeadSha
    };
  }

  if (workingChanged.length > 0) {
    const addRes = runSync("git", ["add", "-N", "."], { cwd: worktreePath, timeoutMs: 10000 });
    if (addRes.status !== 0 || addRes.error) {
      return {
        hasChanges: true,
        deliverableMode: "incomplete",
        ignoredOnlyDeliverables: false,
        captureComplete: false,
        error: `git add -N failed in worktree: ${addRes.stderr || addRes.error?.message}`,
        changedFiles,
        ignoredFiles,
        ignoredFilesTotal,
        allIgnoredFiles,
        patchPath: null,
        patchSha256: null,
        diffStat: "",
        finalHeadSha
      };
    }
  }

  const baseRef = baseSha || "HEAD";
  const diffRes = runSync("git", ["diff", "--binary", "--no-renames", baseRef], {
    cwd: worktreePath,
    encoding: "buffer",
    timeoutMs: 30000,
    maxBuffer: 50 * 1024 * 1024
  });
  const statRes = runSync("git", ["diff", "--stat", "--no-renames", baseRef], {
    cwd: worktreePath,
    timeoutMs: 15000
  });

  if (diffRes.status !== 0 || diffRes.error) {
    return {
      hasChanges: true,
      deliverableMode: "incomplete",
      ignoredOnlyDeliverables: false,
      captureComplete: false,
      error: `git diff failed in worktree: ${String(diffRes.stderr) || diffRes.error?.message}`,
      changedFiles,
      ignoredFiles,
      ignoredFilesTotal,
      allIgnoredFiles,
      patchPath: null,
      patchSha256: null,
      diffStat: String(statRes.stdout || "").trim(),
      finalHeadSha
    };
  }

  // Also extract every path listed in `git diff --name-only --no-renames -z baseRef` so
  // `changedFiles` strictly binds to the exact patch artifact accepted by relay_apply.
  const patchNamesRes = runSync("git", ["diff", "--name-only", "--no-renames", "-z", baseRef], {
    cwd: worktreePath,
    timeoutMs: 10000
  });
  if (patchNamesRes.status === 0 && !patchNamesRes.error) {
    const patchNames = String(patchNamesRes.stdout).split("\0").filter(Boolean);
    changedFiles = [...new Set([...changedFiles, ...patchNames])];
  }

  const patchesDir = ensureSubdir(repoRoot, "patches");
  const safeId = validateOpaqueId(patchId || worktreeId, "patchId");
  const patchPath = assertPathInside(patchesDir, path.join(patchesDir, `${safeId}.patch`), "patchPath");
  fs.writeFileSync(patchPath, diffRes.stdout, { mode: 0o600 });
  const patchSha256 = crypto.createHash("sha256").update(diffRes.stdout).digest("hex");

  return {
    hasChanges: true,
    deliverableMode: "patch",
    ignoredOnlyDeliverables: false,
    captureComplete: true,
    error: null,
    changedFiles,
    ignoredFiles,
    ignoredFilesTotal,
    allIgnoredFiles,
    patchPath,
    patchSha256,
    diffStat: String(statRes.stdout || "").trim(),
    finalHeadSha
  };
}

function decodeGitCQuotedPath(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (!(s.startsWith('"') && s.endsWith('"'))) return s;
  const inner = s.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] === "\\" && i + 1 < inner.length) {
      const next = inner[i + 1];
      if (/[0-7]{3}/.test(inner.slice(i + 1, i + 4))) {
        bytes.push(Number.parseInt(inner.slice(i + 1, i + 4), 8));
        i += 3;
        continue;
      }
      const escMap = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 92, '"': 34 };
      if (escMap[next] !== undefined) {
        bytes.push(escMap[next]);
        i += 1;
        continue;
      }
    }
    const chBytes = Buffer.from(inner[i], "utf8");
    for (const b of chBytes) bytes.push(b);
  }
  return Buffer.from(bytes).toString("utf8");
}

export function extractPatchTouchedFiles(patchInput, repoRoot = process.cwd()) {
  const patchBuf = Buffer.isBuffer(patchInput) ? patchInput : Buffer.from(String(patchInput || ""), "utf8");
  if (patchBuf.length === 0) {
    return [];
  }
  const res = runSync("git", ["apply", "--numstat", "-z", "-"], {
    cwd: repoRoot,
    input: patchBuf,
    timeoutMs: 15000
  });
  if (res.status !== 0 || res.error) {
    throw new Error(
      `Patch failed git --numstat validation: ${String(res.stderr || res.error?.message || res.status).trim()}`
    );
  }
  const parts = String(res.stdout || "").split("\0");
  const touched = new Set();
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (!entry) continue;
    const tab1 = entry.indexOf("\t");
    const tab2 = tab1 !== -1 ? entry.indexOf("\t", tab1 + 1) : -1;
    if (tab2 === -1) continue;
    const rest = entry.slice(tab2 + 1);
    if (rest === "" && i + 2 < parts.length) {
      if (parts[i + 1]) touched.add(parts[i + 1]);
      if (parts[i + 2]) touched.add(parts[i + 2]);
      i += 2;
    } else if (rest) {
      touched.add(rest);
    }
  }

  // Also capture rename/copy source & destination ONLY inside extended diff headers
  // (before `@@ ` / `GIT binary patch`) because Git 2.25.1 `--numstat -z` emits only destination.
  let inDiffHeader = false;
  for (const line of patchBuf.toString("utf8").split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      inDiffHeader = true;
      continue;
    }
    if (!inDiffHeader) continue;
    if (line.startsWith("@@ ") || line.startsWith("GIT binary patch") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      if (line.startsWith("@@ ") || line.startsWith("GIT binary patch")) {
        inDiffHeader = false;
      }
      continue;
    }
    if (line.startsWith("rename from ") || line.startsWith("copy from ")) {
      const src = decodeGitCQuotedPath(line.slice(line.indexOf("from ") + 5));
      if (src) touched.add(src);
    } else if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
      const dst = decodeGitCQuotedPath(line.slice(line.indexOf("to ") + 3));
      if (dst) touched.add(dst);
    }
  }

  return [...touched].filter(Boolean);
}

export function applyPatchToWorktree(worktreePath, patchPath, { expectedSha256 = null } = {}) {
  if (!worktreePath || !fs.existsSync(worktreePath)) {
    throw new Error(`Target worktree does not exist: ${worktreePath}`);
  }
  if (!patchPath || !fs.existsSync(patchPath)) {
    throw new Error(`Replay patch file not found: ${patchPath}`);
  }
  const patchBuf = fs.readFileSync(patchPath);
  if (expectedSha256) {
    const actualSha = crypto.createHash("sha256").update(patchBuf).digest("hex");
    if (actualSha !== expectedSha256) {
      throw new Error(`Replay patch integrity check failed for ${patchPath}: expected ${expectedSha256}, got ${actualSha}.`);
    }
  }
  const res = runSync("git", ["apply", "--binary", "-"], { cwd: worktreePath, input: patchBuf, timeoutMs: 15000 });
  if (res.status !== 0) {
    throw new Error(`Failed to replay prior patch into worktree: ${String(res.stderr).trim() || String(res.stdout).trim()}`);
  }
  return { ok: true, worktreePath, patchPath };
}

export function removeIsolatedWorktree(repoRoot, worktreePath) {
  if (!worktreePath || !fs.existsSync(worktreePath)) {
    return { removed: false };
  }
  const worktreesDir = ensureSubdir(repoRoot, "worktrees");
  assertPathInside(worktreesDir, canonicalizePath(worktreePath), "worktreePath");
  const res = runSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoRoot, timeoutMs: 15000 });
  if (res.status !== 0 && fs.existsSync(worktreePath)) {
    fs.rmSync(worktreePath, { recursive: true, force: true });
    runSync("git", ["worktree", "prune"], { cwd: repoRoot, timeoutMs: 10000 });
  }
  return { removed: true };
}

export function applyWorktreePatch(repoRoot, patchPath, { mode = "check", patchBuf = null } = {}) {
  if (!isGitRepo(repoRoot)) {
    throw new Error(`Target workspace is not a git repository: ${repoRoot}`);
  }
  const patchesDir = ensureSubdir(repoRoot, "patches");
  const resolvedPatch = assertPathInside(patchesDir, canonicalizePath(patchPath), "patchPath");
  if (!patchBuf && !fs.existsSync(resolvedPatch)) {
    throw new Error(`Patch file not found: ${resolvedPatch}`);
  }
  const buf = Buffer.isBuffer(patchBuf) ? patchBuf : fs.readFileSync(resolvedPatch);

  const args = mode === "apply" ? ["apply", "--index", "-"] : ["apply", "--check", "-"];
  let res = runSync("git", args, { cwd: repoRoot, input: buf, timeoutMs: 15000 });
  if (res.status !== 0 && mode === "apply") {
    res = runSync("git", ["apply", "-"], { cwd: repoRoot, input: buf, timeoutMs: 15000 });
  }
  if (res.status !== 0) {
    throw new Error(`git apply (${mode}) failed: ${String(res.stderr).trim() || String(res.stdout).trim()}`);
  }
  return {
    ok: true,
    mode,
    patchPath: resolvedPatch,
    detail: String(res.stdout).trim() || `Patch ${mode} succeeded.`
  };
}

export function applyJobPatch(repoRoot, job, { mode = "check" } = {}) {
  if (!job || job.status !== "completed") {
    throw new Error(`Refusing to apply patch from non-completed job "${job?.id ?? "unknown"}" (status=${job?.status ?? "unknown"}).`);
  }
  if (Array.isArray(job.scopeViolations) && job.scopeViolations.length > 0) {
    throw new Error(`Refusing to apply patch with scope violation(s): ${job.scopeViolations.join("; ")}`);
  }
  const patchPath = job.patchPath;
  if (!patchPath) {
    throw new Error(`Job "${job.id}" has no captured patchPath.`);
  }
  if (mode === "apply" && !job.patchSha256) {
    throw new Error(`Refusing to apply legacy or unauthenticated patch for job "${job.id}" without patchSha256.`);
  }
  const patchesDir = ensureSubdir(repoRoot, "patches");
  const resolvedPatch = assertPathInside(patchesDir, canonicalizePath(patchPath), "patchPath");
  if (!fs.existsSync(resolvedPatch)) {
    throw new Error(`Patch file not found: ${resolvedPatch}`);
  }

  const patchBuf = fs.readFileSync(resolvedPatch);
  if (job.patchSha256) {
    const actualSha = crypto.createHash("sha256").update(patchBuf).digest("hex");
    if (actualSha !== job.patchSha256) {
      throw new Error(
        `Patch integrity check failed for job "${job.id}": expected SHA-256 ${job.patchSha256}, got ${actualSha}.`
      );
    }
  }

  const touchedFiles = extractPatchTouchedFiles(patchBuf, repoRoot);
  if (touchedFiles.length > 0) {
    const reAuditViolations = auditFileScope(touchedFiles, {
      ownedFiles: Array.isArray(job.ownedFiles) ? job.ownedFiles : [],
      forbiddenFiles: Array.isArray(job.forbiddenFiles) && job.forbiddenFiles.length > 0 ? job.forbiddenFiles : ["docs/handoff.md"]
    });
    if (reAuditViolations.length > 0) {
      throw new Error(`Refusing to apply patch failing apply-time scope re-audit: ${reAuditViolations.join("; ")}`);
    }
  }

  return applyWorktreePatch(repoRoot, resolvedPatch, { mode, patchBuf });
}
