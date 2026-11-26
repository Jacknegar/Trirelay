#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const FAKE_BIN_DIR = path.join(PACKAGE_ROOT, "test", "fake-bin");

const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), "trirelay-suite-"));
const STATE_DIR = path.join(TMP_BASE, "state");
const HOME_DIR = path.join(TMP_BASE, "home");
const REPO_DIR = path.join(TMP_BASE, "repo");
const NON_GIT_DIR = path.join(TMP_BASE, "non-git");
const RECORD_FILE = path.join(TMP_BASE, "cli-invocations.jsonl");

fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(HOME_DIR, ".codex"), { recursive: true });
fs.mkdirSync(path.join(HOME_DIR, ".claude"), { recursive: true });
fs.mkdirSync(REPO_DIR, { recursive: true });
fs.mkdirSync(NON_GIT_DIR, { recursive: true });

fs.writeFileSync(
  path.join(HOME_DIR, ".codex", "config.toml"),
  [
    'model = "gpt-6.2-astra"',
    '[mcp_servers.figma]',
    'url = "https://mcp.figma.com/mcp"',
    '[mcp_servers.figma.env]',
    'TOKEN = "abc"',
    '[mcp_servers."my server"]',
    'command = "echo"',
    '[mcp_servers.codegraph]',
    'command = "codegraph"',
    '[mcp_servers.trirelay]',
    'command = "sh"'
  ].join("\n") + "\n"
);
fs.writeFileSync(
  path.join(HOME_DIR, ".codex", "models_cache.json"),
  JSON.stringify({
    models: [
      {
        slug: "gpt-6.2-astra",
        display_name: "GPT-6.2-Astra",
        visibility: "list",
        default_reasoning_level: "high",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }, { effort: "max" }]
      }
    ]
  })
);
fs.writeFileSync(path.join(HOME_DIR, ".claude", "settings.json"), JSON.stringify({ model: "opus" }));

// Isolate environment BEFORE importing core modules
process.env.TRIRELAY_STATE_DIR = STATE_DIR;
process.env.TRIRELAY_HOST = "cli";
process.env.CODEX_HOME = path.join(HOME_DIR, ".codex");
process.env.CLAUDE_CONFIG_DIR = path.join(HOME_DIR, ".claude");
process.env.TRIRELAY_AGY_BIN = path.join(FAKE_BIN_DIR, "agy");
process.env.TRIRELAY_CLAUDE_BIN = path.join(FAKE_BIN_DIR, "claude");
process.env.TRIRELAY_CODEX_BIN = path.join(FAKE_BIN_DIR, "codex");
process.env.TRIRELAY_TEST_RECORD_FILE = RECORD_FILE;
process.env.CLAUDECODE = "1";
process.env.CLAUDE_CODE_SESSION_ID = "parent-secret-session";
process.env.PLUGIN_DATA = "/should/be/scrubbed";
delete process.env.TRIRELAY_DEPTH;
delete process.env.TRIRELAY_CODEX_KEEP_MCP;
delete process.env.TRIRELAY_CODEX_MCP_ALLOW;

const { runSync, buildWorkerEnv, resolveExecutable } = await import("../core/env.mjs");
const { buildAgyArgs } = await import("../core/drivers/agy.mjs");
const { buildClaudeArgs } = await import("../core/drivers/claude.mjs");
const {
  buildCodexExecArgs,
  listConfiguredCodexMcpServers,
  resolveDisabledCodexMcpServers
} = await import("../core/drivers/codex.mjs");
const {
  buildTieredBoardView,
  compactMcpPayload,
  serializeMcpPayload,
  sliceUtf8Bytes,
  truncateWithByteNotice
} = await import("../core/compact.mjs");
const {
  spawnJsonlProcess
} = await import("../core/drivers/common.mjs");
const {
  assertRecursionSafe,
  inspectReviewArtifact,
  runCopyReview,
  runDualDesign,
  runDualReview,
  runOrchestration,
  runReviewGate,
  runSingleTask,
  validateCallerArgs
} = await import("../core/orchestrator.mjs");
const { resolveRoute } = await import("../core/router.mjs");
const { buildWorkerResultToHandoff, createHandoffPacket, loadHandoffPacket, renderHandoffMarkdown } = await import("../core/handoff.mjs");
const {
  acquireSessionLease,
  assertPathInside,
  loadReviewGateState,
  lookupSessionById,
  postBoardMessage,
  readActiveBoardPins,
  readBoardPosts,
  readBoardPostsBySeqs,
  readJobDetail,
  recordRoleSession,
  releaseSessionLease,
  resolveBoardFile,
  resolveBoardPinsFile,
  saveReviewArtifact,
  sessionLedgerPath,
  writeJsonAtomic
} = await import("../core/state.mjs");
const {
  applyJobPatch,
  applyWorktreePatch,
  auditFileScope,
  captureWorktreeChanges,
  createIsolatedWorktree,
  extractPatchTouchedFiles,
  parsePorcelainZ,
  removeIsolatedWorktree
} = await import("../core/worktree.mjs");
const { planInstall } = await import("../core/installer.mjs");

function initTempGitRepo() {
  const git = (args) => {
    const r = runSync("git", args, { cwd: REPO_DIR });
    assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  };
  git(["init"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test User"]);
  fs.mkdirSync(path.join(REPO_DIR, "src"), { recursive: true });
  fs.writeFileSync(path.join(REPO_DIR, "src", "app.js"), "export const v = 1;\n");
  fs.writeFileSync(path.join(REPO_DIR, "src", "auth.js"), "export function login() { return true; }\n");
  git(["add", "."]);
  git(["commit", "-m", "initial"]);
}

function testJsonManifests() {
  const files = [
    "package.json",
    "tsconfig.json",
    "plugin.json",
    "mcp_config.json",
    "hooks.json",
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    ".mcp.json",
    "hooks/hooks.json",
    "config/routing.json",
    "schemas/handoff-packet.schema.json",
    "schemas/worker-result.schema.json",
    "schemas/review-output.schema.json",
    "schemas/copy-review.schema.json"
  ];
  for (const rel of files) {
    const full = path.join(PACKAGE_ROOT, rel);
    assert.ok(fs.existsSync(full), `Missing ${rel}`);
    JSON.parse(fs.readFileSync(full, "utf8"));
  }
  console.log("[PASS] Manifests & JSON schemas valid");
}

function testEnvScrubAndResolver() {
  const workerEnv = buildWorkerEnv(
    {
      ...process.env,
      ANTIGRAVITY_CSRF_TOKEN: "secret-csrf",
      ANTIGRAVITY_LS_ADDRESS: "localhost:9999"
    },
    { depth: 1, engine: "claude" }
  );
  assert.equal(workerEnv.CLAUDECODE, undefined);
  assert.equal(workerEnv.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(workerEnv.PLUGIN_DATA, undefined);
  assert.equal(workerEnv.ANTIGRAVITY_CSRF_TOKEN, undefined);
  assert.equal(workerEnv.ANTIGRAVITY_LS_ADDRESS, undefined);
  assert.equal(workerEnv.TRIRELAY_DEPTH, "1");

  // Symlinked parent directory inside assertPathInside
  const realDir = path.join(TMP_BASE, "real-parent");
  const symDir = path.join(TMP_BASE, "sym-parent");
  fs.mkdirSync(realDir, { recursive: true });
  fs.symlinkSync(realDir, symDir, "dir");
  const resolvedChild = assertPathInside(symDir, path.join(realDir, "child.json"), "symChild");
  assert.ok(resolvedChild.endsWith("child.json"));

  // Directory is never accepted as executable
  const dirOnly = resolveExecutable("fake-bin", { env: { PATH: path.join(PACKAGE_ROOT, "test") } });
  assert.equal(dirOnly, null);
  console.log("[PASS] Env scrubbing, symlink path containment, and executable file validation");
}

function testCompactAndTieredBoard() {
  // UTF-8 codepoint/surrogate safety with CJK + 4-byte emoji
  const cjk = "中文测试🚀你好世界🎉再见";
  for (const maxB of [5, 8, 12, 20]) {
    const sliced = sliceUtf8Bytes(cjk, maxB);
    assert.ok(Buffer.byteLength(sliced, "utf8") <= maxB);
    assert.ok(!sliced.includes("\uFFFD"), `Invalid UTF-8 replacement character at maxB=${maxB}`);
    const truncated = truncateWithByteNotice(cjk.repeat(10), Math.max(60, maxB * 6));
    assert.ok(Buffer.byteLength(truncated, "utf8") <= Math.max(60, maxB * 6));
    assert.ok(!truncated.includes("\uFFFD"));
  }

  // Tiered board memory: preserves pinned decisions/blockers, keeps recent full, stubs older
  const posts = [
    { seq: 1, author: "codex:arch", tag: "[decision]", text: "CRITICAL_PIN_OAUTH_ROTATION: Use PKCE + rotating refresh tokens." },
    { seq: 2, author: "claude:w1", tag: "[update]", text: "Scanned repository files ".repeat(10) },
    { seq: 3, author: "codex:w2", tag: "[update]", text: "Updated intermediate helper ".repeat(10) },
    { seq: 4, author: "agy:w3", tag: "[pin]", text: "PINNED_PORT_CONSTRAINT: Keep port 8080 immutable." },
    { seq: 5, author: "claude:w4", tag: "[done]", text: "Latest recent update 1" },
    { seq: 6, author: "codex:w5", tag: "[done]", text: "Latest recent update 2" },
    { seq: 7, author: "agy:coord", tag: "[done]", text: "Latest recent update 3" }
  ];
  const tiered = buildTieredBoardView(posts, { boardId: "b1", recentFull: 3, maxStubChars: 80, maxBytes: 1800 });
  assert.equal(tiered.view, "tiered");
  assert.equal(tiered.totalPosts, 7);
  assert.equal(tiered.pinnedCount, 2);
  assert.ok(tiered.stubCount >= 2);
  assert.ok(tiered.posts.some((p) => (p.text || "").includes("CRITICAL_PIN_OAUTH_ROTATION")));
  assert.ok(tiered.posts.some((p) => (p.text || "").includes("PINNED_PORT_CONSTRAINT")));
  assert.ok(tiered.posts.find((p) => p.seq === 2)?.stub === true);
  assert.ok(Buffer.byteLength(JSON.stringify(tiered.posts), "utf8") <= 1800);

  // MCP compaction of 25 KB payload -> <= 8500 bytes valid JSON preserving recall metadata
  const hugePayload = {
    ok: true,
    jobId: "job-big-123",
    patchPath: "/tmp/example.patch",
    changedFiles: ["src/a.js"],
    scopeViolations: [],
    output: "LINE_ALPHA ".repeat(2200),
    findings: [{ severity: "advisory", title: "Note", body: "Detail ".repeat(200), file: "src/a.js", line_start: 1, line_end: 2, trigger_path: "", recommendation: "Ok" }]
  };
  const compacted = compactMcpPayload("relay_jobs", hugePayload, { maxBytes: 8500 });
  const bytes = Buffer.byteLength(JSON.stringify(compacted), "utf8");
  assert.ok(bytes <= 8500, `Expected <=8500 bytes, got ${bytes}`);
  assert.equal(compacted._compacted, true);
  assert.equal(compacted.jobId, "job-big-123");
  assert.equal(compacted.patchPath, "/tmp/example.patch");
  assert.ok(String(compacted._recall).includes("compact=false"));

  const serialized = serializeMcpPayload("relay_run", hugePayload, { maxBytes: 8500 });
  assert.ok(serialized.bytes <= 8500);
  JSON.parse(serialized.text);

  const hugePathPayload = { jobId: "test", patchPath: "x".repeat(1400), output: "ok" };
  const tightSer = serializeMcpPayload("relay_jobs", hugePathPayload, { maxBytes: 1024 });
  assert.ok(tightSer.bytes <= 1024, `Expected <=1024 bytes even with 1400B patchPath, got ${tightSer.bytes}`);
  assert.equal(JSON.parse(tightSer.text)._compacted, true);

  const hugePinnedAuthor = buildTieredBoardView(
    [{ seq: 1, author: "a".repeat(750), tag: "[pin]", text: "ok" }],
    { boardId: "b2", maxBytes: 500 }
  );
  assert.ok(Buffer.byteLength(JSON.stringify(hugePinnedAuthor.posts), "utf8") <= 500);

  console.log("[PASS] Compact UTF-8 slicing, 3-tier board Pin/Stub/Recall, and <=8.5KB MCP compaction");
}

function testCodexMcpIsolation() {
  const servers = listConfiguredCodexMcpServers();
  assert.deepEqual(servers.sort(), ["codegraph", "figma", "my server", "trirelay"]);
  assert.ok(!servers.includes("figma.env"), "Sub-tables like [mcp_servers.figma.env] must not be treated as MCP server names");

  const defaultDisabled = resolveDisabledCodexMcpServers();
  assert.deepEqual(defaultDisabled, ["codegraph", "figma", "my server", "trirelay"]);

  const argsDefault = buildCodexExecArgs({ cwd: REPO_DIR });
  assert.ok(argsDefault.includes("mcp_servers.figma.enabled=false"));
  assert.ok(argsDefault.includes('mcp_servers."my server".enabled=false'));
  assert.ok(argsDefault.includes("mcp_servers.trirelay.enabled=false"));
  assert.ok(!argsDefault.some((a) => a.includes("figma.env")), "Must never emit sub-table override");

  process.env.TRIRELAY_CODEX_MCP_ALLOW = "codegraph";
  const allowCodegraph = resolveDisabledCodexMcpServers();
  assert.deepEqual(allowCodegraph, ["figma", "my server", "trirelay"]);
  delete process.env.TRIRELAY_CODEX_MCP_ALLOW;

  process.env.TRIRELAY_CODEX_KEEP_MCP = "1";
  const keepMcp = resolveDisabledCodexMcpServers();
  assert.deepEqual(keepMcp, ["trirelay"]);
  delete process.env.TRIRELAY_CODEX_KEEP_MCP;

  // B3: TOML whitespace around dotted key & [mcp_servers] inline keys
  const prevCodexHome = process.env.CODEX_HOME;
  const wsCodexHome = path.join(TMP_BASE, "codex-ws-toml");
  fs.mkdirSync(wsCodexHome, { recursive: true });
  fs.writeFileSync(
    path.join(wsCodexHome, "config.toml"),
    '[ mcp_servers . example ]\ncommand = "ex"\n[ mcp_servers ]\ninline_srv = { command = "y" }\n'
  );
  process.env.CODEX_HOME = wsCodexHome;
  const wsServers = listConfiguredCodexMcpServers();
  process.env.CODEX_HOME = prevCodexHome;
  assert.ok(wsServers.includes("example"), "Missed [ mcp_servers . example ]");
  assert.ok(wsServers.includes("inline_srv"), "Missed [ mcp_servers ] inline key");

  // B2: resumeThreadId rejects leading dashes and separates positional arg with `--`
  assert.throws(() => buildCodexExecArgs({ cwd: REPO_DIR, resumeThreadId: "-evil" }), /Invalid resumeSessionId/);
  const resumeArgs = buildCodexExecArgs({ cwd: REPO_DIR, resumeThreadId: "thread-123" });
  const sepIdx = resumeArgs.indexOf("--");
  assert.ok(sepIdx !== -1 && resumeArgs[sepIdx + 1] === "thread-123");

  console.log("[PASS] Codex worker MCP isolation (config.toml parsing, allowlist, sub-table safety, -- guard)");
}

async function testAllThreeDriversAndGuardrails() {
  if (fs.existsSync(RECORD_FILE)) fs.unlinkSync(RECORD_FILE);

  const agyRes = await runSingleTask(REPO_DIR, { engine: "agy", effort: "low", prompt: "hello agy" });
  assert.equal(agyRes.ok, true);
  assert.equal(agyRes.output, "FAKE_AGY_OK");

  const claudeRes = await runSingleTask(REPO_DIR, { engine: "claude", model: "opus", effort: "high", prompt: "hello claude" });
  assert.equal(claudeRes.ok, true);
  assert.equal(claudeRes.output, "FAKE_CLAUDE_OK");

  const codexRes = await runSingleTask(REPO_DIR, { engine: "codex", effort: "low", prompt: "hello codex" });
  assert.equal(codexRes.ok, true);
  assert.equal(codexRes.output, "FAKE_CODEX_OK");

  const records = fs.readFileSync(RECORD_FILE, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(records.length, 3);
  for (const rec of records) {
    assert.equal(rec.claudecode, null, "Nested CLAUDECODE leaked");
    assert.equal(rec.claudeSession, null, "Nested CLAUDE_CODE_SESSION_ID leaked");
    assert.equal(rec.pluginData, null, "PLUGIN_DATA leaked");
    assert.equal(rec.trirelayDepth, "1", "TRIRELAY_DEPTH not incremented");
  }

  const claudeRec = records.find((r) => r.bin === "claude");
  assert.ok(claudeRec.argv.includes("dontAsk"), "Claude readonly must use --permission-mode dontAsk");
  assert.ok(!claudeRec.argv.includes("plan"), "Claude readonly must NOT use --permission-mode plan");
  assert.ok(claudeRec.argv.includes("--strict-mcp-config"), "Claude worker must use --strict-mcp-config");

  const codexRec = records.find((r) => r.bin === "codex");
  assert.ok(codexRec.argv.includes("mcp_servers.trirelay.enabled=false"), "Codex worker must disable trirelay MCP");
  assert.ok(codexRec.argv.includes("mcp_servers.figma.enabled=false"), "Codex worker must disable unrelated figma MCP by default");

  const unconfiguredArgs = buildCodexExecArgs({ cwd: REPO_DIR, disabledMcpServers: [] });
  assert.ok(!unconfiguredArgs.some((a) => a.includes("mcp_servers.")));

  const agyDefaultArgs = buildAgyArgs({ prompt: "hi", model: null, effort: "low" });
  assert.ok(!agyDefaultArgs.includes("--effort"), "agy must omit --effort when model is unset");
  const agySuffixedArgs = buildAgyArgs({ prompt: "hi", model: "gemini-4-neon-high", effort: "high" });
  assert.ok(!agySuffixedArgs.includes("--effort"), "agy must omit --effort when model already encodes effort");

  const claudeSchemaArgs = buildClaudeArgs({
    outputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { ok: { type: "boolean" } } }
  });
  const schemaIdx = claudeSchemaArgs.indexOf("--json-schema");
  assert.ok(schemaIdx !== -1 && !claudeSchemaArgs[schemaIdx + 1].includes("2020-12"), "Claude --json-schema must strip 2020-12 $schema meta-URI");

  // Recursion depth guard
  process.env.TRIRELAY_DEPTH = "1";
  assert.throws(() => assertRecursionSafe(), /recursion guard/i);
  delete process.env.TRIRELAY_DEPTH;

  console.log("[PASS] All 3 drivers (agy/claude/codex), argv snapshots, env scrub & recursion guard");
}

function testHostSymmetryRouting() {
  const claudeAdvisor = resolveRoute({ host: "claude", profile: "advisor" });
  assert.equal(claudeAdvisor.primary.engine, "agy");

  const codexImpl = resolveRoute({ host: "codex", profile: "implementer" });
  assert.equal(codexImpl.primary.engine, "claude");

  const agyImpl = resolveRoute({ host: "agy", profile: "implementer" });
  assert.equal(agyImpl.primary.engine, "codex");

  const explicit = resolveRoute({ host: "claude", engine: "codex", effort: "low" });
  assert.deepEqual(explicit.fallback, [], "Explicit engine must have empty fallback");

  const opp = resolveRoute({ host: "agy", profile: "opposite-verifier", authorEngine: "codex" });
  assert.notEqual(opp.primary.engine, "codex");
  assert.ok(!opp.fallback.some((f) => f.engine === "codex"));

  assert.throws(() => resolveRoute({ profile: "nonexistent-profile" }), /Unknown routing profile/);
  console.log("[PASS] Host-symmetric role routing & explicit isolation");
}

async function testSecurityAndValidation() {
  assert.throws(() => validateCallerArgs({ sandbox: "danger-full-access" }), /Security error/);
  assert.throws(() => validateCallerArgs({ permissionMode: "bypassPermissions" }), /Security error/);
  assert.throws(() => validateCallerArgs({ jobId: "../evil" }), /Security error/);
  assert.throws(() => validateCallerArgs({ handoffId: "../../etc/passwd" }), /Invalid handoffId/);
  assert.throws(() => createHandoffPacket(REPO_DIR, { handoffId: "../bad", goal: "x" }), /Invalid handoffId/);
  assert.throws(() => loadHandoffPacket(REPO_DIR, "/etc/passwd"), /Invalid handoffId/);

  await assert.rejects(
    () => runSingleTask(NON_GIT_DIR, { engine: "codex", mode: "write", worktree: true, prompt: "edit" }),
    /not a git repository/i
  );
  await assert.rejects(
    () => runSingleTask(REPO_DIR, { engine: "codex", mode: "write", worktree: false, prompt: "edit" }),
    /always requires isolated git worktree/i
  );
  await assert.rejects(
    () => runCopyReview(REPO_DIR, { filePath: "/etc/hosts" }),
    /outside workspace/i
  );

  // B1: symlinked docs/handoff.md escaping workspace must fail closed
  fs.mkdirSync(path.join(REPO_DIR, "docs"), { recursive: true });
  const docsHandoff = path.join(REPO_DIR, "docs", "handoff.md");
  fs.symlinkSync("/etc/hosts", docsHandoff);
  try {
    assert.throws(
      () => createHandoffPacket(REPO_DIR, { goal: "leak", includeRepoHandoff: true }),
      /outside workspace/i
    );
  } finally {
    fs.unlinkSync(docsHandoff);
  }

  // B2/B7: base ref option injection rejected; non-array ownedFiles rejected
  assert.throws(() => validateCallerArgs({ ownedFiles: "src/app.js" }), /must be an array of strings/);
  const badBaseRev = await runDualReview(REPO_DIR, { engine: "claude", base: "--output=/tmp/evil" });
  assert.equal(badBaseRev.ok, false);
  assert.match(badBaseRev.error || "", /Invalid base ref/i);

  await assert.rejects(() => runDualReview(REPO_DIR, { engine: "invalid" }), /Invalid (?:review )?engine/);
  process.env.TRIRELAY_TEST_CLAUDE_FAIL = "1";
  const incompleteRev = await runDualReview(REPO_DIR, { engine: "claude" });
  delete process.env.TRIRELAY_TEST_CLAUDE_FAIL;
  assert.equal(incompleteRev.ok, false);
  assert.equal(incompleteRev.verdict, "incomplete");

  process.env.TRIRELAY_TEST_CODEX_PARTIAL_FAIL = "1";
  const partialRes = await runSingleTask(REPO_DIR, { profile: "implementer", mode: "write", prompt: "write something" });
  delete process.env.TRIRELAY_TEST_CODEX_PARTIAL_FAIL;
  assert.equal(partialRes.ok, false);
  assert.equal(partialRes.routingDecision.attempts.length, 1);

  console.log("[PASS] Input validation, path-traversal block, fail-closed worktree & review incomplete");
}

function testPrefixCacheHandoffAndBoardDigest() {
  const bId = `prefix-board-${Date.now()}`;
  postBoardMessage(REPO_DIR, bId, { author: "codex:arch", tag: "[decision]", text: "INVARIANT_ZERO_DEPS=true" });
  postBoardMessage(REPO_DIR, bId, { author: "claude:worker", tag: "[update]", text: "Verified files cleanly" });

  const { packet } = createHandoffPacket(REPO_DIR, {
    workflowId: bId,
    boardId: bId,
    includeBoardDigest: true,
    goal: "Implement module cleanly",
    ownedFiles: ["src/app.js"],
    invariants: ["Never alter public signature"],
    doNotRelitigate: ["Keep ESM zero-dependency"],
    contextDigest: "Recent snippet digest"
  });

  const md = renderHandoffMarkdown(packet);
  const idxContract = md.indexOf("Return Contract:");
  const idxInvariants = md.indexOf("Invariants (Pinned):");
  const idxDoNotRelitigate = md.indexOf("Do Not Re-Litigate (Pinned):");
  const idxBoard = md.indexOf("Board Continuity (Tiered):");
  const idxContext = md.indexOf("Context Digest:");

  assert.ok(idxContract !== -1 && idxInvariants > idxContract);
  assert.ok(idxDoNotRelitigate > idxInvariants);
  assert.ok(idxBoard > idxDoNotRelitigate, "Dynamic board continuity must follow static/pinned prefix");
  assert.ok(idxContext > idxBoard, "Dynamic context digest must sit at the tail for prefix caching");
  assert.ok(md.includes("INVARIANT_ZERO_DEPS=true"));

  console.log("[PASS] Prefix-cache handoff ordering & tiered board digest");
}

function testWorktreeCommitsSpacesScopeAndApply() {
  const renamed = parsePorcelainZ("R  src/moved.txt\0docs/handoff.md\0");
  assert.ok(renamed.includes("src/moved.txt"));
  assert.ok(renamed.includes("docs/handoff.md"));
  assert.equal(auditFileScope(renamed, { ownedFiles: ["src/**"], forbiddenFiles: ["docs/handoff.md"] }).length, 2);

  const wt = createIsolatedWorktree(REPO_DIR, { id: `wt-test-${Date.now()}` });
  try {
    fs.writeFileSync(path.join(wt.worktreePath, "src", "app.js"), "export const v = 2;\n");
    runSync("git", ["add", "src/app.js"], { cwd: wt.worktreePath });
    runSync("git", ["commit", "-m", "worker commit"], { cwd: wt.worktreePath });
    fs.writeFileSync(path.join(wt.worktreePath, "src", "file with spaces.txt"), "spaced\n");
    fs.writeFileSync(path.join(wt.worktreePath, "src", "latin1.bin"), Buffer.from([0xe9, 0x0a]));

    const cap = captureWorktreeChanges(REPO_DIR, wt.worktreePath, wt.worktreeId, wt.baseSha);
    assert.equal(cap.hasChanges, true);
    assert.equal(cap.captureComplete, true);
    assert.ok(cap.changedFiles.includes("src/app.js"));
    assert.ok(cap.changedFiles.includes("src/file with spaces.txt"));
    assert.ok(cap.changedFiles.includes("src/latin1.bin"));
    assert.ok(cap.patchPath && fs.existsSync(cap.patchPath));

    const violations = auditFileScope(cap.changedFiles, {
      ownedFiles: ["src/app.js"],
      forbiddenFiles: ["docs/handoff.md"]
    });
    assert.equal(violations.length, 2);

    const checkRes = applyWorktreePatch(REPO_DIR, cap.patchPath, { mode: "check" });
    assert.equal(checkRes.ok, true);
    const applyRes = applyWorktreePatch(REPO_DIR, cap.patchPath, { mode: "apply" });
    assert.equal(applyRes.ok, true);
    assert.equal(fs.readFileSync(path.join(REPO_DIR, "src", "app.js"), "utf8"), "export const v = 2;\n");
    assert.deepEqual(fs.readFileSync(path.join(REPO_DIR, "src", "latin1.bin")), Buffer.from([0xe9, 0x0a]));

    // B4: Committed rename from forbidden path to owned path still triggers scope violation
    fs.mkdirSync(path.join(wt.worktreePath, "docs"), { recursive: true });
    fs.writeFileSync(path.join(wt.worktreePath, "docs", "handoff.md"), "owned secret\n");
    runSync("git", ["add", "docs/handoff.md"], { cwd: wt.worktreePath });
    runSync("git", ["commit", "-m", "add docs handoff"], { cwd: wt.worktreePath });
    const postAddSha = runSync("git", ["rev-parse", "HEAD"], { cwd: wt.worktreePath }).stdout.trim();
    runSync("git", ["mv", "docs/handoff.md", "src/moved-secret.md"], { cwd: wt.worktreePath });
    runSync("git", ["commit", "-m", "rename forbidden to owned"], { cwd: wt.worktreePath });
    const renameCap = captureWorktreeChanges(REPO_DIR, wt.worktreePath, `wt-ren-${Date.now()}`, postAddSha);
    assert.ok(renameCap.changedFiles.includes("docs/handoff.md"), "Rename source path missing from audit");
    assert.ok(renameCap.changedFiles.includes("src/moved-secret.md"), "Rename target path missing from audit");
    const renViolations = auditFileScope(renameCap.changedFiles, {
      ownedFiles: ["src/**"],
      forbiddenFiles: ["docs/handoff.md"]
    });
    assert.ok(renViolations.some((v) => v.includes("docs/handoff.md")), "Forbidden source path must trigger violation");
  } finally {
    removeIsolatedWorktree(REPO_DIR, wt.worktreePath);
  }
  console.log("[PASS] Worktree commit+space+binary capture, rename audit & safe patch apply");
}

async function testConcurrentBoardLocking() {
  const boardId = `concurrent-${Date.now()}`;
  const procs = Array.from({ length: 8 }, (_, idx) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [path.join(PACKAGE_ROOT, "bin", "trirelay.mjs"), "board", "post", "--cwd", REPO_DIR, "--board", boardId, "--author", `w${idx}`, `msg-${idx}`],
        { env: process.env, stdio: "pipe" }
      );
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`board post exited ${code}`))));
    })
  );
  await Promise.all(procs);
  const posts = readBoardPosts(REPO_DIR, boardId, { since: 0, limit: 0 });
  assert.equal(posts.length, 8);
  assert.deepEqual(
    posts.map((p) => p.seq),
    [1, 2, 3, 4, 5, 6, 7, 8]
  );
  console.log("[PASS] Cross-process board locking (8 concurrent writers -> seq 1..8)");
}

async function testSealedDesignCopyReviewAndGate() {
  await assert.rejects(
    () => runDualDesign(REPO_DIR, { action: "start", requirement: "x", hostDraft: "leak" }),
    /Anti-anchoring violation/
  );
  const started = await runDualDesign(REPO_DIR, {
    action: "start",
    designId: "d-test-1",
    requirement: "Design cache invalidation",
    contextPaths: ["src/app.js"]
  });
  assert.equal(started.ok, true);
  await assert.rejects(
    () => runDualDesign(REPO_DIR, { action: "reveal", designId: "d-test-1" }),
    /cannot reveal/i
  );
  await runDualDesign(REPO_DIR, {
    action: "submit_host",
    designId: "d-test-1",
    hostDraft: "Host independent draft"
  });
  const revealed = await runDualDesign(REPO_DIR, { action: "reveal", designId: "d-test-1" });
  assert.equal(revealed.ok, true);
  assert.equal(revealed.mergeTemplate.length, 4);

  const copyRes = await runCopyReview(REPO_DIR, { content: "Done now please check" });
  assert.equal(copyRes.ok, true);
  assert.equal(copyRes.rows.length, 1);

  fs.writeFileSync(path.join(REPO_DIR, "src", "auth.js"), "export function login() { return false; }\n");
  process.env.TRIRELAY_TEST_REVIEW_BLOCKING = "1";
  const r1 = await runReviewGate(REPO_DIR, { gateKey: "gate-1", engine: "claude" });
  assert.equal(r1.decision, "fix_required");
  assert.equal(r1.effort, "xhigh", "Expected auto-xhigh because src/auth.js changed");
  const r2 = await runReviewGate(REPO_DIR, { gateKey: "gate-1", engine: "claude" });
  assert.equal(r2.decision, "fix_required");
  const r3 = await runReviewGate(REPO_DIR, { gateKey: "gate-1", engine: "claude" });
  assert.equal(r3.decision, "escalate_to_user");
  assert.equal(r3.remainingBlockingFindings.length, 1);
  delete process.env.TRIRELAY_TEST_REVIEW_BLOCKING;

  console.log("[PASS] Sealed dual-design, copy-review & bounded 2-round review-gate");
}

async function testSwarmDagValidation() {
  await assert.rejects(
    () =>
      runOrchestration(REPO_DIR, {
        pattern: "swarm",
        workers: [
          { name: "a", dependsOn: ["b"], prompt: "1" },
          { name: "b", dependsOn: ["a"], prompt: "2" }
        ]
      }),
    /cycle/i
  );

  process.env.TRIRELAY_TEST_CLAUDE_FAIL = "1";
  const swarmRes = await runOrchestration(REPO_DIR, {
    pattern: "swarm",
    workers: [
      { name: "spec", engine: "claude", mode: "readonly", prompt: "write spec" },
      { name: "impl", engine: "codex", mode: "readonly", dependsOn: ["spec"], prompt: "implement" }
    ]
  });
  delete process.env.TRIRELAY_TEST_CLAUDE_FAIL;
  assert.equal(swarmRes.ok, false);
  assert.equal(swarmRes.workers[1].blocked, true);
  console.log("[PASS] Swarm pre-flight cycle detection & failure blocking propagation");
}

function testSessionHookSnapshots() {
  const hookScript = path.join(PACKAGE_ROOT, "scripts", "session-hook.mjs");

  const t0 = Date.now();
  const agyOut = runSync(process.execPath, [hookScript], {
    input: JSON.stringify({ cwd: REPO_DIR, conversationId: "conv-123", workspacePaths: [REPO_DIR] }),
    timeoutMs: 3000
  });
  const agyMs = Date.now() - t0;
  assert.equal(agyOut.status, 0);
  const agyJson = JSON.parse(agyOut.stdout);
  const agyMsg = agyJson.injectSteps?.[0]?.systemMessage?.systemMessage || "";
  assert.ok(agyMsg.includes("[Trirelay Session Snapshot"));
  assert.ok(agyMsg.includes("Resumable Roles:"));
  assert.ok(agyMsg.includes("Latest Handoff:"));
  assert.ok(Buffer.byteLength(agyMsg, "utf8") <= 1500);
  assert.ok(agyMs < 1500, `SessionStart took too long: ${agyMs}ms`);

  const claudeOut = runSync(process.execPath, [hookScript], {
    input: JSON.stringify({ cwd: REPO_DIR, session_id: "sess-123", hook_event_name: "SessionStart" }),
    timeoutMs: 3000
  });
  assert.equal(claudeOut.status, 0);
  const claudeJson = JSON.parse(claudeOut.stdout);
  assert.equal(claudeJson.hookSpecificOutput?.hookEventName, "SessionStart");
  assert.ok(claudeJson.hookSpecificOutput?.additionalContext?.includes("[Trirelay Session Snapshot"));

  const homeOut = runSync(process.execPath, [hookScript], {
    input: JSON.stringify({ cwd: os.homedir(), conversationId: "conv-home" }),
    timeoutMs: 3000
  });
  assert.equal(homeOut.status, 0);
  assert.deepEqual(JSON.parse(homeOut.stdout), {});

  console.log(`[PASS] SessionStart continuity snapshots (agy ${agyMs}ms + claude + home skip)`);
}

async function testAsyncMcpServer() {
  const child = spawn(process.execPath, [path.join(PACKAGE_ROOT, "bin", "trirelay-mcp.mjs")], {
    cwd: REPO_DIR,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const responses = new Map();
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let idx = buf.indexOf("\n");
    while (idx !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) {
        const msg = JSON.parse(line);
        if (msg.id !== undefined) responses.set(msg.id, msg);
      }
      idx = buf.indexOf("\n");
    }
  });
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  const waitForId = async (id, timeoutMs = 15000) => {
    const start = Date.now();
    while (!responses.has(id)) {
      if (Date.now() - start > timeoutMs) throw new Error(`MCP timeout id=${id}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    return responses.get(id);
  };

  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    const init = await waitForId(1);
    assert.equal(init.result.serverInfo.name, "trirelay");

    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = await waitForId(2);
    const names = list.result.tools.map((t) => t.name);
    for (const expected of ["relay_setup", "relay_design", "relay_copy_review", "relay_review_gate", "relay_apply", "relay_jobs"]) {
      assert.ok(names.includes(expected), `Missing MCP tool ${expected}`);
    }

    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "relay_run", arguments: { cwd: REPO_DIR, engine: "codex", background: true, prompt: "bg hello" } }
    });
    const bgLaunch = await waitForId(3);
    assert.equal(bgLaunch.result.isError, false);
    const launchData = JSON.parse(bgLaunch.result.content[0].text);
    assert.equal(launchData.background, true);
    assert.equal(launchData.status, "running");

    send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "relay_jobs", arguments: { cwd: REPO_DIR, action: "wait", jobId: launchData.jobId, waitTimeoutMs: 10000 } }
    });
    const waited = await waitForId(4);
    const jobData = JSON.parse(waited.result.content[0].text);
    assert.equal(jobData.job.status, "completed");
    assert.equal(jobData.job.output, "FAKE_CODEX_OK");

    send({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "relay_board", arguments: { cwd: REPO_DIR, action: "read", view: "tiered" } }
    });
    const boardRes = await waitForId(5);
    assert.equal(boardRes.result.isError, false);
    assert.equal(JSON.parse(boardRes.result.content[0].text).view, "tiered");

    // B7: JSON `null` does not crash server; non-array ownedFiles is rejected cleanly
    child.stdin.write("null\n");
    send({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "relay_run", arguments: { cwd: REPO_DIR, mode: "write", ownedFiles: "src/app.js", prompt: "x" } }
    });
    const badTypeRes = await waitForId(6);
    assert.equal(badTypeRes.result.isError, true);
    assert.match(badTypeRes.result.content[0].text, /expected array/i);

    console.log("[PASS] Async MCP server (initialize, tools/list, background run, wait/result, tiered board, validation)");
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
  }
}

function testInstallerDryRun() {
  const plan = planInstall({ hosts: ["agy", "claude", "codex"], homeDir: HOME_DIR, packageRoot: PACKAGE_ROOT });
  assert.equal(plan.actions.length, 3);
  assert.ok(plan.launcherPath.endsWith("mcp-launcher.sh"));
  console.log("[PASS] Installer dry-run plan");
}

async function testReleaseGateStateConsistencySuite() {
  // R1 (P1 #1): Resumed write session stays bound to original worktree (or replays patch, or fails closed)
  process.env.TRIRELAY_TEST_CREATE_FEATURE = "1";
  const r1Turn1 = await runSingleTask(REPO_DIR, {
    engine: "codex",
    mode: "write",
    workflowId: "wf-r1",
    role: "impl-r1",
    ownedFiles: ["src/**"],
    prompt: "Create src/feature.txt"
  });
  assert.equal(r1Turn1.ok, true);
  assert.ok(r1Turn1.worktreePath && fs.existsSync(path.join(r1Turn1.worktreePath, "src", "feature.txt")));

  const r1Turn2 = await runSingleTask(REPO_DIR, {
    engine: "codex",
    mode: "write",
    workflowId: "wf-r1",
    role: "impl-r1",
    resumeRole: true,
    ownedFiles: ["src/**"],
    prompt: "Modify src/feature.txt"
  });
  assert.equal(r1Turn2.ok, true);
  assert.ok(r1Turn2.output.includes("hasFeature=true"), `Expected hasFeature=true in resumed write turn, got: ${r1Turn2.output}`);
  assert.equal(r1Turn2.worktreePath, r1Turn1.worktreePath);
  assert.ok(r1Turn2.patchPath && fs.readFileSync(r1Turn2.patchPath, "utf8").includes("turn2=ok"));

  // Replay path: delete original worktree while keeping patch, then fork/resume -> replays patch cleanly
  removeIsolatedWorktree(REPO_DIR, r1Turn1.worktreePath);
  const r1Replay = await runSingleTask(REPO_DIR, {
    engine: "codex",
    mode: "write",
    workflowId: "wf-r1",
    role: "impl-r1",
    resumeRole: true,
    ownedFiles: ["src/**"],
    prompt: "Continue after worktree cleanup"
  });
  assert.equal(r1Replay.ok, true);
  assert.ok(r1Replay.output.includes("hasFeature=true"), `Expected patch replay to restore src/feature.txt, got: ${r1Replay.output}`);
  assert.notEqual(r1Replay.worktreePath, r1Turn1.worktreePath);

  // B1: Per-job immutable patches + SHA-256 + apply-time re-audit (resumed job cannot clobber earlier clean job patch)
  assert.notEqual(r1Turn1.patchPath, r1Turn2.patchPath, "Turn 2 resume must not overwrite Turn 1 patchPath");
  assert.ok(r1Turn1.patchSha256 && r1Turn2.patchSha256);
  const applyJob1Check = applyJobPatch(REPO_DIR, { ...r1Turn1, status: "completed" }, { mode: "check" });
  assert.equal(applyJob1Check.ok, true);
  assert.throws(
    () => applyJobPatch(REPO_DIR, { ...r1Turn1, status: "completed", patchSha256: "0".repeat(64) }, { mode: "check" }),
    /integrity check failed/i
  );
  assert.throws(
    () =>
      applyJobPatch(
        REPO_DIR,
        { ...r1Turn1, status: "completed", forbiddenFiles: ["src/feature.txt"] },
        { mode: "check" }
      ),
    /apply-time scope re-audit/i
  );
  assert.ok(extractPatchTouchedFiles(fs.readFileSync(r1Turn1.patchPath, "utf8"), REPO_DIR).includes("src/feature.txt"));

  // Round 2 B1: SQL `--` comment deletion (`---`) & Unicode path (`src/café.js`) must pass authoritative numstat audit & apply; legacy patch without patchSha256 rejected on apply
  const wtSql = createIsolatedWorktree(REPO_DIR, { id: `wt-sql-${Date.now()}` });
  try {
    fs.writeFileSync(path.join(wtSql.worktreePath, "src", "query.sql"), "-- legacy comment\nSELECT 1;\n");
    runSync("git", ["add", "src/query.sql"], { cwd: wtSql.worktreePath });
    runSync("git", ["commit", "-m", "add sql"], { cwd: wtSql.worktreePath });
    const sqlBaseSha = runSync("git", ["rev-parse", "HEAD"], { cwd: wtSql.worktreePath }).stdout.trim();
    fs.writeFileSync(path.join(wtSql.worktreePath, "src", "query.sql"), "SELECT 1;\n");
    fs.writeFileSync(path.join(wtSql.worktreePath, "src", "café.js"), "export const cafe = 1;\n");
    const sqlCap = captureWorktreeChanges(REPO_DIR, wtSql.worktreePath, wtSql.worktreeId, sqlBaseSha, { patchId: `sql-${Date.now()}` });
    const sqlTouched = extractPatchTouchedFiles(fs.readFileSync(sqlCap.patchPath), REPO_DIR);
    assert.deepEqual(sqlTouched.sort(), ["src/café.js", "src/query.sql"].sort(), `Unexpected parsed files: ${JSON.stringify(sqlTouched)}`);
    assert.equal(auditFileScope(sqlTouched, { ownedFiles: ["src/query.sql", "src/café.js"], forbiddenFiles: ["docs/handoff.md"] }).length, 0);
  } finally {
    removeIsolatedWorktree(REPO_DIR, wtSql.worktreePath);
  }
  assert.throws(
    () => applyJobPatch(REPO_DIR, { ...r1Turn1, status: "completed", patchSha256: null }, { mode: "apply" }),
    /without patchSha256/i
  );
  // Advisory B1: Rename patch extracts BOTH source and destination regardless of Git version
  const renamePatch = [
    "diff --git a/docs/handoff.md b/src/renamed-out.txt",
    "similarity index 100%",
    "rename from docs/handoff.md",
    "rename to src/renamed-out.txt",
    ""
  ].join("\n");
  const renTouched = extractPatchTouchedFiles(renamePatch, REPO_DIR);
  assert.ok(renTouched.includes("docs/handoff.md") && renTouched.includes("src/renamed-out.txt"));

  // B2: Fresh session under same (workflow, role, engine) does not inherit prior patch/worktree,
  // old sessionId stays in lookup, cross-role readonly keeps write binding, and live-PID lease never expires early.
  recordRoleSession(REPO_DIR, {
    workflowId: "wf-b2",
    role: "reviewer",
    engine: "codex",
    sessionId: "sess-b2-crossrole-rev",
    worktreeId: "wt-b2",
    worktreePath: r1Replay.worktreePath,
    baseSha: r1Turn1.baseSha,
    patchPath: r1Turn1.patchPath,
    patchSha256: r1Turn1.patchSha256,
    finalHeadSha: r1Turn1.finalHeadSha,
    isWriteRun: true
  });
  recordRoleSession(REPO_DIR, {
    workflowId: "wf-b2",
    role: "other-role",
    engine: "codex",
    sessionId: "sess-b2-crossrole-rev",
    isWriteRun: false
  });
  assert.equal(
    lookupSessionById(REPO_DIR, { engine: "codex", sessionId: "sess-b2-crossrole-rev" })?.hadWorktree,
    true,
    "Cross-role readonly reuse of same sessionId must preserve hadWorktree"
  );
  recordRoleSession(REPO_DIR, {
    workflowId: "wf-b2",
    role: "reviewer",
    engine: "codex",
    sessionId: "sess-b2-fresh",
    isWriteRun: false
  });
  assert.equal(
    lookupSessionById(REPO_DIR, { engine: "codex", sessionId: "sess-b2-fresh" })?.patchPath,
    null,
    "Fresh session must NOT inherit previous session patchPath"
  );
  assert.equal(
    lookupSessionById(REPO_DIR, { engine: "codex", sessionId: "sess-b2-crossrole-rev" })?.sessionId,
    "sess-b2-crossrole-rev",
    "Previous sessionId must remain resolvable after new session uses same workflow/role/engine"
  );
  assert.equal(acquireSessionLease(REPO_DIR, "codex", "sess-b2-lease", "owner-1"), true);
  // Backdate acquiredAt by 3 hours while PID is alive -> competing owner must still be blocked
  const ledgerFileB2 = sessionLedgerPath(REPO_DIR);
  const ledgerB2 = JSON.parse(fs.readFileSync(ledgerFileB2, "utf8"));
  ledgerB2.leases["codex::sess-b2-lease"].acquiredAt = new Date(Date.now() - 3 * 3600_000).toISOString();
  writeJsonAtomic(ledgerFileB2, ledgerB2);
  assert.equal(
    acquireSessionLease(REPO_DIR, "codex", "sess-b2-lease", "owner-2"),
    false,
    "Live PID lease must remain locked regardless of age"
  );
  releaseSessionLease(REPO_DIR, "codex", "sess-b2-lease", "owner-1");

  // Round 2 B2: Legacy `entries`-only ledger hydrates bySession across readonly cross-role resume;
  // fork via resumeRole uses canonical bySession; captureComplete=false produces deliverableMode="incomplete".
  const legacyLedger = JSON.parse(fs.readFileSync(ledgerFileB2, "utf8"));
  delete legacyLedger.bySession["codex::sess-b2-legacy"];
  legacyLedger.entries["wf-leg::impl::codex"] = {
    workflowId: "wf-leg",
    role: "impl",
    engine: "codex",
    sessionId: "sess-b2-legacy",
    sessionCwd: REPO_DIR,
    worktreeId: "wt-leg",
    worktreePath: r1Replay.worktreePath,
    baseSha: r1Turn1.baseSha,
    patchPath: r1Turn1.patchPath,
    patchSha256: r1Turn1.patchSha256,
    deliverableMode: "patch",
    finalHeadSha: r1Turn1.finalHeadSha,
    hadWorktree: true,
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  legacyLedger.entries["wf-leg::reviewer::codex"] = {
    workflowId: "wf-leg",
    role: "reviewer",
    engine: "codex",
    sessionId: "sess-b2-legacy",
    sessionCwd: REPO_DIR,
    hadWorktree: false,
    updatedAt: "2026-02-01T00:00:00.000Z"
  };
  writeJsonAtomic(ledgerFileB2, legacyLedger);
  assert.equal(
    lookupSessionById(REPO_DIR, { engine: "codex", sessionId: "sess-b2-legacy" })?.hadWorktree,
    true,
    "Legacy lookupSessionById must prefer hadWorktree=true over newer readonly entry"
  );
  recordRoleSession(REPO_DIR, {
    workflowId: "wf-leg-2",
    role: "reviewer",
    engine: "codex",
    sessionId: "sess-b2-legacy",
    isWriteRun: false
  });
  assert.equal(lookupSessionById(REPO_DIR, { engine: "codex", sessionId: "sess-b2-legacy" })?.hadWorktree, true);

  recordRoleSession(REPO_DIR, {
    workflowId: "wf-fork-canon",
    role: "role-a",
    engine: "codex",
    sessionId: "sess-fork-canon",
    worktreeId: "wt-f1",
    worktreePath: null,
    baseSha: r1Turn1.baseSha,
    patchPath: r1Turn1.patchPath,
    patchSha256: r1Turn1.patchSha256,
    deliverableMode: "patch",
    isWriteRun: true
  });
  recordRoleSession(REPO_DIR, {
    workflowId: "wf-fork-canon-other",
    role: "role-b",
    engine: "codex",
    sessionId: "sess-fork-canon",
    worktreeId: "wt-f2",
    worktreePath: null,
    baseSha: r1Turn2.baseSha,
    patchPath: r1Turn2.patchPath,
    patchSha256: r1Turn2.patchSha256,
    deliverableMode: "patch",
    isWriteRun: true
  });
  recordRoleSession(REPO_DIR, {
    workflowId: "wf-cap-inc",
    role: "impl",
    engine: "codex",
    sessionId: "sess-cap-inc",
    worktreeId: "wt-inc",
    worktreePath: null,
    baseSha: r1Turn1.baseSha,
    patchPath: null,
    deliverableMode: "none",
    captureComplete: false,
    isWriteRun: true
  });
  await assert.rejects(
    () =>
      runSingleTask(REPO_DIR, {
        engine: "codex",
        mode: "write",
        workflowId: "wf-cap-inc",
        role: "impl",
        resumeSessionId: "sess-cap-inc",
        ownedFiles: ["src/**"],
        prompt: "Incomplete capture must never recreate clean checkout"
      }),
    /bound worktree.*unavailable/i
  );

  // Fail-closed path: delete both worktree and patch -> explicit error instead of empty fresh worktree
  removeIsolatedWorktree(REPO_DIR, r1Replay.worktreePath);
  if (r1Replay.patchPath && fs.existsSync(r1Replay.patchPath)) fs.unlinkSync(r1Replay.patchPath);
  await assert.rejects(
    () =>
      runSingleTask(REPO_DIR, {
        engine: "codex",
        mode: "write",
        workflowId: "wf-r1",
        role: "impl-r1",
        resumeRole: true,
        ownedFiles: ["src/**"],
        prompt: "Should fail closed"
      }),
    /bound worktree.*unavailable/i
  );

  const forkCanonRes = await runSingleTask(REPO_DIR, {
    engine: "codex",
    mode: "write",
    workflowId: "wf-fork-canon",
    role: "role-a",
    resumeRole: true,
    forkSession: true,
    ownedFiles: ["src/**"],
    prompt: "Fork via role-a must see canonical role-b patch"
  });
  assert.equal(forkCanonRes.ok, true);
  assert.ok(
    fs.readFileSync(path.join(forkCanonRes.worktreePath, "src", "feature.txt"), "utf8").includes("turn2=ok"),
    "Fork via resumeRole must replay canonical session patch"
  );
  removeIsolatedWorktree(REPO_DIR, forkCanonRes.worktreePath);
  delete process.env.TRIRELAY_TEST_CREATE_FEATURE;

  // R2 (P1 #2): Pipeline multi-stage constraint inheritance + stage-local ownedFiles isolation + decision retirement
  const initPipeHandoff = createHandoffPacket(REPO_DIR, {
    workflowId: "wf-pipe-r2",
    goal: "Stage 1 module A",
    ownedFiles: ["src/app.js"],
    invariants: ["DO_NOT_CHANGE_PRODUCTION"],
    decisionsMade: ["Use algorithm A", "Keep interface clean"],
    doNotRelitigate: ["Keep the selected architecture"]
  });
  const pipeRes = await runOrchestration(REPO_DIR, {
    pattern: "pipeline",
    workflowId: "wf-pipe-r2",
    handoffId: initPipeHandoff.packet.handoffId,
    stages: [
      { engine: "claude", role: "s1", ownedFiles: ["src/app.js"], prompt: "Stage 1 work" },
      {
        engine: "codex",
        role: "s2",
        ownedFiles: ["src/auth.js"],
        decisionsMade: ["Switch to algorithm B"],
        supersededDecisions: ["Use algorithm A"],
        prompt: "Stage 2 work"
      },
      { engine: "agy", role: "s3", prompt: "Stage 3 verify" }
    ]
  });
  assert.equal(pipeRes.ok, true);
  assert.equal(pipeRes.stages.length, 3);
  const s2Packet = loadHandoffPacket(REPO_DIR, pipeRes.stages[1].handoffId);
  assert.ok(s2Packet.invariants.includes("DO_NOT_CHANGE_PRODUCTION"));
  assert.ok(s2Packet.doNotRelitigate.includes("Keep the selected architecture"));
  assert.ok(s2Packet.decisionsMade.includes("Keep interface clean"));
  assert.ok(s2Packet.decisionsMade.includes("Switch to algorithm B"));
  assert.ok(!s2Packet.decisionsMade.includes("Use algorithm A"), "Superseded decision must be retired");
  assert.deepEqual(s2Packet.scope.ownedFiles, ["src/auth.js"], "Stage 2 must NOT inherit Stage 1 ownedFiles");
  const s3Packet = loadHandoffPacket(REPO_DIR, pipeRes.stages[2].handoffId);
  assert.ok(s3Packet.invariants.includes("DO_NOT_CHANGE_PRODUCTION"));
  assert.ok(s3Packet.decisionsMade.includes("Switch to algorithm B"));
  assert.ok(!s3Packet.decisionsMade.includes("Use algorithm A"));
  assert.deepEqual(s3Packet.scope.ownedFiles, [], "Stage 3 without ownedFiles must NOT inherit Stage 2 ownedFiles");

  // B3: parentHandoffId inherits forbiddenFiles, rejects missing parent, supports chronological re-adoption,
  // and keeps byte-0 static prefix identical across differing stage ownedFiles.
  const b3Parent = createHandoffPacket(REPO_DIR, {
    workflowId: "wf-b3",
    goal: "Parent stage",
    ownedFiles: ["src/**"],
    forbiddenFiles: ["src/secrets/**"],
    invariants: ["INV_X"],
    decisionsMade: ["DEC_OLD"]
  });
  const b3Child = createHandoffPacket(REPO_DIR, {
    workflowId: "wf-b3",
    parentHandoffId: b3Parent.packet.handoffId,
    role: "impl",
    goal: "Child stage",
    ownedFiles: ["src/other.js"],
    supersededDecisions: ["DEC_OLD"]
  });
  const b3ReAdopt = createHandoffPacket(REPO_DIR, {
    workflowId: "wf-b3",
    parentHandoffId: b3Child.packet.handoffId,
    role: "impl-2",
    goal: "Stage 3 re-adopt",
    ownedFiles: ["src/another.js"],
    decisionsMade: ["DEC_OLD"]
  });
  assert.ok(b3Child.packet.scope.forbiddenFiles.includes("src/secrets/**"));
  assert.equal(auditFileScope(["src/secrets/key.js"], b3Child.packet.scope).length > 0, true);
  assert.ok(b3ReAdopt.packet.decisionsMade.includes("DEC_OLD"), "Later re-adoption must override earlier tombstone");
  assert.ok(!b3ReAdopt.packet.supersededDecisions.includes("DEC_OLD"));
  assert.throws(
    () => createHandoffPacket(REPO_DIR, { workflowId: "wf-b3", parentHandoffId: "hof-nonexistent-id", goal: "missing" }),
    /not found/i
  );
  assert.throws(
    () =>
      createHandoffPacket(REPO_DIR, {
        workflowId: "wf-b3",
        decisionsMade: ["DUP_DEC"],
        supersededDecisions: ["DUP_DEC"],
        goal: "conflicting same-hop"
      }),
    /Conflicting same-hop/i
  );
  const wtRootDir = path.dirname(r1Turn1.worktreePath);
  const wtCountBefore = fs.existsSync(wtRootDir) ? fs.readdirSync(wtRootDir).length : 0;
  await assert.rejects(
    () =>
      runSingleTask(REPO_DIR, {
        engine: "codex",
        mode: "write",
        workflowId: "wf-b3-leak",
        parentHandoffId: "hof-missing-parent",
        ownedFiles: ["src/**"],
        prompt: "Must not leak worktree"
      }),
    /not found/i
  );
  await assert.rejects(
    () =>
      runSingleTask(REPO_DIR, {
        engine: "codex",
        mode: "write",
        workflowId: "wf-b3-conflict",
        handoffId: b3Parent.packet.handoffId,
        parentHandoffId: b3Child.packet.handoffId,
        ownedFiles: ["src/**"],
        prompt: "Conflicting handoffId + parentHandoffId must throw"
      }),
    /Cannot specify both/i
  );
  const wtCountAfter = fs.existsSync(wtRootDir) ? fs.readdirSync(wtRootDir).length : 0;
  assert.equal(wtCountAfter, wtCountBefore, "Pre-flight handoff validation errors must NOT leak worktree directories");
  const b3Md1 = renderHandoffMarkdown(b3Parent.packet);
  const b3Md2 = renderHandoffMarkdown(
    createHandoffPacket(REPO_DIR, {
      workflowId: "wf-b3",
      parentHandoffId: b3Parent.packet.handoffId,
      role: "impl",
      goal: "Stage B diff ownedFiles",
      ownedFiles: ["src/different-stage.js"]
    }).packet
  );
  assert.equal(
    b3Md1.slice(0, b3Md1.indexOf("\n---\n")),
    b3Md2.slice(0, b3Md2.indexOf("\n---\n")),
    "Differing stage ownedFiles must NOT break byte-0 static prefix match"
  );

  // R4 (P1 #4): Early-exit EPIPE does not crash host, and orphan grandchild pipe holders die & settle cleanly on timeout
  const epipeRes = await spawnJsonlProcess({
    bin: process.execPath,
    args: ["-e", "process.exit(1)"],
    cwd: REPO_DIR,
    engine: "codex",
    stdinText: "X".repeat(1024 * 1024),
    timeoutMs: 5000
  });
  assert.equal(epipeRes.code, 1);

  const orphanT0 = Date.now();
  const orphanScript =
    "const { spawn } = require('node:child_process'); " +
    "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 1, 2] }); " +
    "setTimeout(() => {}, 30000);";
  const orphanRes = await spawnJsonlProcess({
    bin: process.execPath,
    args: ["-e", orphanScript],
    cwd: REPO_DIR,
    engine: "codex",
    stdinText: null,
    timeoutMs: 450,
    killGraceMs: 250
  });
  const orphanElapsed = Date.now() - orphanT0;
  assert.equal(orphanRes.timedOut, true);
  assert.ok(orphanElapsed < 3500, `Orphan pipe timeout must converge quickly, took ${orphanElapsed}ms`);

  // B6: Stdio-redirected SIGTERM-ignoring grandchild STILL gets killed via -pid SIGKILL even after leader dies on SIGTERM and pipes close!
  const detachedPidFile = path.join(TMP_BASE, "b6-grand.pid");
  const sigIgnoreScript =
    "const fs = require('node:fs'); const { spawn } = require('node:child_process'); " +
    `const c = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' }); ` +
    `fs.writeFileSync(${JSON.stringify(detachedPidFile)}, String(c.pid)); ` +
    "setInterval(() => {}, 1000);";
  const b6Res = await spawnJsonlProcess({
    bin: process.execPath,
    args: ["-e", sigIgnoreScript],
    cwd: REPO_DIR,
    engine: "codex",
    stdinText: null,
    timeoutMs: 250,
    killGraceMs: 200
  });
  assert.equal(b6Res.timedOut, true);
  const grandPid = Number(fs.readFileSync(detachedPidFile, "utf8").trim());
  assert.ok(grandPid > 0);
  let grandAlive = true;
  try {
    process.kill(grandPid, 0);
  } catch (e) {
    if (e.code === "ESRCH") grandAlive = false;
  }
  assert.equal(grandAlive, false, `Expected -pid SIGKILL to terminate SIGTERM-ignoring grandchild pid=${grandPid}`);

  // B6 normal-exit orphan drain with two descendants (pipe holder dies on SIGTERM + stdio-redirected SIGTERM-ignoring sibling -> sibling dies via SIGKILL before settle)
  const drainT0 = Date.now();
  const drainSibPidFile = path.join(TMP_BASE, "b6-drain-sib.pid");
  const drainScript =
    "const fs = require('node:fs'); const { spawn } = require('node:child_process'); " +
    "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 1, 2] }); " +
    `const sib = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' }); ` +
    `fs.writeFileSync(${JSON.stringify(drainSibPidFile)}, String(sib.pid)); ` +
    "process.exit(0);";
  const drainRes = await spawnJsonlProcess({
    bin: process.execPath,
    args: ["-e", drainScript],
    cwd: REPO_DIR,
    engine: "codex",
    stdinText: null,
    timeoutMs: 30000,
    killGraceMs: 200
  });
  assert.equal(drainRes.code, 0);
  assert.equal(drainRes.timedOut, false);
  assert.ok(Date.now() - drainT0 < 3000, "Normal exit with orphaned pipe-holder must settle within drain grace");
  const sibPid = Number(fs.readFileSync(drainSibPidFile, "utf8").trim());
  let sibAlive = true;
  try {
    process.kill(sibPid, 0);
  } catch (e) {
    if (e.code === "ESRCH") sibAlive = false;
  }
  assert.equal(sibAlive, false, `Expected drain sweep SIGKILL to terminate redirected sibling pid=${sibPid}`);

  // Round 3 B6: Clean exit where leader spawns ONLY stdio:'ignore' SIGTERM-ignoring descendant -> close probes group & kills descendant before resolving!
  const cleanChildPidFile = path.join(TMP_BASE, "b6-clean-ign.pid");
  const cleanIgnScript =
    "const fs = require('node:fs'); const { spawn } = require('node:child_process'); " +
    `const d = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' }); ` +
    `fs.writeFileSync(${JSON.stringify(cleanChildPidFile)}, String(d.pid)); ` +
    "process.exit(0);";
  const cleanSweepRes = await spawnJsonlProcess({
    bin: process.execPath,
    args: ["-e", cleanIgnScript],
    cwd: REPO_DIR,
    engine: "codex",
    stdinText: null,
    timeoutMs: 30000,
    killGraceMs: 200
  });
  assert.equal(cleanSweepRes.code, 0);
  assert.equal(cleanSweepRes.timedOut, false);
  const cleanDescPid = Number(fs.readFileSync(cleanChildPidFile, "utf8").trim());
  let cleanDescAlive = true;
  try {
    process.kill(cleanDescPid, 0);
  } catch (e) {
    if (e.code === "ESRCH") cleanDescAlive = false;
  }
  assert.equal(cleanDescAlive, false, `Clean exit close probe must sweep surviving descendant pid=${cleanDescPid}`);

  // R5 (P2 #5): Long 520B pin preserved intact; pin at #1 survives 205 updates; pinsOnly/seqs/supersedes work cleanly
  const r5BoardId = `pins-r5-${Date.now()}`;
  const longPinTail = "END_INVARIANT_MUST_SURVIVE_520B";
  const longPinText = `${"Constraint detail prefix ".repeat(20)} | ${longPinTail}`;
  assert.ok(Buffer.byteLength(longPinText, "utf8") > 480);
  postBoardMessage(REPO_DIR, r5BoardId, { author: "arch", tag: "[pin]", pinId: "pin-long", text: longPinText });
  postBoardMessage(REPO_DIR, r5BoardId, { author: "arch", tag: "[decision]", pinId: "pin-old", text: "OLD_ALGO_X" });
  for (let i = 0; i < 205; i += 1) {
    postBoardMessage(REPO_DIR, r5BoardId, { author: "worker", tag: "[update]", text: `noise update ${i}` });
  }
  postBoardMessage(REPO_DIR, r5BoardId, {
    author: "arch",
    tag: "[decision]",
    pinId: "pin-new",
    supersedes: "pin-old",
    text: "NEW_ALGO_Y"
  });
  const activePinsR5 = readActiveBoardPins(REPO_DIR, r5BoardId);
  assert.equal(activePinsR5.length, 2);
  assert.ok(activePinsR5.some((p) => p.text.includes(longPinTail)), "Long pin >400B must survive intact in pins index");
  assert.ok(!activePinsR5.some((p) => p.text.includes("OLD_ALGO_X")), "Superseded pin must be inactive");
  const recentPostsR5 = readBoardPosts(REPO_DIR, r5BoardId, { since: 0, limit: 100 });
  const tieredR5 = buildTieredBoardView(recentPostsR5, { pinnedPosts: activePinsR5, boardId: r5BoardId, maxBytes: 2400 });
  assert.ok(tieredR5.posts.some((p) => (p.text || "").includes(longPinTail)), "Tiered view must keep #1 long pin past 205 updates");

  // Also test honest omission reporting when budget cannot fit all pins
  const tightPins = buildTieredBoardView(recentPostsR5, { pinnedPosts: activePinsR5, boardId: r5BoardId, maxBytes: 420 });
  assert.ok(tightPins.omittedPinnedCount > 0 || tightPins.truncatedPinnedSeqs.length > 0);
  assert.ok(tightPins.recallHint.includes("seqs="));
  assert.equal(tightPins.recallHint.includes("pinsOnly=true"), false, "Exact seqs recallHint must not combine pinsOnly=true");
  const seq1Lookup = readBoardPostsBySeqs(REPO_DIR, r5BoardId, [1]);
  assert.equal(seq1Lookup.length, 1);
  assert.ok(seq1Lookup[0].text.includes(longPinTail));

  // B7: Corrupt or out-of-sync .pins.json reconciles automatically from .jsonl on readActiveBoardPins
  const r5PinsFile = resolveBoardPinsFile(REPO_DIR, r5BoardId);
  const r5BoardFile = resolveBoardFile(REPO_DIR, r5BoardId);
  const directResolveRec = {
    seq: 209,
    boardId: r5BoardId,
    timestamp: new Date().toISOString(),
    author: "arch",
    tag: "[resolve]",
    supersedes: "pin-long",
    text: "Resolved long pin"
  };
  fs.appendFileSync(r5BoardFile, `${JSON.stringify(directResolveRec)}\n`, "utf8");
  assert.equal(readActiveBoardPins(REPO_DIR, r5BoardId).length, 1, "Log tail delta must reconcile out-of-date .pins.json");
  fs.writeFileSync(r5PinsFile, "{corrupt json", "utf8");
  assert.equal(readActiveBoardPins(REPO_DIR, r5BoardId).length, 1, "Corrupt .pins.json must rebuild from .jsonl");

  // Round 2 B7: Torn unterminated JSONL fragment repaired on post; ordinary [update] advances watermark without rebuild; same-size replaced log triggers rebuild
  const b7Board = `torn-b7-${Date.now()}`;
  const b7BoardFile = resolveBoardFile(REPO_DIR, b7Board);
  const b7PinsFile = resolveBoardPinsFile(REPO_DIR, b7Board);
  postBoardMessage(REPO_DIR, b7Board, { author: "arch", tag: "[decision]", pinId: "b7-p1", text: "FIRST_PIN" });
  postBoardMessage(REPO_DIR, b7Board, { author: "worker", tag: "[update]", text: "ORDINARY_UPDATE" });
  const pinsMetaAfterUpdate = JSON.parse(fs.readFileSync(b7PinsFile, "utf8"));
  assert.equal(pinsMetaAfterUpdate.logSize, fs.statSync(b7BoardFile).size, "Ordinary [update] must advance .pins.json logSize watermark");
  fs.appendFileSync(b7BoardFile, '{"seq":99,"broken":', "utf8");
  postBoardMessage(REPO_DIR, b7Board, { author: "arch", tag: "[decision]", pinId: "b7-p2", text: "SURVIVING_PIN" });
  const b7Active = readActiveBoardPins(REPO_DIR, b7Board);
  assert.equal(b7Active.length, 2);
  assert.ok(b7Active.some((p) => p.text === "SURVIVING_PIN"), "Torn JSONL tail must be repaired before appending next pin");
  // Replace last byte inside tailHash window preserving exact byte length -> headHash/tailHash catches tampering on read AND update!
  const origBuf = fs.readFileSync(b7BoardFile);
  const sameLenBuf = Buffer.from(origBuf);
  const idxSurv = sameLenBuf.indexOf("SURVIVING_PIN");
  sameLenBuf[idxSurv] = "X".charCodeAt(0);
  fs.writeFileSync(b7BoardFile, sameLenBuf);
  postBoardMessage(REPO_DIR, b7Board, { author: "worker", tag: "[update]", text: "UPDATE_AFTER_MUTATE" });
  assert.ok(readActiveBoardPins(REPO_DIR, b7Board).some((p) => p.text === "XURVIVING_PIN"), "Same-size tail mutation must invalidate cache via tailHash even after [update]");

  // Round 3 B7: Torn fragment > 64 KiB truncates completely back to real preceding newline
  const preOversizedSize = fs.statSync(b7BoardFile).size;
  fs.appendFileSync(b7BoardFile, `{"seq":888,"text":"${"A".repeat(72 * 1024)}"`, "utf8");
  postBoardMessage(REPO_DIR, b7Board, { author: "arch", tag: "[decision]", pinId: "b7-p3", text: "AFTER_BIG_TEAR" });
  const postRepairSize = fs.statSync(b7BoardFile).size;
  assert.ok(postRepairSize < preOversizedSize + 1024, `Oversized >64KiB torn fragment must be truncated completely (size=${postRepairSize})`);
  assert.ok(readActiveBoardPins(REPO_DIR, b7Board).some((p) => p.text === "AFTER_BIG_TEAR"));

  // Round 2 B5: Concurrent maxRounds=1 returns in_progress (never premature escalate_to_user); review artifact write-once throws on overwrite & persists decision; timeoutMs forwarded
  const concGate = `cycle-conc-${Date.now()}`;
  process.env.TRIRELAY_TEST_REVIEW_BLOCKING = "1";
  process.env.TRIRELAY_TEST_DELAY_MS = "800";
  const slowR1 = runReviewGate(REPO_DIR, { gateKey: concGate, engine: "claude", maxRounds: 1 });
  await new Promise((r) => setTimeout(r, 120));
  const secondInFlight = await runReviewGate(REPO_DIR, { gateKey: concGate, engine: "claude", maxRounds: 1 });
  assert.equal(secondInFlight.decision, "in_progress", "Concurrent round 2 during pending round 1 must report in_progress instead of false escalate");
  const firstDone = await slowR1;
  delete process.env.TRIRELAY_TEST_REVIEW_BLOCKING;
  delete process.env.TRIRELAY_TEST_DELAY_MS;
  assert.equal(firstDone.decision, "fix_required");
  assert.equal(inspectReviewArtifact(REPO_DIR, { reviewId: firstDone.reviewId }).decision, "fix_required");
  assert.throws(() => saveReviewArtifact(REPO_DIR, firstDone.reviewId, { overwrite: true }), /already exists/i);

  process.env.TRIRELAY_TEST_DELAY_MS = "1500";
  const gateTimeout = await runReviewGate(REPO_DIR, { gateKey: `gate-to-${Date.now()}`, engine: "claude", timeoutMs: 120 });
  delete process.env.TRIRELAY_TEST_DELAY_MS;
  assert.equal(gateTimeout.decision, "incomplete", "review-gate timeoutMs must propagate to review workers");

  // Round 3 B5: Monotonic attempt seq prevents duplicate round collision when incomplete precedes out-of-order counted completions
  const seqGate = `cycle-seq-${Date.now()}`;
  process.env.TRIRELAY_TEST_CLAUDE_FAIL = "1";
  const attA = await runReviewGate(REPO_DIR, { gateKey: seqGate, engine: "claude", maxRounds: 2 });
  assert.equal(attA.decision, "incomplete");
  delete process.env.TRIRELAY_TEST_CLAUDE_FAIL;
  process.env.TRIRELAY_TEST_REVIEW_BLOCKING = "1";
  process.env.TRIRELAY_TEST_DELAY_MS = "900";
  const attB = runReviewGate(REPO_DIR, { gateKey: seqGate, engine: "claude", maxRounds: 2 });
  await new Promise((r) => setTimeout(r, 120));
  delete process.env.TRIRELAY_TEST_DELAY_MS;
  const attC = await runReviewGate(REPO_DIR, { gateKey: seqGate, engine: "claude", maxRounds: 2 });
  const attBDone = await attB;
  delete process.env.TRIRELAY_TEST_REVIEW_BLOCKING;
  assert.equal(attC.decision, "fix_required");
  assert.equal(attBDone.decision, "fix_required");
  const escSeq = await runReviewGate(REPO_DIR, { gateKey: seqGate, engine: "claude", maxRounds: 2 });
  assert.equal(escSeq.decision, "escalate_to_user");
  assert.equal(escSeq.reviewId, attC.reviewId, "Escalation must cite chronologically newer attempt C instead of slower earlier attempt B");

  // B5: Stale late review-gate completion cannot reopen passed cycle or corrupt newer cycle; incomplete does not consume round
  fs.writeFileSync(path.join(REPO_DIR, "src", "auth.js"), "export function login() { return true; }\n");
  process.env.TRIRELAY_TEST_CLAUDE_FAIL = "1";
  const incGate = `cycle-inc-${Date.now()}`;
  const gInc = await runReviewGate(REPO_DIR, { gateKey: incGate, engine: "claude", maxRounds: 2 });
  assert.equal(gInc.decision, "incomplete");
  delete process.env.TRIRELAY_TEST_CLAUDE_FAIL;
  const gAfterInc = await runReviewGate(REPO_DIR, { gateKey: incGate, engine: "claude", maxRounds: 2 });
  assert.equal(gAfterInc.decision, "pass");
  assert.equal(gAfterInc.round, 1, "Incomplete run must NOT burn round count");

  const raceGate = `cycle-race-${Date.now()}`;
  process.env.TRIRELAY_TEST_REVIEW_BLOCKING = "1";
  process.env.TRIRELAY_TEST_DELAY_MS = "1500";
  const slowC1 = runReviewGate(REPO_DIR, { gateKey: raceGate, engine: "claude", maxRounds: 2 });
  await new Promise((r) => setTimeout(r, 150));
  delete process.env.TRIRELAY_TEST_REVIEW_BLOCKING;
  delete process.env.TRIRELAY_TEST_DELAY_MS;
  // Pass cycle 1 via reset+pass -> moves to passed cycle before slowC1 resolves
  const fastPass = await runReviewGate(REPO_DIR, { gateKey: raceGate, engine: "claude", maxRounds: 2 });
  assert.equal(fastPass.decision, "pass");
  const slowDone = await slowC1;
  assert.equal(slowDone.staleCompletion, true, "Stale completion against closed/passed cycle must be ignored");
  assert.equal(loadReviewGateState(REPO_DIR, raceGate).status, "passed", "Stale writeback must NOT reopen passed cycle");

  // R6 (P2 #6): Review gate opens a fresh cycle after PASS instead of escalating on 3rd approving call
  fs.writeFileSync(path.join(REPO_DIR, "src", "auth.js"), "export function login() { return true; }\n");
  delete process.env.TRIRELAY_TEST_REVIEW_BLOCKING;
  const passGate = `cycle-pass-${Date.now()}`;
  const g1 = await runReviewGate(REPO_DIR, { gateKey: passGate, engine: "claude", maxRounds: 2 });
  const g2 = await runReviewGate(REPO_DIR, { gateKey: passGate, engine: "claude", maxRounds: 2 });
  const g3 = await runReviewGate(REPO_DIR, { gateKey: passGate, engine: "claude", maxRounds: 2 });
  assert.equal(g1.decision, "pass");
  assert.equal(g2.decision, "pass");
  assert.equal(g3.decision, "pass");
  assert.equal(g3.cycleNumber, 3);
  assert.equal(g3.round, 1);

  // R7: Ignored-only worktree deliverable marked cleanly
  fs.writeFileSync(path.join(REPO_DIR, ".gitignore"), "dist-ignored/\n");
  runSync("git", ["add", ".gitignore"], { cwd: REPO_DIR });
  runSync("git", ["commit", "-m", "ignore dist-ignored"], { cwd: REPO_DIR });
  process.env.TRIRELAY_TEST_IGNORED_ONLY = "1";
  const ignRes = await runSingleTask(REPO_DIR, {
    engine: "codex",
    mode: "write",
    workflowId: "wf-ign",
    role: "builder",
    ownedFiles: ["dist-ignored/**"],
    prompt: "Build ignored artifact only"
  });
  delete process.env.TRIRELAY_TEST_IGNORED_ONLY;
  assert.equal(ignRes.ok, true);
  assert.equal(ignRes.deliverableMode, "ignored-only");
  assert.equal(ignRes.ignoredOnlyDeliverables, true);
  assert.equal(ignRes.patchPath, null);
  assert.ok(ignRes.worktreePath && fs.existsSync(ignRes.worktreePath), "Ignored-only deliverable must retain worktree");
  const compactIgn = JSON.parse(
    serializeMcpPayload("relay_run", { ...ignRes, output: "VERBOSE_IGN ".repeat(1200) }, { maxBytes: 8500 }).text
  );
  assert.equal(compactIgn._compacted, true);
  assert.equal(compactIgn.deliverableMode, "ignored-only");
  assert.equal(compactIgn.ignoredOnlyDeliverables, true);
  // Ignored cache files must not cause false ownedFiles scope violation alongside owned tracked changes
  const wtIgnScope = createIsolatedWorktree(REPO_DIR, { id: `wt-ign-scope-${Date.now()}` });
  try {
    fs.writeFileSync(path.join(wtIgnScope.worktreePath, "src", "app.js"), "export const v = 9;\n");
    fs.mkdirSync(path.join(wtIgnScope.worktreePath, "dist-ignored"), { recursive: true });
    fs.writeFileSync(path.join(wtIgnScope.worktreePath, "dist-ignored", "cache.bin"), "cached");
    const capIgnScope = captureWorktreeChanges(REPO_DIR, wtIgnScope.worktreePath, wtIgnScope.worktreeId, wtIgnScope.baseSha);
    assert.equal(capIgnScope.deliverableMode, "patch");
    assert.equal(auditFileScope(capIgnScope.changedFiles, { ownedFiles: ["src/**"], forbiddenFiles: ["docs/handoff.md"] }).length, 0);
    assert.equal(auditFileScope(capIgnScope.allIgnoredFiles, { ownedFiles: [], forbiddenFiles: ["docs/handoff.md"] }).length, 0);
  } finally {
    removeIsolatedWorktree(REPO_DIR, wtIgnScope.worktreePath);
  }
  removeIsolatedWorktree(REPO_DIR, ignRes.worktreePath);

  // Round 2 R7: >50 ignored files with forbidden ignored file at index >=52 MUST still be caught in audit while preview stays capped at 50
  const wtIgn55 = createIsolatedWorktree(REPO_DIR, { id: `wt-ign55-${Date.now()}` });
  try {
    fs.writeFileSync(path.join(wtIgn55.worktreePath, ".gitignore"), "dist-ignored/\nzz-secret.ignored\n");
    fs.mkdirSync(path.join(wtIgn55.worktreePath, "dist-ignored"), { recursive: true });
    for (let i = 0; i < 55; i += 1) {
      fs.writeFileSync(path.join(wtIgn55.worktreePath, "dist-ignored", `f-${String(i).padStart(3, "0")}.bin`), "x");
    }
    fs.writeFileSync(path.join(wtIgn55.worktreePath, "zz-secret.ignored"), "secret");
    const cap55 = captureWorktreeChanges(REPO_DIR, wtIgn55.worktreePath, wtIgn55.worktreeId, wtIgn55.baseSha);
    assert.equal(cap55.ignoredFiles.length, 50);
    assert.ok(cap55.ignoredFilesTotal >= 56);
    const v55 = auditFileScope(cap55.allIgnoredFiles, { ownedFiles: [], forbiddenFiles: ["zz-secret.ignored"] });
    assert.equal(v55.length, 1, "Forbidden ignored path past index 50 must still be caught");
  } finally {
    removeIsolatedWorktree(REPO_DIR, wtIgn55.worktreePath);
  }

  // R3 (P1 #3) over real MCP server: 12 blocking findings (>32 KB) compact to <=8500B with actionable reviewId,
  // blockingCount, blockingPreview, and paginated side-effect-free `inspect` (does NOT bump gate round!).
  process.env.TRIRELAY_TEST_MANY_FINDINGS = "12";
  const child = spawn(process.execPath, [path.join(PACKAGE_ROOT, "bin", "trirelay-mcp.mjs")], {
    cwd: REPO_DIR,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const resMap = new Map();
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let idx = buf.indexOf("\n");
    while (idx !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) {
        const msg = JSON.parse(line);
        if (msg.id !== undefined) resMap.set(msg.id, msg);
      }
      idx = buf.indexOf("\n");
    }
  });
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  const waitForId = async (id, timeoutMs = 15000) => {
    const start = Date.now();
    while (!resMap.has(id)) {
      if (Date.now() - start > timeoutMs) throw new Error(`MCP timeout id=${id}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    return resMap.get(id);
  };
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    await waitForId(1);
    const gateKeyR3 = `r3-gate-${Date.now()}`;
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "relay_review_gate", arguments: { cwd: REPO_DIR, gateKey: gateKeyR3, engine: "claude", maxRounds: 2 } }
    });
    const revCall = await waitForId(2);
    const rawText = revCall.result.content[0].text;
    assert.ok(Buffer.byteLength(rawText, "utf8") <= 8500, "Oversized review gate must obey <=8500B inline cap");
    const parsedRev = JSON.parse(rawText);
    assert.equal(parsedRev._compacted, true);
    assert.ok(parsedRev.reviewId, "Compacted review must preserve reviewId");
    assert.equal(parsedRev.blockingCount, 12);
    assert.ok(
      (Array.isArray(parsedRev.blockingPreview) && parsedRev.blockingPreview.length > 0) ||
        (Array.isArray(parsedRev.blockingFindings) && parsedRev.blockingFindings.length === 12),
      "Compacted review must preserve blockingPreview or full blockingFindings"
    );
    assert.ok(parsedRev._recall.includes(parsedRev.reviewId) && parsedRev._recall.includes("inspect"));

    // Paginate ALL 12 findings via inspect without mutating gate round!
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "relay_review_gate", arguments: { cwd: REPO_DIR, action: "inspect", reviewId: parsedRev.reviewId, offset: 0, limit: 6 } }
    });
    const page1 = JSON.parse((await waitForId(3)).result.content[0].text);
    assert.equal(page1.findings.length, 6);
    assert.equal(page1.hasMore, true);
    assert.equal(page1.round, 1);

    send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "relay_review_gate", arguments: { cwd: REPO_DIR, action: "inspect", reviewId: parsedRev.reviewId, offset: 6, limit: 6 } }
    });
    const page2 = JSON.parse((await waitForId(4)).result.content[0].text);
    assert.equal(page2.findings.length, 6);
    assert.equal(page2.hasMore, false);
    assert.equal(page2.findings[5].id, "F12");

    // Verify 2nd actual gate call is round 2 (NOT round 4 — inspect was side-effect-free!)
    send({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "relay_review_gate", arguments: { cwd: REPO_DIR, gateKey: gateKeyR3, engine: "claude", maxRounds: 2 } }
    });
    const round2 = JSON.parse((await waitForId(5)).result.content[0].text);
    assert.equal(round2.round, 2);

    // B4: 3rd call hits escalate_to_user and even with 12 large remainingBlockingFindings preserves reviewId, blockingCount & blockingPreview!
    send({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "relay_review_gate", arguments: { cwd: REPO_DIR, gateKey: gateKeyR3, engine: "claude", maxRounds: 2 } }
    });
    const escalatedMsg = await waitForId(6);
    const escText = escalatedMsg.result.content[0].text;
    assert.ok(Buffer.byteLength(escText, "utf8") <= 8500, "Compacted escalation must stay <=8500B");
    const escParsed = JSON.parse(escText);
    assert.equal(escParsed.decision, "escalate_to_user");
    assert.equal(escParsed.reviewId, round2.reviewId, "Escalation must preserve last reviewId");
    assert.equal(escParsed.blockingCount, 12);
    assert.ok(
      (Array.isArray(escParsed.blockingPreview) && escParsed.blockingPreview.length > 0) ||
        (Array.isArray(escParsed.remainingBlockingFindings) && escParsed.remainingBlockingFindings.length === 12),
      "Compacted escalation must preserve blockingPreview or remainingBlockingFindings"
    );
    assert.ok(escParsed._recall.includes(round2.reviewId));

    // Also verify tight maxBytes=2200 Pass 3 escalation forces blockingPreview from remainingBlockingFindings
    const escTight = JSON.parse(serializeMcpPayload("relay_review_gate", {
      ok: false,
      reviewId: round2.reviewId,
      decision: "escalate_to_user",
      blockingCount: 12,
      remainingBlockingFindings: Array.from({ length: 12 }, (_, idx) => ({
        id: `F${idx + 1}`,
        severity: "blocking",
        file: `src/f${idx}.js`,
        line_start: 10 + idx,
        title: `Blocker ${idx + 1}`,
        trigger_path: `Path ${idx + 1}`,
        body: "Long narrative ".repeat(50)
      }))
    }, { maxBytes: 2200 }).text);
    assert.equal(escTight.reviewId, round2.reviewId);
    assert.ok(Array.isArray(escTight.blockingPreview) && escTight.blockingPreview.length > 0);

    // Round 2 B4: Background `relay_jobs(result)` wrapper around oversized escalation preserves reviewId, decision, blockingCount, blockingPreview
    const bgEscCompacted = JSON.parse(serializeMcpPayload("relay_jobs", {
      job: {
        id: "job-bg-esc",
        status: "failed",
        result: {
          ok: false,
          reviewId: round2.reviewId,
          decision: "escalate_to_user",
          blockingCount: 12,
          totalFindings: 12,
          remainingBlockingFindings: Array.from({ length: 12 }, (_, idx) => ({
            id: `F${idx + 1}`,
            severity: "blocking",
            file: `src/f${idx}.js`,
            line_start: 10 + idx,
            title: `BgBlocker ${idx + 1}`,
            trigger_path: `Path ${idx + 1}`,
            body: "Detailed background gate escalation body ".repeat(60)
          }))
        }
      },
      logTail: "noise"
    }, { maxBytes: 4000 }).text);
    assert.equal(bgEscCompacted.reviewId, round2.reviewId);
    assert.equal(bgEscCompacted.decision, "escalate_to_user");
    assert.equal(bgEscCompacted.blockingCount, 12);
    assert.ok(Array.isArray(bgEscCompacted.blockingPreview) && bgEscCompacted.blockingPreview.length > 0);

    // Advisory B4: Background relay_jobs(result) with 11 oversized findings at default 8500B cap ALWAYS keeps blockingPreview!
    const bgEsc11Compacted = JSON.parse(serializeMcpPayload("relay_jobs", {
      job: {
        id: "job-bg-esc-11",
        status: "failed",
        result: {
          ok: false,
          reviewId: round2.reviewId,
          decision: "escalate_to_user",
          blockingCount: 11,
          totalFindings: 11,
          remainingBlockingFindings: Array.from({ length: 11 }, (_, idx) => ({
            id: `F${idx + 1}`,
            severity: "blocking",
            file: `src/f${idx}.js`,
            line_start: 10 + idx,
            title: `BgBlocker11 ${idx + 1}`,
            trigger_path: `Path ${idx + 1}`,
            body: "Detailed background gate escalation body ".repeat(25)
          }))
        }
      },
      logTail: "noise"
    }, { maxBytes: 8500 }).text);
    assert.equal(bgEsc11Compacted.reviewId, round2.reviewId);
    assert.equal(bgEsc11Compacted.blockingCount, 11);
    assert.ok(Array.isArray(bgEsc11Compacted.blockingPreview) && bgEsc11Compacted.blockingPreview.length > 0);

    // Check full board view bypasses 100-post window
    send({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "relay_board", arguments: { cwd: REPO_DIR, boardId: r5BoardId, action: "read", view: "full" } }
    });
    const fullBoard = JSON.parse((await waitForId(7)).result.content[0].text);
    assert.ok(fullBoard.posts.length >= 208, `Expected >=208 posts on view='full', got ${fullBoard.posts.length}`);
  } finally {
    delete process.env.TRIRELAY_TEST_MANY_FINDINGS;
    child.stdin.end();
    child.kill("SIGTERM");
  }

  // Round 2 B6: MCP SIGTERM shutdown awaits cancelAllActiveInProcessJobs (kills SIGTERM-ignoring worker grandchildren & sets job status="cancelled")
  const mcpKillPidFile = path.join(TMP_BASE, "mcp-kill-sib.pid");
  const mcpFakeClaude = path.join(TMP_BASE, "fake-claude-ign");
  fs.writeFileSync(
    mcpFakeClaude,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      `const c = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });`,
      `fs.writeFileSync(${JSON.stringify(mcpKillPidFile)}, String(c.pid));`,
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);"
    ].join("\n"),
    { mode: 0o755 }
  );
  const prevClaudeBin = process.env.TRIRELAY_CLAUDE_BIN;
  process.env.TRIRELAY_CLAUDE_BIN = mcpFakeClaude;
  const mcpShut = spawn(process.execPath, [path.join(PACKAGE_ROOT, "bin", "trirelay-mcp.mjs")], {
    cwd: REPO_DIR,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let shutBuf = "";
  const shutMap = new Map();
  mcpShut.stdout.setEncoding("utf8");
  mcpShut.stdout.on("data", (c) => {
    shutBuf += c;
    let idx = shutBuf.indexOf("\n");
    while (idx !== -1) {
      const l = shutBuf.slice(0, idx).trim();
      shutBuf = shutBuf.slice(idx + 1);
      if (l) {
        const m = JSON.parse(l);
        if (m.id !== undefined) shutMap.set(m.id, m);
      }
      idx = shutBuf.indexOf("\n");
    }
  });
  const waitShut = async (id) => {
    const t0 = Date.now();
    while (!shutMap.has(id)) {
      if (Date.now() - t0 > 10000) throw new Error(`MCP shutdown test timeout id=${id}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    return shutMap.get(id);
  };
  let bgJobId = null;
  try {
    mcpShut.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })}\n`);
    await waitShut(1);
    mcpShut.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "relay_run", arguments: { cwd: REPO_DIR, host: "agy", engine: "claude", background: true, prompt: "hang forever" } }
    })}\n`);
    bgJobId = JSON.parse((await waitShut(2)).result.content[0].text).jobId;
    const waitPidT0 = Date.now();
    while (!fs.existsSync(mcpKillPidFile) && Date.now() - waitPidT0 < 5000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(fs.existsSync(mcpKillPidFile), "Background MCP worker must have spawned grandchild");
    const mcpExitPromise = new Promise((r) => mcpShut.once("exit", (code) => r(code)));
    mcpShut.kill("SIGTERM");
    await mcpExitPromise;
    const mcpSibPid = Number(fs.readFileSync(mcpKillPidFile, "utf8").trim());
    let mcpSibAlive = true;
    try {
      process.kill(mcpSibPid, 0);
    } catch (e) {
      if (e.code === "ESRCH") mcpSibAlive = false;
    }
    assert.equal(mcpSibAlive, false, `MCP SIGTERM shutdown must SIGKILL grandchild pid=${mcpSibPid} before exiting`);
    assert.equal(readJobDetail(REPO_DIR, bgJobId, { exact: true })?.status, "cancelled");
  } finally {
    if (prevClaudeBin) process.env.TRIRELAY_CLAUDE_BIN = prevClaudeBin;
    try { mcpShut.kill("SIGKILL"); } catch {}
  }

  // R8: Clean process exit just before timeoutMs with surviving descendant must NOT flip timedOut=true during sweep
  {
    const sweepChildScript = path.join(TMP_BASE, "clean-exit-with-descendant.cjs");
    const sweepDescPidFile = path.join(TMP_BASE, "clean-exit-desc.pid");
    fs.writeFileSync(
      sweepChildScript,
      [
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        "const desc = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: ['ignore', 1, 2] });",
        `fs.writeFileSync(${JSON.stringify(sweepDescPidFile)}, String(desc.pid));`,
        "process.exit(0);"
      ].join("\n"),
      { mode: 0o644 }
    );
    const sweepRes = await spawnJsonlProcess({
      bin: process.execPath,
      args: [sweepChildScript],
      cwd: REPO_DIR,
      engine: "codex",
      timeoutMs: 450,
      killGraceMs: 600
    });
    assert.equal(sweepRes.code, 0);
    assert.equal(sweepRes.timedOut, false, "Clean exit before timeoutMs must stay timedOut=false across descendant group sweep");
    const descPid = Number(fs.readFileSync(sweepDescPidFile, "utf8").trim());
    let descAlive = true;
    try {
      process.kill(descPid, 0);
    } catch (e) {
      if (e.code === "ESRCH") descAlive = false;
    }
    assert.equal(descAlive, false, "Surviving descendant must be killed by group sweep");
  }

  // R9: repairBoardTailLocked via postBoardMessage must NOT truncate a valid final JSONL record missing '\\n' if appendFileSync fails
  {
    const r9BoardId = `r9-repair-preserve-${Date.now()}`;
    postBoardMessage(REPO_DIR, r9BoardId, { author: "a", tag: "[pin]", text: "first valid record" });
    const r9BoardFile = resolveBoardFile(REPO_DIR, r9BoardId);
    const secondLine = JSON.stringify({
      seq: 2,
      ts: new Date().toISOString(),
      author: "b",
      tag: "[note]",
      text: "second valid record without trailing newline"
    });
    fs.appendFileSync(r9BoardFile, secondLine, "utf8");
    const expectedBeforeAppendFail = fs.readFileSync(r9BoardFile, "utf8");
    assert.equal(expectedBeforeAppendFail.endsWith("\n"), false);

    const origAppendFileSync = fs.appendFileSync;
    fs.appendFileSync = (targetPath, ...rest) => {
      if (path.resolve(String(targetPath)) === path.resolve(r9BoardFile)) {
        const err = new Error("Simulated ENOSPC while normalizing board newline");
        err.code = "ENOSPC";
        throw err;
      }
      return origAppendFileSync.call(fs, targetPath, ...rest);
    };
    try {
      assert.throws(
        () => postBoardMessage(REPO_DIR, r9BoardId, { author: "c", tag: "[note]", text: "third record" }),
        (err) => err?.code === "ENOSPC"
      );
      assert.equal(
        fs.readFileSync(r9BoardFile, "utf8"),
        expectedBeforeAppendFail,
        "appendFileSync failure must NOT fall through to fs.truncateSync and destroy the valid record"
      );
    } finally {
      fs.appendFileSync = origAppendFileSync;
    }
    // Recovery succeeds cleanly once disk write works again and both original records remain intact
    postBoardMessage(REPO_DIR, r9BoardId, { author: "c", tag: "[note]", text: "third record" });
    const recoveredPosts = readBoardPosts(REPO_DIR, r9BoardId);
    assert.equal(recoveredPosts.length, 3);
    assert.equal(recoveredPosts[1].text, "second valid record without trailing newline");
  }

  // R10: boost, swarm, and teamwork pre-resolve routes before spawning earlier workers when another item fails validation
  {
    const beforeBoostLines = fs.existsSync(RECORD_FILE) ? fs.readFileSync(RECORD_FILE, "utf8").split("\n").filter(Boolean).length : 0;
    await assert.rejects(
      () =>
        runOrchestration(REPO_DIR, {
          pattern: "boost",
          host: "agy",
          prompt: "Check rollback on bad spec",
          models: ["claude:haiku", "bogusengine:model"]
        }),
      /Unsupported engine/i
    );
    await assert.rejects(
      () =>
        runOrchestration(REPO_DIR, {
          pattern: "swarm",
          host: "agy",
          workers: [
            { name: "ok-worker", engine: "claude", model: "haiku", mode: "readonly", prompt: "say ok" },
            { name: "bad-worker", spec: "bogusengine:model", mode: "readonly", prompt: "fail route" }
          ]
        }),
      /Unsupported engine/i
    );
    await assert.rejects(
      () =>
        runOrchestration(REPO_DIR, {
          pattern: "teamwork",
          host: "agy",
          tasks: [
            { role: "ok-task", engine: "claude", model: "haiku", mode: "readonly", prompt: "say ok" },
            { role: "bad-task", spec: "bogusengine:model", mode: "readonly", prompt: "fail route" }
          ]
        }),
      /Unsupported engine/i
    );
    const afterFanoutLines = fs.existsSync(RECORD_FILE) ? fs.readFileSync(RECORD_FILE, "utf8").split("\n").filter(Boolean).length : 0;
    assert.equal(afterFanoutLines, beforeBoostLines, "Invalid sibling route must fail before spawning earlier fan-out workers");
  }

  // R11: Review-gate older approval A finishing AFTER newer blocking review B cannot close cycle as passed
  {
    const r11Gate = `r11-order-${Date.now()}`;
    delete process.env.TRIRELAY_TEST_REVIEW_BLOCKING;
    process.env.TRIRELAY_TEST_DELAY_MS = "900";
    const reqA = runReviewGate(REPO_DIR, { gateKey: r11Gate, engine: "claude", maxRounds: 2 });
    await new Promise((r) => setTimeout(r, 120));
    delete process.env.TRIRELAY_TEST_DELAY_MS;
    process.env.TRIRELAY_TEST_REVIEW_BLOCKING = "1";
    let resB;
    let resA;
    try {
      resB = await runReviewGate(REPO_DIR, { gateKey: r11Gate, engine: "claude", maxRounds: 2 });
      resA = await reqA;
    } finally {
      delete process.env.TRIRELAY_TEST_REVIEW_BLOCKING;
      delete process.env.TRIRELAY_TEST_DELAY_MS;
    }
    assert.equal(resB.decision, "fix_required");
    assert.equal(resA.staleCompletion, true, "Older approval completing after newer blocking review must be marked stale");
    assert.equal(resA.ok, false);
    const gateAfterR11 = loadReviewGateState(REPO_DIR, r11Gate);
    assert.equal(gateAfterR11.status, "open", "Older approval must NOT close cycle as passed");
    assert.equal(gateAfterR11.cycleId, resB.cycleId);
  }

  // R12: Legacy v1.0 write session without hadWorktree reuses bound managed worktree & fails closed if missing
  {
    const wtLegV10 = createIsolatedWorktree(REPO_DIR, { id: `wt-v10-${Date.now()}` });
    try {
      fs.writeFileSync(path.join(wtLegV10.worktreePath, "src", "legacy-keep.js"), "export const keep = true;\n");
      const ledgerPath = sessionLedgerPath(REPO_DIR);
      const ledgerV10 = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
      delete ledgerV10.bySession["codex::sess-v10-wt"];
      delete ledgerV10.bySession["codex::sess-v10-gone"];
      ledgerV10.entries["wf-v10::writer::codex"] = {
        workflowId: "wf-v10",
        role: "writer",
        engine: "codex",
        sessionId: "sess-v10-wt",
        sessionCwd: wtLegV10.worktreePath,
        updatedAt: "2025-12-01T00:00:00.000Z"
      };
      ledgerV10.entries["wf-v10-gone::writer::codex"] = {
        workflowId: "wf-v10-gone",
        role: "writer",
        engine: "codex",
        sessionId: "sess-v10-gone",
        sessionCwd: REPO_DIR,
        updatedAt: "2025-12-01T00:00:00.000Z"
      };
      writeJsonAtomic(ledgerPath, ledgerV10);

      // Readonly touch must NOT overwrite legacy undefined hadWorktree -> false
      const roTouch = await runSingleTask(REPO_DIR, {
        workflowId: "wf-v10",
        role: "reviewer",
        engine: "codex",
        mode: "readonly",
        resumeSessionId: "sess-v10-wt",
        prompt: "inspect v1.0 session"
      });
      assert.equal(roTouch.ok, true);

      const resumedV10 = await runSingleTask(REPO_DIR, {
        workflowId: "wf-v10",
        role: "writer",
        engine: "codex",
        mode: "write",
        resumeRole: true,
        prompt: "continue in v1.0 worktree"
      });
      assert.equal(resumedV10.ok, true);
      assert.equal(resumedV10.worktreePath, wtLegV10.worktreePath, "Must reuse legacy v1.0 managed worktree");
      assert.equal(fs.existsSync(path.join(resumedV10.worktreePath, "src", "legacy-keep.js")), true);

      await assert.rejects(
        () =>
          runSingleTask(REPO_DIR, {
            workflowId: "wf-v10-gone",
            role: "writer",
            engine: "codex",
            mode: "write",
            resumeRole: true,
            prompt: "must fail closed without silent blank checkout"
          }),
        /Cannot resume write session/i
      );
    } finally {
      removeIsolatedWorktree(REPO_DIR, wtLegV10.worktreePath);
    }
  }

  // R13: Literal backslash in POSIX filename must NOT match directory ownedFiles rule
  if (process.platform !== "win32") {
    const slashViolations = auditFileScope(["src\\pwned.js"], { ownedFiles: ["src/**"] });
    assert.equal(slashViolations.length, 1, "Literal backslash filename must be rejected by POSIX src/** rule");
  }

  // R14: Synchronous callback throw inside spawnJsonlProcess rejects cleanly and terminates process group
  {
    const throwScript = path.join(TMP_BASE, "callback-throw-child.cjs");
    const throwPidFile = path.join(TMP_BASE, "callback-throw-desc.pid");
    fs.writeFileSync(
      throwScript,
      [
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        "const d = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: ['ignore', 1, 2] });",
        `fs.writeFileSync(${JSON.stringify(throwPidFile)}, String(d.pid));`,
        "console.log('TRIGGER_LINE');",
        "setInterval(() => {}, 1000);"
      ].join("\n"),
      { mode: 0o644 }
    );
    await assert.rejects(
      () =>
        spawnJsonlProcess({
          bin: process.execPath,
          args: [throwScript],
          cwd: REPO_DIR,
          engine: "codex",
          timeoutMs: 5000,
          killGraceMs: 250,
          onLine: () => {
            throw new Error("Simulated ENOSPC progress failure");
          }
        }),
      /Simulated ENOSPC progress failure/
    );
    const descPid = Number(fs.readFileSync(throwPidFile, "utf8").trim());
    let descAlive = true;
    try {
      process.kill(descPid, 0);
    } catch (e) {
      if (e.code === "ESRCH") descAlive = false;
    }
    assert.equal(descAlive, false, "Descendant group must be killed when onLine throws");
  }

  // R15: teamwork must fail when cross-verifier returns verdict='approve' with a blocking finding
  {
    const fakeApproveWithBlocker = path.join(TMP_BASE, "fake-claude-approve-blocker");
    fs.writeFileSync(
      fakeApproveWithBlocker,
      [
        "#!/usr/bin/env node",
        "const res = {",
        "  verdict: 'approve',",
        "  summary: 'Contradictory payload',",
        "  findings: [{ id: 'B1', severity: 'blocking', file: 'src/a.js', line_start: 1, title: 'Hidden blocker', trigger_path: 'call()', body: 'bad' }],",
        "  next_steps: []",
        "};",
        "console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: 's-team-block', result: JSON.stringify(res), structured_output: res }));"
      ].join("\n"),
      { mode: 0o755 }
    );
    const prevClaude = process.env.TRIRELAY_CLAUDE_BIN;
    try {
      const teamRes = await (async () => {
        // Author on codex, explicitly assign claude approve-with-blocker verifier
        process.env.TRIRELAY_CLAUDE_BIN = fakeApproveWithBlocker;
        return runOrchestration(REPO_DIR, {
          pattern: "teamwork",
          host: "agy",
          verifierSpec: "claude:haiku",
          tasks: [{ role: "impl", engine: "codex", mode: "readonly", prompt: "say ok" }]
        });
      })();
      assert.equal(teamRes.ok, false, "Teamwork must reject approve verdict containing blocking finding");
    } finally {
      if (prevClaude) process.env.TRIRELAY_CLAUDE_BIN = prevClaude;
      else delete process.env.TRIRELAY_CLAUDE_BIN;
    }
  }

  // R16: swarm and teamwork reject fan-out profile ('boost-trio') BEFORE dispatching earlier sibling workers
  {
    const beforeR16Lines = fs.existsSync(RECORD_FILE) ? fs.readFileSync(RECORD_FILE, "utf8").split("\n").filter(Boolean).length : 0;
    await assert.rejects(
      () =>
        runOrchestration(REPO_DIR, {
          pattern: "swarm",
          host: "agy",
          workers: [
            { name: "ok-worker", engine: "claude", model: "haiku", mode: "readonly", prompt: "say ok" },
            { name: "bad-profile", profile: "boost-trio", mode: "readonly", prompt: "fail preflight" }
          ]
        }),
      /fan-out profile/i
    );
    await assert.rejects(
      () =>
        runOrchestration(REPO_DIR, {
          pattern: "teamwork",
          host: "agy",
          tasks: [
            { role: "ok-task", engine: "claude", model: "haiku", mode: "readonly", prompt: "say ok" },
            { role: "bad-profile", profile: "boost-trio", mode: "readonly", prompt: "fail preflight" }
          ]
        }),
      /fan-out profile/i
    );
    const afterR16Lines = fs.existsSync(RECORD_FILE) ? fs.readFileSync(RECORD_FILE, "utf8").split("\n").filter(Boolean).length : 0;
    assert.equal(afterR16Lines, beforeR16Lines, "Fan-out profile sibling must reject before starting earlier workers");
  }

  // R17-R19 over MCP launched in NON_GIT_DIR targeting REPO_DIR:
  // R17: relay_jobs(wait, waitTimeoutMs=90000) exits fast on stdin EOF after job finishes
  // R18: compacted relay_review & inspect include cwd=REPO_DIR in _recall and nextRecall
  // R19: relay_board seqs precedes pinsOnly and recallHint omits pinsOnly=true
  {
    const mcpR17 = spawn(process.execPath, [path.join(PACKAGE_ROOT, "bin", "trirelay-mcp.mjs")], {
      cwd: NON_GIT_DIR,
      env: { ...process.env, TRIRELAY_TEST_MANY_FINDINGS: "12" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let rBuf = "";
    const rMap = new Map();
    mcpR17.stdout.setEncoding("utf8");
    mcpR17.stdout.on("data", (chunk) => {
      rBuf += chunk;
      let idx = rBuf.indexOf("\n");
      while (idx !== -1) {
        const line = rBuf.slice(0, idx).trim();
        rBuf = rBuf.slice(idx + 1);
        if (line) {
          const msg = JSON.parse(line);
          if (msg.id !== undefined) rMap.set(msg.id, msg);
        }
        idx = rBuf.indexOf("\n");
      }
    });
    const sendR = (m) => mcpR17.stdin.write(`${JSON.stringify(m)}\n`);
    const waitR = async (id, timeoutMs = 15000) => {
      const t0 = Date.now();
      while (!rMap.has(id)) {
        if (Date.now() - t0 > timeoutMs) throw new Error(`MCP R17-19 timeout id=${id}`);
        await new Promise((r) => setTimeout(r, 20));
      }
      return rMap.get(id);
    };

    try {
      sendR({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
      await waitR(1);

      // R18: cross-workspace compacted review _recall + nextRecall preserve cwd
      sendR({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "relay_review", arguments: { cwd: REPO_DIR, engine: "claude" } }
      });
      const revAlt = JSON.parse((await waitR(2)).result.content[0].text);
      assert.equal(revAlt._compacted, true);
      assert.ok(revAlt._recall.includes(REPO_DIR), `Expected _recall to preserve alternate cwd: ${revAlt._recall}`);
      sendR({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "relay_review", arguments: { cwd: REPO_DIR, action: "inspect", reviewId: revAlt.reviewId, offset: 0, limit: 6 } }
      });
      const inspAlt = JSON.parse((await waitR(3)).result.content[0].text);
      assert.equal(inspAlt.findings.length, 6);
      assert.ok(inspAlt.nextRecall.includes(REPO_DIR), `Expected nextRecall to preserve alternate cwd: ${inspAlt.nextRecall}`);

      // R19: board seqs takes precedence over pinsOnly even after pin retires
      const r19Board = `r19-retired-seq-${Date.now()}`;
      const p1 = postBoardMessage(REPO_DIR, r19Board, { author: "a", tag: "[pin]", pinId: "p-retire", text: "PIN_TO_RETIRE" });
      postBoardMessage(REPO_DIR, r19Board, { author: "a", tag: "[resolve]", supersedes: "p-retire", text: "Retired pin" });
      sendR({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "relay_board", arguments: { cwd: REPO_DIR, boardId: r19Board, action: "read", pinsOnly: true, seqs: [p1.seq] } }
      });
      const seqRead = JSON.parse((await waitR(4)).result.content[0].text);
      assert.equal(seqRead.view, "seqs");
      assert.equal(seqRead.posts.length, 1);
      assert.equal(seqRead.posts[0].seq, p1.seq);

      // R17: fast background job + waitTimeoutMs=90000 must NOT hold MCP alive after stdin EOF
      sendR({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "relay_run", arguments: { cwd: REPO_DIR, host: "agy", engine: "claude", background: true, prompt: "fast ok" } }
      });
      const bgStart = JSON.parse((await waitR(5)).result.content[0].text);
      sendR({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "relay_jobs", arguments: { cwd: REPO_DIR, action: "wait", jobId: bgStart.jobId, waitTimeoutMs: 90000 } }
      });
      await waitR(6);
      const exitWait = new Promise((resolve) => mcpR17.once("exit", (code) => resolve(code)));
      const eofStart = Date.now();
      mcpR17.stdin.end();
      await Promise.race([
        exitWait,
        new Promise((_, rej) => setTimeout(() => rej(new Error("MCP hung on stdin EOF due to leaked waitTimeoutMs timer")), 3000))
      ]);
      assert.ok(Date.now() - eofStart < 3000, "MCP must exit promptly after EOF without waiting 90s");
    } finally {
      try { mcpR17.kill("SIGKILL"); } catch {}
    }
  }

  // R20: Newer readonly canonical bySession entry (hadWorktree=false) must NOT shadow legacy v1.0 write entry in entries[]
  {
    const ledgerPath = sessionLedgerPath(REPO_DIR);
    const ledgerR20 = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    ledgerR20.entries["wf-r20::writer::codex"] = {
      workflowId: "wf-r20",
      role: "writer",
      engine: "codex",
      sessionId: "sess-r20-shadow",
      sessionCwd: path.join(TMP_BASE, "deleted-legacy-wt"),
      updatedAt: "2025-12-01T00:00:00.000Z"
    };
    ledgerR20.entries["wf-r20::reader::codex"] = {
      workflowId: "wf-r20",
      role: "reader",
      engine: "codex",
      sessionId: "sess-r20-shadow",
      sessionCwd: REPO_DIR,
      hadWorktree: false,
      updatedAt: "2025-12-02T00:00:00.000Z"
    };
    ledgerR20.bySession["codex::sess-r20-shadow"] = ledgerR20.entries["wf-r20::reader::codex"];
    writeJsonAtomic(ledgerPath, ledgerR20);

    const resolvedR20 = lookupSessionById(REPO_DIR, { engine: "codex", sessionId: "sess-r20-shadow" });
    assert.equal(resolvedR20?.hadWorktree, undefined, "lookupSessionById must prefer v1.0 unknown write entry over readonly hadWorktree=false");
    await assert.rejects(
      () =>
        runSingleTask(REPO_DIR, {
          workflowId: "wf-r20",
          role: "writer",
          engine: "codex",
          mode: "write",
          resumeRole: true,
          prompt: "must fail closed when legacy worktree missing despite newer readonly bySession"
        }),
      /Cannot resume write session/i
    );
  }

  // R21: Legacy reused worktree without baseSha diffs against worktree's own HEAD instead of moved workspace HEAD
  {
    const r21Repo = path.join(TMP_BASE, "r21-repo");
    fs.mkdirSync(path.join(r21Repo, "src"), { recursive: true });
    const gitR21 = (args) => {
      const r = runSync("git", args, { cwd: r21Repo });
      assert.equal(r.status, 0, `git ${args.join(" ")} failed in r21Repo: ${r.stderr}`);
      return r;
    };
    gitR21(["init"]);
    gitR21(["config", "user.email", "test@trirelay.invalid"]);
    gitR21(["config", "user.name", "Trirelay Test"]);
    fs.writeFileSync(path.join(r21Repo, "src", "base.js"), "export const a = 1;\n");
    gitR21(["add", "."]);
    gitR21(["commit", "-m", "c1"]);
    const c1Sha = gitR21(["rev-parse", "HEAD"]).stdout.trim();

    const wtR21 = createIsolatedWorktree(r21Repo, { id: `wt-r21-${Date.now()}` });
    try {
      // Advance main repo HEAD to C2 while legacy worktree stays checked out at C1
      fs.writeFileSync(path.join(r21Repo, "src", "c2-only.js"), "export const c2 = 2;\n");
      gitR21(["add", "."]);
      gitR21(["commit", "-m", "c2"]);

      fs.writeFileSync(path.join(wtR21.worktreePath, "src", "base.js"), "export const a = 99;\n");
      const ledgerR21Path = sessionLedgerPath(r21Repo);
      writeJsonAtomic(ledgerR21Path, {
        entries: {
          "wf-r21::writer::codex": {
            workflowId: "wf-r21",
            role: "writer",
            engine: "codex",
            sessionId: "sess-r21",
            sessionCwd: wtR21.worktreePath,
            updatedAt: "2025-12-01T00:00:00.000Z"
          }
        },
        bySession: {},
        leases: {}
      });

      const resR21 = await runSingleTask(r21Repo, {
        workflowId: "wf-r21",
        role: "writer",
        engine: "codex",
        mode: "write",
        resumeRole: true,
        prompt: "resume legacy worktree after main advanced"
      });
      assert.equal(resR21.ok, true);
      assert.equal(resR21.baseSha, c1Sha, "Reused legacy worktree without baseSha must use its own HEAD");
      assert.equal(resR21.changedFiles.includes("src/c2-only.js"), false, "Must NOT emit reverse diff from C2");
    } finally {
      removeIsolatedWorktree(r21Repo, wtR21.worktreePath);
    }
  }

  // R22: Default 8500B MCP budget must NOT truncate _recall when workspace cwd path is long
  {
    const longCwd = `/tmp/${"workspace-segment-".repeat(8)}project`;
    const bigReview = {
      ok: false,
      reviewId: "rev-long-cwd-test",
      verdict: "needs-attention",
      blockingCount: 12,
      totalFindings: 12,
      findings: Array.from({ length: 12 }, (_, idx) => ({
        id: `F${idx + 1}`,
        severity: "blocking",
        file: `src/mod-${idx}.js`,
        line_start: idx + 1,
        title: `Blocker ${idx + 1}`,
        trigger_path: `step(${idx})`,
        body: "Narrative ".repeat(120)
      }))
    };
    const compactedLongCwd = JSON.parse(serializeMcpPayload("relay_review", bigReview, { maxBytes: 8500, cwd: longCwd }).text);
    assert.equal(compactedLongCwd._compacted, true);
    assert.equal(compactedLongCwd._recall.includes("[TRUNCATED"), false, "_recall must not truncate at default 8500B budget");
    assert.ok(compactedLongCwd._recall.includes(longCwd), "_recall must retain full long cwd");
    assert.ok(compactedLongCwd._recall.includes("limit=10"), "_recall must retain full inspect arguments");
  }

  // R23: boost rejects fan-out profile triggered by phase1Prompt heuristic on empty spec BEFORE dispatching sibling 0
  {
    const r23ConfigDir = path.join(TMP_BASE, "r23-config");
    fs.mkdirSync(r23ConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(r23ConfigDir, "routing.json"),
      JSON.stringify({ profiles: { ultra: { fanout: ["claude:haiku", "codex@high"] } } })
    );
    const prevCfgDir = process.env.TRIRELAY_CONFIG_DIR;
    const beforeR23Lines = fs.existsSync(RECORD_FILE) ? fs.readFileSync(RECORD_FILE, "utf8").split("\n").filter(Boolean).length : 0;
    process.env.TRIRELAY_CONFIG_DIR = r23ConfigDir;
    try {
      await assert.rejects(
        () =>
          runOrchestration(REPO_DIR, {
            pattern: "boost",
            host: "agy",
            prompt: "Analyze consistency risk",
            models: ["claude:haiku", ""]
          }),
        /fan-out profile/i
      );
    } finally {
      if (prevCfgDir !== undefined) process.env.TRIRELAY_CONFIG_DIR = prevCfgDir;
      else delete process.env.TRIRELAY_CONFIG_DIR;
    }
    const afterR23Lines = fs.existsSync(RECORD_FILE) ? fs.readFileSync(RECORD_FILE, "utf8").split("\n").filter(Boolean).length : 0;
    assert.equal(afterR23Lines, beforeR23Lines, "Prompt-routed fanout profile on empty spec must reject before starting sibling 0");
  }

  console.log("[PASS] Release-gate state-consistency suite (R1 bind/replay/fail-closed, R2 inheritance, R3 review inspect, R4 EPIPE+orphan timeout, R5 active pins, R6 cycle reset, R7 ignored deliverables, R8-R23 audit hardening)");
}

async function main() {
  try {
    initTempGitRepo();
    testJsonManifests();
    testEnvScrubAndResolver();
    testCompactAndTieredBoard();
    testCodexMcpIsolation();
    await testAllThreeDriversAndGuardrails();
    testHostSymmetryRouting();
    await testSecurityAndValidation();
    testPrefixCacheHandoffAndBoardDigest();
    testWorktreeCommitsSpacesScopeAndApply();
    await testConcurrentBoardLocking();
    await testSealedDesignCopyReviewAndGate();
    await testSwarmDagValidation();
    testSessionHookSnapshots();
    await testAsyncMcpServer();
    testInstallerDryRun();
    await testReleaseGateStateConsistencySuite();
    console.log("ALL TRIRELAY TESTS PASSED");
  } finally {
    fs.rmSync(TMP_BASE, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exitCode = 1;
});
