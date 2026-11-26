import fs from "node:fs";
import path from "node:path";

import { buildTieredBoardView } from "./compact.mjs";
import { resolveClaudeHome, resolveHost, resolvePathInsideWorkspace, resolveWorkspaceRoot } from "./env.mjs";
import {
  assertPathInside,
  ensureSubdir,
  generateId,
  loadHostSession,
  lookupRoleSession,
  nowIso,
  readActiveBoardPins,
  readBoardPosts,
  readJsonSafe,
  validateOpaqueId,
  writeJsonAtomic
} from "./state.mjs";
import { getGitBranch, getGitHeadSha } from "./worktree.mjs";

export function extractTranscriptDigest(transcriptPath, maxEvents = 10) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return "";
  }
  try {
    const raw = fs.readFileSync(transcriptPath, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const tail = lines.slice(-Math.max(maxEvents * 3, 20));
    const bullets = [];
    for (const line of tail) {
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }
      const type = item?.type || "";
      const text =
        typeof item?.content === "string"
          ? item.content.replace(/\s+/g, " ").trim()
          : typeof item?.message?.content === "string"
            ? item.message.content.replace(/\s+/g, " ").trim()
            : "";
      if ((type === "USER_INPUT" || type === "user") && text) {
        bullets.push(`- [User] ${text.slice(0, 220)}`);
      } else if ((type === "PLANNER_RESPONSE" || type === "assistant") && text) {
        bullets.push(`- [Host] ${text.slice(0, 220)}`);
      }
    }
    const capped = bullets.slice(-maxEvents).join("\n");
    return capped.length > 2000 ? `${capped.slice(0, 1997)}...` : capped;
  } catch {
    return "";
  }
}

export function extractRepoHandoffHead(workspaceRoot, maxLines = 40) {
  const handoffPath = resolvePathInsideWorkspace(workspaceRoot, path.join("docs", "handoff.md"), "docs/handoff.md");
  if (!fs.existsSync(handoffPath)) {
    return "";
  }
  try {
    const lines = fs.readFileSync(handoffPath, "utf8").split(/\r?\n/);
    return lines.slice(0, maxLines).join("\n").trim();
  } catch {
    return "";
  }
}

export function formatTieredBoardDigest(workspaceRoot, boardId = "default", { maxBytes = 1800 } = {}) {
  const activePins = readActiveBoardPins(workspaceRoot, boardId);
  const posts = readBoardPosts(workspaceRoot, boardId, { since: 0, limit: 100 });
  if (!posts.length && !activePins.length) return "";
  const tiered = buildTieredBoardView(posts, {
    pinnedPosts: activePins,
    boardId,
    recentFull: 3,
    maxStubChars: 120,
    maxBytes
  });
  const lines = [
    `Board "${boardId}" (${tiered.totalPosts} total: ${tiered.pinnedShown}/${tiered.pinnedTotal} active pins, ${tiered.stubCount} stub, ${tiered.recentCount} recent; recall: ${tiered.recallHint})`
  ];
  if (tiered.omittedPinnedCount > 0 || tiered.truncatedPinnedSeqs.length > 0) {
    lines.push(
      `[WARNING] ${tiered.omittedPinnedCount} active pin(s) omitted (${tiered.omittedPinnedSeqs.join(",") || "none"}) and ${tiered.truncatedPinnedSeqs.length} truncated (${tiered.truncatedPinnedSeqs.join(",") || "none"}) due to ${maxBytes}B budget — recall full pins via: ${tiered.recallHint}`
    );
  }
  for (const item of tiered.posts) {
    if (item.stub) {
      lines.push(`- #${item.seq} ${item.tag} [${item.author}] ${item.summary}${item.patchPath ? ` (patch: ${item.patchPath})` : ""}`);
    } else {
      lines.push(`- #${item.seq} ${item.pinned ? "[PIN] " : ""}${item.tag} [${item.author}]: ${String(item.text || "").replace(/\s+/g, " ").trim()}${item.patchPath ? ` (patch: ${item.patchPath})` : ""}`);
    }
  }
  return lines.join("\n");
}

function dedupeStrings(list = []) {
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const val = String(raw ?? "").trim();
    if (!val || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
  }
  return out;
}

function dedupeVerification(list = []) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const key = `${item.cmd ?? ""}::${item.exit ?? ""}::${item.excerpt ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function collectParentChain(workspaceRoot, parentHandoffId, maxDepth = 20) {
  const chain = [];
  const visited = new Set();
  let cursor = parentHandoffId;
  while (cursor && !visited.has(cursor) && chain.length < maxDepth) {
    visited.add(cursor);
    const parent = loadHandoffPacket(workspaceRoot, cursor);
    if (!parent) break;
    chain.unshift(parent); // oldest ancestor first
    cursor = parent.parentHandoffId ?? null;
  }
  return chain;
}

/**
 * Inherit workflow-persistent constraints (invariants, decisionsMade, doNotRelitigate,
 * acceptanceCriteria, verification, forbiddenFiles) across a handoff parent chain while
 * NEVER copying stage-local scope (`ownedFiles`, `role`, `toEngine`, `goal`).
 */
export function resolveInheritedConstraints(workspaceRoot, parentHandoffId, input = {}) {
  const chain = parentHandoffId && input.inheritParent !== false
    ? collectParentChain(workspaceRoot, parentHandoffId)
    : [];

  const supAll = new Set(
    dedupeStrings([
      ...chain.flatMap((p) => p.supersededDecisions ?? []),
      ...(input.supersededDecisions ?? [])
    ])
  );
  const depInvAll = new Set(
    dedupeStrings([
      ...chain.flatMap((p) => p.deprecatedInvariants ?? []),
      ...(input.deprecatedInvariants ?? [])
    ])
  );

  const rawInvariants = dedupeStrings([
    ...chain.flatMap((p) => p.invariants ?? []),
    ...(input.invariants ?? [])
  ]);
  const rawDecisions = dedupeStrings([
    ...chain.flatMap((p) => p.decisionsMade ?? []),
    ...(input.decisionsMade ?? [])
  ]);
  const rawDoNotRelitigate = dedupeStrings([
    ...chain.flatMap((p) => p.doNotRelitigate ?? []),
    ...(input.doNotRelitigate ?? [])
  ]);

  const invariants = rawInvariants.filter((v) => !depInvAll.has(v));
  const decisionsMade = rawDecisions.filter((v) => !supAll.has(v));
  const doNotRelitigate = rawDoNotRelitigate.filter((v) => !supAll.has(v));
  const acceptanceCriteria = dedupeStrings([
    ...chain.flatMap((p) => p.acceptanceCriteria ?? []),
    ...(input.acceptanceCriteria ?? [])
  ]);
  const verification = dedupeVerification([
    ...chain.flatMap((p) => p.verification ?? []),
    ...(input.verification ?? [])
  ]);
  const forbiddenFiles = dedupeStrings([
    "docs/handoff.md",
    ...chain.flatMap((p) => p.scope?.forbiddenFiles ?? []),
    ...(Array.isArray(input.forbiddenFiles) ? input.forbiddenFiles : [])
  ]);

  const maxParentVersion = chain.reduce((m, p) => Math.max(m, Number(p.decisionVersion || 1)), 0);
  const hasNewDecisionsOrSupersedes =
    Boolean(input.decisionsMade?.length) ||
    Boolean(input.invariants?.length) ||
    Boolean(input.doNotRelitigate?.length) ||
    Boolean(input.supersededDecisions?.length) ||
    Boolean(input.deprecatedInvariants?.length);
  const decisionVersion = chain.length > 0
    ? maxParentVersion + (hasNewDecisionsOrSupersedes ? 1 : 0)
    : 1;

  return {
    invariants,
    decisionsMade,
    doNotRelitigate,
    supersededDecisions: [...supAll],
    deprecatedInvariants: [...depInvAll],
    decisionVersion,
    acceptanceCriteria,
    verification,
    forbiddenFiles
  };
}

export function createHandoffPacket(cwd, input = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const handoffId = input.handoffId ? validateOpaqueId(input.handoffId, "handoffId") : generateId("hof");
  const dir = ensureSubdir(workspaceRoot, "handoffs");
  const jsonPath = assertPathInside(dir, path.join(dir, `${handoffId}.json`), "handoffJsonPath");
  const mdPath = assertPathInside(dir, path.join(dir, `${handoffId}.md`), "handoffMdPath");

  if (fs.existsSync(jsonPath)) {
    throw new Error(`Handoff packet "${handoffId}" already exists (refusing to overwrite).`);
  }

  const host = resolveHost(input.fromHost);
  const hostSession = loadHostSession(workspaceRoot, {
    host: host === "cli" ? null : host,
    conversationId: input.agyConversationId ?? null
  });

  const inherited = resolveInheritedConstraints(workspaceRoot, input.parentHandoffId ?? null, input);

  let contextDigest = String(input.contextDigest ?? "").trim();
  const digestParts = [];
  if (contextDigest) {
    digestParts.push(contextDigest);
  }
  if (input.includeHostDigest || input.includeAgyDigest) {
    const tPath = input.transcriptPath || hostSession?.transcriptPath;
    const digest = extractTranscriptDigest(tPath);
    if (digest) {
      digestParts.push(`### Host Recent Transcript (${hostSession?.host || host})\n${digest}`);
    }
  }
  if (input.includeRepoHandoff) {
    const head = extractRepoHandoffHead(workspaceRoot);
    if (head) {
      digestParts.push(`### Workspace docs/handoff.md (read-only head)\n${head}`);
    }
  }
  contextDigest = digestParts.join("\n\n").trim();

  const boardDigest =
    typeof input.boardDigest === "string" && input.boardDigest.trim()
      ? input.boardDigest.trim()
      : input.includeBoardDigest
        ? formatTieredBoardDigest(workspaceRoot, input.boardId || input.workflowId || "default")
        : "";

  const packet = {
    handoffId,
    parentHandoffId: input.parentHandoffId ?? null,
    decisionVersion: inherited.decisionVersion,
    workflowId: input.workflowId ?? "default",
    createdAt: nowIso(),
    fromHost: host,
    fromEngine: input.fromEngine ?? host,
    toEngine: input.toEngine ?? "codex",
    role: input.role ?? "worker",
    goal: String(input.goal ?? "").trim(),
    scope: {
      // Stage-local file ownership is NEVER copied from parent handoffs.
      ownedFiles: Array.isArray(input.ownedFiles) ? [...input.ownedFiles] : [],
      forbiddenFiles: inherited.forbiddenFiles,
      worktreePath: input.worktreePath ?? null,
      branch: input.branch ?? getGitBranch(workspaceRoot),
      headSha: input.headSha ?? getGitHeadSha(workspaceRoot)
    },
    invariants: inherited.invariants,
    decisionsMade: inherited.decisionsMade,
    doNotRelitigate: inherited.doNotRelitigate,
    supersededDecisions: inherited.supersededDecisions,
    deprecatedInvariants: inherited.deprecatedInvariants,
    openQuestions: Array.isArray(input.openQuestions) ? input.openQuestions : [],
    verification: inherited.verification,
    boardDigest,
    contextDigest,
    evidence: Array.isArray(input.evidence) ? input.evidence : [],
    acceptanceCriteria: inherited.acceptanceCriteria,
    returnContract:
      input.returnContract ??
      "Return concise summary, files touched, exact verification commands/outputs, and blockers or open risks.",
    sessionLinks: {
      agyConversationId:
        input.agyConversationId ?? (hostSession?.host === "agy" ? hostSession.conversationId : null) ?? null,
      claudeSessionId:
        input.claudeSessionId ??
        lookupRoleSession(workspaceRoot, {
          workflowId: input.workflowId ?? "default",
          role: input.role ?? "worker",
          engine: "claude"
        })?.sessionId ??
        null,
      codexThreadId:
        input.codexThreadId ??
        lookupRoleSession(workspaceRoot, {
          workflowId: input.workflowId ?? "default",
          role: input.role ?? "worker",
          engine: "codex"
        })?.sessionId ??
        null
    }
  };

  writeJsonAtomic(jsonPath, packet);
  fs.writeFileSync(mdPath, `${renderHandoffMarkdown(packet)}\n`, { encoding: "utf8", mode: 0o600 });

  return { packet, jsonPath, mdPath };
}

export function loadHandoffPacket(cwd, handoffId) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const safeId = validateOpaqueId(handoffId, "handoffId");
  const dir = ensureSubdir(workspaceRoot, "handoffs");
  const target = assertPathInside(dir, path.join(dir, `${safeId}.json`), "handoffJsonPath");
  return readJsonSafe(target, null);
}

/**
 * Render Handoff Packet starting at BYTE 0 with turn-invariant policy, scope, and
 * pinned workflow constraints so LLM prompt prefix caches match from the very first token.
 * Dynamic per-turn handoff IDs, timestamps, goals, board digests, and evidence appear after `---`.
 */
export function renderHandoffMarkdown(packet) {
  const lines = [
    `<HANDOFF_CONTRACT workflow="${packet.workflowId}">`,
    `Return Contract: ${packet.returnContract}`
  ];

  if (packet.scope?.ownedFiles?.length) {
    lines.push(`Owned Files (you may edit): ${packet.scope.ownedFiles.join(", ")}`);
  }
  if (packet.scope?.forbiddenFiles?.length) {
    lines.push(`Forbidden Files (DO NOT edit): ${packet.scope.forbiddenFiles.join(", ")}`);
  }
  if (packet.invariants?.length) {
    lines.push("Invariants (Pinned):");
    for (const inv of packet.invariants) lines.push(`- ${inv}`);
  }
  if (packet.decisionsMade?.length) {
    lines.push("Decisions Made (Pinned):");
    for (const dec of packet.decisionsMade) lines.push(`- ${dec}`);
  }
  if (packet.doNotRelitigate?.length) {
    lines.push("Do Not Re-Litigate (Pinned):");
    for (const dnr of packet.doNotRelitigate) lines.push(`- ${dnr}`);
  }

  lines.push("---");
  lines.push(
    `<HANDOFF_TURN id="${packet.handoffId}" parent="${packet.parentHandoffId ?? "none"}" version="${packet.decisionVersion ?? 1}" fromHost="${packet.fromHost || packet.fromEngine}" from="${packet.fromEngine}" to="${packet.toEngine}" role="${packet.role}">`
  );
  if (packet.scope?.worktreePath) {
    lines.push(`Working Directory (Isolated Worktree): ${packet.scope.worktreePath}`);
  }
  if (packet.scope?.branch || packet.scope?.headSha) {
    lines.push(`Git Base: ${packet.scope.branch ?? "detached"} @ ${packet.scope.headSha ?? "unknown"}`);
  }
  lines.push(`Goal: ${packet.goal}`);
  if (packet.acceptanceCriteria?.length) {
    lines.push("Acceptance Criteria:");
    for (const ac of packet.acceptanceCriteria) lines.push(`- ${ac}`);
  }
  if (packet.supersededDecisions?.length) {
    lines.push("Superseded Decisions (Do NOT use):");
    for (const sup of packet.supersededDecisions) lines.push(`- ${sup}`);
  }
  if (packet.boardDigest) {
    lines.push("Board Continuity (Tiered):");
    lines.push(packet.boardDigest);
  }
  if (packet.verification?.length) {
    lines.push("Prior Verification:");
    for (const v of packet.verification) {
      lines.push(`- \`${v.cmd}\` (exit=${v.exit ?? "?"}): ${v.excerpt ?? ""}`);
    }
  }
  if (packet.contextDigest) {
    lines.push("Context Digest:");
    lines.push(packet.contextDigest);
  }
  if (packet.evidence?.length) {
    lines.push("Prior Evidence / Receipts:");
    for (const ev of packet.evidence) lines.push(`- ${ev}`);
  }
  if (packet.openQuestions?.length) {
    lines.push("Open Questions:");
    for (const q of packet.openQuestions) lines.push(`- ${q}`);
  }
  lines.push("</HANDOFF_TURN>");
  return lines.join("\n");
}

export function buildWorkerResultToHandoff(cwd, workerResult, nextSpec = {}) {
  const evidence = [];
  if (workerResult.output) {
    evidence.push(`Summary from ${workerResult.engine}:${workerResult.model ?? "default"}: ${workerResult.output.slice(0, 600)}`);
  }
  if (workerResult.changedFiles?.length) {
    evidence.push(`Changed files: ${workerResult.changedFiles.join(", ")}`);
  }
  if (workerResult.patchPath) {
    evidence.push(`Patch file: ${workerResult.patchPath}`);
  }
  if (workerResult.ignoredOnlyDeliverables && workerResult.ignoredFiles?.length) {
    evidence.push(`Ignored deliverables in worktree: ${workerResult.ignoredFiles.join(", ")}`);
  }
  return createHandoffPacket(cwd, {
    parentHandoffId: nextSpec.parentHandoffId ?? workerResult.handoffId ?? null,
    inheritParent: nextSpec.inheritParent !== false,
    workflowId: nextSpec.workflowId ?? workerResult.workflowId ?? "default",
    boardId: nextSpec.boardId ?? workerResult.boardId ?? null,
    includeBoardDigest: Boolean(nextSpec.includeBoardDigest),
    fromHost: resolveHost(),
    fromEngine: workerResult.engine,
    toEngine: nextSpec.toEngine ?? "agy",
    role: nextSpec.role ?? "verifier",
    goal: nextSpec.goal ?? `Verify work from ${workerResult.role ?? workerResult.engine}`,
    ownedFiles: nextSpec.ownedFiles ?? [],
    forbiddenFiles: nextSpec.forbiddenFiles ?? ["docs/handoff.md"],
    invariants: nextSpec.invariants ?? [],
    decisionsMade: nextSpec.decisionsMade ?? [],
    doNotRelitigate: nextSpec.doNotRelitigate ?? [],
    supersededDecisions: nextSpec.supersededDecisions ?? [],
    deprecatedInvariants: nextSpec.deprecatedInvariants ?? [],
    evidence,
    acceptanceCriteria: nextSpec.acceptanceCriteria ?? [],
    claudeSessionId: workerResult.engine === "claude" ? workerResult.sessionId : null,
    codexThreadId: workerResult.engine === "codex" ? workerResult.sessionId : null
  });
}

/**
 * List Claude session JSONL files STRICTLY scoped to the given canonical workspace.
 * Never scans unrelated projects under ~/.claude/projects.
 */
export function listWorkspaceClaudeSessions(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const slug = workspaceRoot.replace(/[\\/]/g, "-");
  const projectsDir = path.join(resolveClaudeHome(), "projects");
  const candidateDir = path.join(projectsDir, slug);
  if (!fs.existsSync(candidateDir)) {
    return [];
  }
  return fs
    .readdirSync(candidateDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => {
      const full = path.join(candidateDir, e.name);
      const st = fs.statSync(full);
      return { path: full, sessionId: e.name.replace(/\.jsonl$/, ""), mtimeMs: st.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}
