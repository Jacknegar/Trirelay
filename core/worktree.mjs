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
export function captureWorktreeChanges(repoRoot, worktreePath, worktreeId, baseSha) {
  const finalHeadSha = getGitHeadSha(worktreePath);
  const statusRes = runSync("git", ["status", "--porcelain=v1", "-z", "-uall"], {
    cwd: worktreePath,
    timeoutMs: 10000
  });
  if (statusRes.status !== 0 || statusRes.error) {
    return {
      hasChanges: true,
      captureComplete: false,
      error: `git status failed in worktree: ${statusRes.stderr || statusRes.error?.message || statusRes.status}`,
      changedFiles: [],
      ignoredFiles: [],
      patchPath: null,
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
      captureComplete: false,
      error: `git ls-files --ignored failed in worktree: ${ignoredRes.stderr || ignoredRes.error?.message || ignoredRes.status}`,
      changedFiles: parsePorcelainZ(String(statusRes.stdout)),
      ignoredFiles: [],
      patchPath: null,
      diffStat: "",
      finalHeadSha
    };
  }
  const ignoredFiles = String(ignoredRes.stdout).split("\0").filter(Boolean);

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
        captureComplete: false,
        error: `git diff --name-only failed in worktree: ${committedRes.stderr || committedRes.error?.message}`,
        changedFiles: workingChanged,
        ignoredFiles,
        patchPath: null,
        diffStat: "",
        finalHeadSha
      };
    }
    committedChanged = String(committedRes.stdout).split("\0").filter(Boolean);
  }

  let changedFiles = [...new Set([...committedChanged, ...workingChanged])];
  if (changedFiles.length === 0) {
    return {
      hasChanges: ignoredFiles.length > 0,
      deliverableMode: ignoredFiles.length > 0 ? "ignored-only" : "none",
      ignoredOnlyDeliverables: ignoredFiles.length > 0,
      captureComplete: true,
      error: null,
      changedFiles: [],
      ignoredFiles,
      patchPath: null,
      diffStat: "",
      finalHeadSha
    };
  }

  if (workingChanged.length > 0) {
    const addRes = runSync("git", ["add", "-N", "."], { cwd: worktreePath, timeoutMs: 10000 });
    if (addRes.status !== 0 || addRes.error) {
      return {
        hasChanges: true,
        captureComplete: false,
        error: `git add -N failed in worktree: ${addRes.stderr || addRes.error?.message}`,
        changedFiles,
        ignoredFiles,
        patchPath: null,
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
      captureComplete: false,
      error: `git diff failed in worktree: ${String(diffRes.stderr) || diffRes.error?.message}`,
      changedFiles,
      ignoredFiles,
      patchPath: null,
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
  const safeId = validateOpaqueId(worktreeId, "worktreeId");
  const patchPath = assertPathInside(patchesDir, path.join(patchesDir, `${safeId}.patch`), "patchPath");
  fs.writeFileSync(patchPath, diffRes.stdout, { mode: 0o600 });

  return {
    hasChanges: true,
    deliverableMode: "patch",
    ignoredOnlyDeliverables: false,
    captureComplete: true,
    error: null,
    changedFiles,
    ignoredFiles,
    patchPath,
    diffStat: String(statRes.stdout || "").trim(),
    finalHeadSha
  };
}

export function applyPatchToWorktree(worktreePath, patchPath) {
  if (!worktreePath || !fs.existsSync(worktreePath)) {
    throw new Error(`Target worktree does not exist: ${worktreePath}`);
  }
  if (!patchPath || !fs.existsSync(patchPath)) {
    throw new Error(`Replay patch file not found: ${patchPath}`);
  }
  const res = runSync("git", ["apply", "--binary", patchPath], { cwd: worktreePath, timeoutMs: 15000 });
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

export function applyWorktreePatch(repoRoot, patchPath, { mode = "check" } = {}) {
  if (!isGitRepo(repoRoot)) {
    throw new Error(`Target workspace is not a git repository: ${repoRoot}`);
  }
  const patchesDir = ensureSubdir(repoRoot, "patches");
  const resolvedPatch = assertPathInside(patchesDir, canonicalizePath(patchPath), "patchPath");
  if (!fs.existsSync(resolvedPatch)) {
    throw new Error(`Patch file not found: ${resolvedPatch}`);
  }

  const args = mode === "apply" ? ["apply", "--index", resolvedPatch] : ["apply", "--check", resolvedPatch];
  let res = runSync("git", args, { cwd: repoRoot, timeoutMs: 15000 });
  if (res.status !== 0 && mode === "apply") {
    res = runSync("git", ["apply", resolvedPatch], { cwd: repoRoot, timeoutMs: 15000 });
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
