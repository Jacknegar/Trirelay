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
  assertRecursionSafe,
  runCopyReview,
  runDualDesign,
  runDualReview,
  runOrchestration,
  runReviewGate,
  runSingleTask,
  validateCallerArgs
} = await import("../core/orchestrator.mjs");
const { resolveRoute } = await import("../core/router.mjs");
const { createHandoffPacket, loadHandoffPacket, renderHandoffMarkdown } = await import("../core/handoff.mjs");
const { assertPathInside, postBoardMessage, readBoardPosts } = await import("../core/state.mjs");
const {
  applyWorktreePatch,
  auditFileScope,
  captureWorktreeChanges,
  createIsolatedWorktree,
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
    console.log("ALL TRIRELAY TESTS PASSED");
  } finally {
    fs.rmSync(TMP_BASE, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exitCode = 1;
});
