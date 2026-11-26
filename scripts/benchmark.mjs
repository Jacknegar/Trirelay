#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const args = new Set(process.argv.slice(2));
const IS_LIVE = args.has("--live");
const JSON_ONLY = args.has("--json");

const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), "trirelay-bench-"));
const STATE_DIR = path.join(TMP_BASE, "state");
const REPO_DIR = path.join(TMP_BASE, "repo");
fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(REPO_DIR, { recursive: true });

// Isolate state completely from user repos.
process.env.TRIRELAY_STATE_DIR = STATE_DIR;
process.env.TRIRELAY_HOST = "cli";

const { runSync } = await import("../core/env.mjs");
const { buildTieredBoardView, serializeMcpPayload } = await import("../core/compact.mjs");
const { buildWorkerResultToHandoff, createHandoffPacket, renderHandoffMarkdown } = await import("../core/handoff.mjs");
const { runDualReview, runSingleTask } = await import("../core/orchestrator.mjs");
const { postBoardMessage, readActiveBoardPins, readBoardPosts } = await import("../core/state.mjs");
const { applyWorktreePatch } = await import("../core/worktree.mjs");

function median(nums) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

function setupTempRepo() {
  const git = (gitArgs) => {
    const r = runSync("git", gitArgs, { cwd: REPO_DIR });
    if (r.status !== 0) {
      throw new Error(`git ${gitArgs.join(" ")} failed: ${r.stderr}`);
    }
  };
  git(["init"]);
  git(["config", "user.email", "bench@example.com"]);
  git(["config", "user.name", "Trirelay Bench"]);
  fs.mkdirSync(path.join(REPO_DIR, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(REPO_DIR, "src", "billing.js"),
    [
      "export function computeTotal(subtotalCents, discountCents) {",
      "  return subtotalCents - discountCents;",
      "}",
      ""
    ].join("\n")
  );
  git(["add", "."]);
  git(["commit", "-m", "initial"]);

  // Introduce an uncommitted bug in working tree for review benchmark: negative subtotal bypasses clamp.
  fs.writeFileSync(
    path.join(REPO_DIR, "src", "billing.js"),
    [
      "export function computeTotal(subtotalCents, discountCents, taxRate = 0.1) {",
      "  // BUG: allows negative discount to inflate balance and allows negative total without validation.",
      "  const afterDiscount = subtotalCents - discountCents;",
      "  return afterDiscount + afterDiscount * taxRate;",
      "}",
      ""
    ].join("\n")
  );
}

function runMemoryAndHookBenchmark() {
  const boardId = "bench-relay";
  const invariants = [
    "INV_PORT=8443",
    "INV_AUTH=PKCE",
    "INV_DB=SQLITE_WAL",
    "INV_RETRY=3",
    "INV_SPILL=8500"
  ];

  // Seed 12 realistic cross-engine board messages (3 pinned + 9 verbose updates/done)
  postBoardMessage(REPO_DIR, boardId, {
    author: "agy:architect",
    tag: "[decision]",
    text: `Architecture invariants locked: ${invariants.slice(0, 3).join(", ")}. Never revert.`
  });
  for (let i = 1; i <= 5; i += 1) {
    postBoardMessage(REPO_DIR, boardId, {
      author: i % 2 === 0 ? "codex:worker" : "claude:worker",
      tag: "[update]",
      text: `Step ${i} intermediate file trace: scanned 24 files, checked exports, timing=42ms. `.repeat(6)
    });
  }
  postBoardMessage(REPO_DIR, boardId, {
    author: "codex:implementer",
    tag: "[pin]",
    text: `Runtime limits pinned: ${invariants.slice(3).join(", ")}.`
  });
  for (let i = 6; i <= 9; i += 1) {
    postBoardMessage(REPO_DIR, boardId, {
      author: "claude:worker",
      tag: "[done]",
      text: `Completed subtask ${i} verification log output cleanly with exit=0. `.repeat(5)
    });
  }
  postBoardMessage(REPO_DIR, boardId, {
    author: "codex:reviewer",
    tag: "[blocker]",
    text: "Fix negative discount clamping in src/billing.js before release."
  });

  const activePins = readActiveBoardPins(REPO_DIR, boardId);
  const allPosts = readBoardPosts(REPO_DIR, boardId, { since: 0, limit: 200 });
  const naiveBoardBytes = Buffer.byteLength(JSON.stringify({ boardId, posts: allPosts }, null, 2), "utf8");
  const tiered = buildTieredBoardView(allPosts, { pinnedPosts: activePins, boardId, recentFull: 3, maxStubChars: 120, maxBytes: 2400 });
  const tieredBoardBytes = Buffer.byteLength(JSON.stringify(tiered, null, 2), "utf8");
  const boardSavingsPct = Number((((naiveBoardBytes - tieredBoardBytes) / naiveBoardBytes) * 100).toFixed(1));

  // Verify every pinned invariant survived compaction
  const tieredText = JSON.stringify(tiered);
  const pinnedInvariantsIntact = invariants.filter((inv) => tieredText.includes(inv)).length;

  // Verify BYTE-0 Prefix-Cache invariance across two turns of renderHandoffMarkdown
  const { packet: p1 } = createHandoffPacket(REPO_DIR, {
    workflowId: boardId,
    boardId,
    includeBoardDigest: true,
    goal: "Implement discount clamp",
    ownedFiles: ["src/billing.js"],
    invariants,
    doNotRelitigate: ["Use integer cents arithmetic"],
    contextDigest: "Turn 1 context blob ".repeat(20)
  });
  const { packet: p2 } = createHandoffPacket(REPO_DIR, {
    workflowId: boardId,
    boardId,
    includeBoardDigest: true,
    goal: "Implement discount clamp",
    ownedFiles: ["src/billing.js"],
    invariants,
    doNotRelitigate: ["Use integer cents arithmetic"],
    contextDigest: "Turn 2 updated dynamic traceback ".repeat(25)
  });
  const md1 = renderHandoffMarkdown(p1);
  const md2 = renderHandoffMarkdown(p2);
  // Measure strictly from byte 0 up to the `---` separator before dynamic HANDOFF_TURN metadata.
  const splitIdx1 = md1.indexOf("\n---\n");
  const splitIdx2 = md2.indexOf("\n---\n");
  const byte0Prefix1 = md1.slice(0, splitIdx1);
  const byte0Prefix2 = md2.slice(0, splitIdx2);
  const prefixCacheStableHeaderBytes = Buffer.byteLength(byte0Prefix1, "utf8");
  const prefixHeaderIdentical = splitIdx1 > 0 && byte0Prefix1 === byte0Prefix2;

  // Verify true chained handoff inheritance (Stage 1 -> Stage 2 adds & supersedes -> Stage 3) offline
  const chain1 = createHandoffPacket(REPO_DIR, {
    workflowId: "bench-chain",
    role: "s1",
    goal: "Stage 1",
    ownedFiles: ["src/billing.js"],
    invariants,
    decisionsMade: ["LEGACY_ALGO_V1"],
    doNotRelitigate: ["Preserve integer cents"]
  });
  const chain2 = buildWorkerResultToHandoff(
    REPO_DIR,
    { engine: "codex", role: "s1", handoffId: chain1.packet.handoffId, workflowId: "bench-chain", output: "done s1" },
    {
      role: "s2",
      toEngine: "claude",
      goal: "Stage 2",
      ownedFiles: ["src/tax.js"],
      decisionsMade: ["ADOPTED_ALGO_V2"],
      supersededDecisions: ["LEGACY_ALGO_V1"]
    }
  );
  const chain3 = buildWorkerResultToHandoff(
    REPO_DIR,
    { engine: "claude", role: "s2", handoffId: chain2.packet.handoffId, workflowId: "bench-chain", output: "done s2" },
    { role: "s3", toEngine: "agy", goal: "Stage 3" }
  );
  const chainedInheritanceIntact =
    invariants.every((inv) => chain3.packet.invariants.includes(inv)) &&
    chain3.packet.decisionsMade.includes("ADOPTED_ALGO_V2") &&
    !chain3.packet.decisionsMade.includes("LEGACY_ALGO_V1") &&
    chain3.packet.scope.ownedFiles.length === 0;

  // Verify <= 8.5 KB inline MCP compaction prevents Antigravity >8.8 KB disk spills
  const simulatedRawResult = {
    ok: true,
    jobId: "run-bench-001",
    patchPath: path.join(STATE_DIR, "patches", "sample.patch"),
    changedFiles: ["src/billing.js"],
    scopeViolations: [],
    output: "VERBOSE_TRACE_LOG_ENTRY_001 ".repeat(1000)
  };
  const naiveMcpBytes = Buffer.byteLength(JSON.stringify(simulatedRawResult, null, 2), "utf8");
  const compactedMcp = serializeMcpPayload("relay_jobs", simulatedRawResult, { maxBytes: 8500 });
  const mcpBytesSavedPct = Number((((naiveMcpBytes - compactedMcp.bytes) / naiveMcpBytes) * 100).toFixed(1));

  // Measure SessionStart hook latency & snapshot size
  const hookScript = path.join(PACKAGE_ROOT, "scripts", "session-hook.mjs");
  const hookLatencies = [];
  let snapshotBytes = 0;
  for (let i = 0; i < 3; i += 1) {
    const t0 = performance.now();
    const res = runSync(process.execPath, [hookScript], {
      input: JSON.stringify({ cwd: REPO_DIR, conversationId: `bench-${i}`, workspacePaths: [REPO_DIR] }),
      timeoutMs: 3000
    });
    hookLatencies.push(Math.round(performance.now() - t0));
    const parsed = JSON.parse(res.stdout || "{}");
    const msg = parsed.injectSteps?.[0]?.systemMessage?.systemMessage || "";
    snapshotBytes = Buffer.byteLength(msg, "utf8");
  }

  return {
    invariants,
    board: {
      totalPosts: allPosts.length,
      naiveBytes: naiveBoardBytes,
      tieredBytes: tieredBoardBytes,
      reductionPct: boardSavingsPct,
      pinnedInvariantsIntact,
      pinnedTotal: invariants.length
    },
    prefixCache: {
      byte0StableHeaderBytes: prefixCacheStableHeaderBytes,
      identicalFromByte0AcrossTurns: prefixHeaderIdentical,
      chainedInheritanceIntact
    },
    mcpInlineCap: {
      naiveBytes: naiveMcpBytes,
      compactedBytes: compactedMcp.bytes,
      reductionPct: mcpBytesSavedPct,
      exceeds8800Naive: naiveMcpBytes > 8800,
      exceeds8800Compacted: compactedMcp.bytes > 8800
    },
    sessionStartHook: {
      runsMs: hookLatencies,
      medianMs: median(hookLatencies),
      snapshotBytes
    },
    boardId
  };
}

async function runLiveBenchmarks(memoryInfo) {
  const { boardId, invariants } = memoryInfo;
  const codexModel = process.env.TRIRELAY_BENCH_CODEX_MODEL || "gpt-6-luna";
  const claudeModel = process.env.TRIRELAY_BENCH_CLAUDE_MODEL || "sonnet";
  const agyModel = process.env.TRIRELAY_BENCH_AGY_MODEL || "gemini-3.8-flash-low";

  // 1. Cold-Start Speed: Codex KEEP_MCP=1 (naive) vs Trirelay MCP isolation
  console.error("[live 1/4] Benchmarking Codex cold-start (KEEP_MCP=1 vs isolated)...");
  const naiveRunsMs = [];
  const isolatedRunsMs = [];
  for (let i = 0; i < 2; i += 1) {
    process.env.TRIRELAY_CODEX_KEEP_MCP = "1";
    const rNaive = await runSingleTask(REPO_DIR, {
      engine: "codex",
      model: codexModel,
      effort: "low",
      mode: "readonly",
      prompt: `Reply ONLY with PING_${i}.`
    });
    delete process.env.TRIRELAY_CODEX_KEEP_MCP;
    if (rNaive.ok) naiveRunsMs.push(rNaive.durationMs);

    const rIso = await runSingleTask(REPO_DIR, {
      engine: "codex",
      model: codexModel,
      effort: "low",
      mode: "readonly",
      prompt: `Reply ONLY with PONG_${i}.`
    });
    if (rIso.ok) isolatedRunsMs.push(rIso.durationMs);
  }
  const naiveMed = median(naiveRunsMs);
  const isoMed = median(isolatedRunsMs);
  console.error(`[live 1/4] Done: naive=${naiveMed}ms, isolated=${isoMed}ms`);
  const coldStart = {
    model: `${codexModel}@low`,
    naiveRunsMs,
    isolatedRunsMs,
    naiveMedianMs: naiveMed,
    isolatedMedianMs: isoMed,
    speedupX: naiveMed && isoMed ? Number((naiveMed / isoMed).toFixed(2)) : null,
    reductionPct: naiveMed && isoMed ? Number((((naiveMed - isoMed) / naiveMed) * 100).toFixed(1)) : null
  };

  // 2. Parallel Dual Review vs Serial Sum Baseline
  console.error("[live 2/4] Benchmarking parallel dual-engine review (codex+claude)...");
  const tRev = Date.now();
  const revRes = await runDualReview(REPO_DIR, {
    host: "agy",
    engine: "both",
    codexModel,
    claudeModel,
    effort: "low",
    focus: "Check negative numbers and discount clamping in src/billing.js"
  });
  const parallelWallMs = Date.now() - tRev;
  const serialSumMs = revRes.reviews.reduce((sum, r) => sum + (r.durationMs || 0), 0);
  console.error(`[live 2/4] Done: parallel=${parallelWallMs}ms, serialSum=${serialSumMs}ms`);
  const dualReview = {
    ok: revRes.ok,
    verdict: revRes.verdict,
    parallelWallMs,
    serialSumMs,
    timeSavedPct: serialSumMs > 0 ? Number((((serialSumMs - parallelWallMs) / serialSumMs) * 100).toFixed(1)) : null,
    findingsCount: revRes.findings.length,
    perEngine: revRes.reviews.map((r) => ({ engine: r.engine, model: r.model, ok: r.ok, durationMs: r.durationMs, verdict: r.structuredOutput?.verdict ?? null }))
  };

  // 3. 3-Hop Cross-Engine Memory Relay (codex -> claude -> agy) + Codex resumeRole Turn 2 Delta
  console.error("[live 3/4] Benchmarking 3-hop cross-engine memory relay (codex -> claude -> agy + resumeRole)...");
  const { packet: hopHandoff } = createHandoffPacket(REPO_DIR, {
    workflowId: "relay-bench",
    boardId,
    includeBoardDigest: true,
    goal: "Preserve all 5 system invariants across codex -> claude -> agy",
    invariants,
    doNotRelitigate: ["Never drop an INV_* value"]
  });

  const hop1 = await runSingleTask(REPO_DIR, {
    engine: "codex",
    model: codexModel,
    effort: "low",
    workflowId: "relay-bench",
    role: "hop-worker",
    boardId,
    handoffId: hopHandoff.handoffId,
    prompt: "Acknowledge the handoff and state ALL 5 INV_* key=value tokens verbatim on one line."
  });

  const hop2 = await runSingleTask(REPO_DIR, {
    engine: "claude",
    model: claudeModel,
    effort: "low",
    workflowId: "relay-bench",
    role: "hop-claude",
    boardId,
    handoffId: hopHandoff.handoffId,
    prompt: "Using the board and handoff, list ALL 5 INV_* key=value tokens verbatim plus the blocker file name."
  });

  const hop3 = await runSingleTask(REPO_DIR, {
    engine: "agy",
    model: agyModel,
    effort: "low",
    workflowId: "relay-bench",
    role: "hop-agy",
    boardId,
    handoffId: hopHandoff.handoffId,
    prompt: "Without modifying files, list ALL 5 INV_* key=value tokens verbatim from the handoff."
  });

  // Turn 2 delta via resumeRole=true on Codex (sends tiny feedback prompt instead of re-sending full handoff)
  const turn2Prompt = "Delta check: append OK_TURN_2 next to your 5 INV_* tokens.";
  const hop1Turn2 = await runSingleTask(REPO_DIR, {
    engine: "codex",
    model: codexModel,
    effort: "low",
    workflowId: "relay-bench",
    role: "hop-worker",
    resumeRole: true,
    prompt: turn2Prompt
  });

  const countMatches = (text) => invariants.filter((inv) => String(text || "").includes(inv)).length;
  const crossRelay = {
    hop1Codex: { ok: hop1.ok, durationMs: hop1.durationMs, recalled: countMatches(hop1.output), total: invariants.length },
    hop2Claude: { ok: hop2.ok, durationMs: hop2.durationMs, recalled: countMatches(hop2.output), total: invariants.length },
    hop3Agy: { ok: hop3.ok, durationMs: hop3.durationMs, recalled: countMatches(hop3.output), total: invariants.length },
    codexResumeTurn2: {
      ok: hop1Turn2.ok,
      durationMs: hop1Turn2.durationMs,
      recalled: countMatches(hop1Turn2.output),
      total: invariants.length,
      sameSessionId: Boolean(hop1.sessionId && hop1.sessionId === hop1Turn2.sessionId),
      deltaPromptBytes: Buffer.byteLength(turn2Prompt, "utf8"),
      usage: hop1Turn2.usage
    }
  };

  // 4. Isolated Worktree Write + Check + Clean Main Tree Proof
  console.error("[live 4/4] Benchmarking isolated git worktree write + patch check...");
  // Reset working tree to HEAD (after dual-review benchmark) so apply --check verifies cleanly against baseSha.
  runSync("git", ["checkout", "--", "src/billing.js"], { cwd: REPO_DIR });
  const wtTask = await runSingleTask(REPO_DIR, {
    engine: "claude",
    model: claudeModel,
    effort: "low",
    mode: "write",
    workflowId: "wt-bench",
    role: "patcher",
    ownedFiles: ["src/billing.js"],
    prompt: "Clamp discountCents between 0 and subtotalCents in src/billing.js and return non-negative total."
  });
  const dirtyBeforeApply = runSync("git", ["status", "--porcelain=v1"], { cwd: REPO_DIR }).stdout.trim();
  let applyCheckOk = false;
  if (wtTask.ok && wtTask.patchPath) {
    applyCheckOk = applyWorktreePatch(REPO_DIR, wtTask.patchPath, { mode: "check" }).ok;
  }

  return {
    coldStart,
    dualReview,
    crossRelay,
    worktreeWrite: {
      ok: wtTask.ok,
      durationMs: wtTask.durationMs,
      changedFiles: wtTask.changedFiles,
      scopeViolations: wtTask.scopeViolations,
      patchCaptured: Boolean(wtTask.patchPath),
      mainTreeUntouchedBeforeApply: dirtyBeforeApply === "",
      applyCheckOk
    }
  };
}

async function main() {
  try {
    setupTempRepo();
    const memory = runMemoryAndHookBenchmark();
    const live = IS_LIVE ? await runLiveBenchmarks(memory) : null;
    const report = {
      timestamp: new Date().toISOString(),
      mode: IS_LIVE ? "live" : "offline",
      nodeVersion: process.version,
      platform: `${process.platform}/${process.arch}`,
      memory,
      live
    };

    if (JSON_ONLY) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log("=== Trirelay Benchmark Report ===");
    console.log(`Mode: ${report.mode} | Platform: ${report.platform} | Node: ${report.nodeVersion}`);
    console.log(
      `[Memory] Tiered Board (${memory.board.totalPosts} posts): ${memory.board.naiveBytes}B -> ${memory.board.tieredBytes}B (-${memory.board.reductionPct}%), pinned invariants intact=${memory.board.pinnedInvariantsIntact}/${memory.board.pinnedTotal}`
    );
    console.log(
      `[Memory] Byte-0 Static Prefix: ${memory.prefixCache.byte0StableHeaderBytes}B, identicalFromByte0=${memory.prefixCache.identicalFromByte0AcrossTurns}, chainedInheritanceIntact=${memory.prefixCache.chainedInheritanceIntact}`
    );
    console.log(
      `[Spills] MCP Inline Cap: ${memory.mcpInlineCap.naiveBytes}B -> ${memory.mcpInlineCap.compactedBytes}B (-${memory.mcpInlineCap.reductionPct}%), >8.8KB spills=${memory.mcpInlineCap.exceeds8800Compacted ? 1 : 0}`
    );
    console.log(
      `[Hook]   SessionStart Snapshot: median ${memory.sessionStartHook.medianMs}ms (${memory.sessionStartHook.snapshotBytes}B)`
    );
    if (live) {
      console.log(
        `[Speed]  Codex Cold-Start (${live.coldStart.model}): ${live.coldStart.naiveMedianMs}ms -> ${live.coldStart.isolatedMedianMs}ms (${live.coldStart.speedupX}x, -${live.coldStart.reductionPct}%)`
      );
      console.log(
        `[FanOut] Dual Review (codex+claude): serial ${live.dualReview.serialSumMs}ms -> parallel ${live.dualReview.parallelWallMs}ms (-${live.dualReview.timeSavedPct}%), findings=${live.dualReview.findingsCount}`
      );
      console.log(
        `[Relay]  3-Hop Recall: codex=${live.crossRelay.hop1Codex.recalled}/5 (${live.crossRelay.hop1Codex.durationMs}ms), claude=${live.crossRelay.hop2Claude.recalled}/5 (${live.crossRelay.hop2Claude.durationMs}ms), agy=${live.crossRelay.hop3Agy.recalled}/5 (${live.crossRelay.hop3Agy.durationMs}ms)`
      );
      console.log(
        `[Delta]  Codex resumeRole Turn 2: recalled=${live.crossRelay.codexResumeTurn2.recalled}/5, sameSession=${live.crossRelay.codexResumeTurn2.sameSessionId}, prompt=${live.crossRelay.codexResumeTurn2.deltaPromptBytes}B, ${live.crossRelay.codexResumeTurn2.durationMs}ms`
      );
      console.log(
        `[Write]  Worktree Isolation + Patch Check: ok=${live.worktreeWrite.ok}, applyCheck=${live.worktreeWrite.applyCheckOk}, scopeViolations=${live.worktreeWrite.scopeViolations.length}, ${live.worktreeWrite.durationMs}ms`
      );
    }
    console.log("\nJSON_SUMMARY_START");
    console.log(JSON.stringify(report, null, 2));
    console.log("JSON_SUMMARY_END");
  } finally {
    fs.rmSync(TMP_BASE, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("BENCHMARK FAILED:", err);
  process.exitCode = 1;
});
