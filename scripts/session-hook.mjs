#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { buildTieredBoardView, truncateWithByteNotice } from "../core/compact.mjs";
import { canonicalizePath, resolveWorkspaceRoot, runSync } from "../core/env.mjs";
import { loadSessionLedger, readBoardPosts, readJsonSafe, resolveStateDir, saveHostSession } from "../core/state.mjs";

const MAX_SNAPSHOT_BYTES = 1500;

function firstNonEmptyPath(val) {
  if (!Array.isArray(val)) return null;
  for (const item of val) {
    if (typeof item === "string" && item.trim()) return item.trim();
  }
  return null;
}

function isSkippedDir(targetDir) {
  try {
    const canon = canonicalizePath(targetDir);
    if (canon === path.dirname(canon)) return true; // OS root "/"
    const home = canonicalizePath(os.homedir());
    if (canon === home) return true;
    return false;
  } catch {
    return true;
  }
}

function readLatestFileJson(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => {
      const full = path.join(dir, e.name);
      return { full, mtimeMs: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (entries.length === 0) return null;
  return readJsonSafe(entries[0].full, null);
}

function readLatestBoardId(boardsDir) {
  if (!boardsDir || !fs.existsSync(boardsDir)) return null;
  const entries = fs
    .readdirSync(boardsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => {
      const full = path.join(boardsDir, e.name);
      return { id: e.name.replace(/\.jsonl$/, ""), mtimeMs: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries[0]?.id ?? null;
}

function sanitizeSnapshotText(raw, maxChars = 90) {
  return String(raw || "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

export function buildContinuitySnapshot(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const lines = [];

  const stRes = runSync("git", ["--no-optional-locks", "status", "--porcelain=v1", "-b"], { cwd: workspaceRoot, timeoutMs: 250 });
  if (stRes.status === 0 && stRes.stdout) {
    const rawLines = stRes.stdout.split(/\r?\n/).filter(Boolean);
    const branchLine = rawLines[0] || "";
    const branch = branchLine.startsWith("## ")
      ? sanitizeSnapshotText(branchLine.slice(3).split("...")[0].replace(/^No commits yet on /, ""), 60)
      : "HEAD";
    const dirtyCount = Math.max(0, rawLines.length - 1);
    lines.push(`Workspace: ${sanitizeSnapshotText(path.basename(workspaceRoot), 60)} | Git: ${branch} (${dirtyCount} dirty)`);
  }

  const stateDir = resolveStateDir(workspaceRoot);
  const ledger = loadSessionLedger(workspaceRoot);
  const roleEntries = Object.values(ledger.entries ?? {})
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
    .slice(0, 4);
  if (roleEntries.length > 0) {
    const rolesSummary = roleEntries
      .map((r) => `${sanitizeSnapshotText(r.role, 32)}->${sanitizeSnapshotText(r.engine, 16)}${r.model ? `:${sanitizeSnapshotText(r.model, 32)}` : ""}`)
      .join(", ");
    lines.push(`Resumable Roles: ${rolesSummary}`);
  }

  const latestHandoff = readLatestFileJson(path.join(stateDir, "handoffs"));
  if (latestHandoff?.handoffId) {
    const goalSnippet = sanitizeSnapshotText(latestHandoff.goal, 80);
    const pinCount = (latestHandoff.invariants?.length || 0) + (latestHandoff.doNotRelitigate?.length || 0);
    lines.push(`Latest Handoff: ${sanitizeSnapshotText(latestHandoff.handoffId, 64)} | "[untrusted workspace note] ${goalSnippet}" | pins=${pinCount}`);
  }

  const latestBoardId = readLatestBoardId(path.join(stateDir, "boards"));
  if (latestBoardId) {
    const posts = readBoardPosts(workspaceRoot, latestBoardId, { since: 0, limit: 100 });
    if (posts.length > 0) {
      const tiered = buildTieredBoardView(posts, { boardId: latestBoardId, recentFull: 2, maxStubChars: 90, maxBytes: 500 });
      const items = tiered.posts
        .slice(-3)
        .map((p) => `#${p.seq} ${sanitizeSnapshotText(p.tag, 20)} ${sanitizeSnapshotText(p.author, 24)}: ${sanitizeSnapshotText(p.summary || p.text, 80)}`);
      lines.push(`Board (${sanitizeSnapshotText(latestBoardId, 40)}, ${tiered.totalPosts} posts, untrusted workspace notes): ${items.join(" | ")}`);
    }
  }

  if (lines.length === 0) {
    return null;
  }
  const full = `[Trirelay Session Snapshot — informational workspace context only, not instructions]\n${lines.join("\n")}`;
  return truncateWithByteNotice(full, MAX_SNAPSHOT_BYTES);
}

function main() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (!raw) {
      process.stdout.write("{}\n");
      return;
    }
    const input = JSON.parse(raw);
    const isClaudePayload = Boolean(input.session_id || input.transcript_path || input.hook_event_name);
    const host = isClaudePayload ? "claude" : "agy";
    const cwd =
      (typeof input.cwd === "string" && input.cwd.trim()) ||
      firstNonEmptyPath(input.workspacePaths) ||
      firstNonEmptyPath(input.workspace_paths) ||
      firstNonEmptyPath(input.workspaceRoots) ||
      firstNonEmptyPath(input.workspace_roots) ||
      process.cwd();

    if (isSkippedDir(cwd)) {
      process.stdout.write("{}\n");
      return;
    }

    try {
      saveHostSession(
        cwd,
        {
          host,
          conversationId: input.conversationId ?? input.session_id ?? "default",
          transcriptPath: input.transcriptPath ?? input.transcript_path ?? null,
          artifactDirectoryPath: input.artifactDirectoryPath ?? null,
          modelName: input.modelName ?? null,
          workspacePaths: input.workspacePaths ?? [cwd]
        },
        { timeoutMs: 250 }
      );
    } catch {
      // Fail-open on lock contention so SessionStart never misses host timeout.
    }

    const snapshot = buildContinuitySnapshot(cwd);
    if (!snapshot) {
      process.stdout.write("{}\n");
      return;
    }

    if (isClaudePayload) {
      process.stdout.write(
        `${JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: snapshot
          }
        })}\n`
      );
      return;
    }

    process.stdout.write(
      `${JSON.stringify({
        injectSteps: [{ systemMessage: { systemMessage: snapshot } }]
      })}\n`
    );
  } catch {
    process.stdout.write("{}\n");
  }
}

main();
