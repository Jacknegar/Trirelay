import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { buildTieredBoardView, resolveMcpMaxBytes, serializeMcpPayload } from "../core/compact.mjs";
import { checkAgyHealth } from "../core/drivers/agy.mjs";
import { checkClaudeHealth } from "../core/drivers/claude.mjs";
import { checkCodexHealth } from "../core/drivers/codex.mjs";
import {
  canonicalizePath,
  resolveHost,
  resolveWorkspaceRoot
} from "../core/env.mjs";
import { createHandoffPacket, listWorkspaceClaudeSessions, loadHandoffPacket } from "../core/handoff.mjs";
import {
  cancelAllActiveInProcessJobs,
  handleJobControl,
  launchBackgroundJob,
  registerActiveAbortController
} from "../core/jobs.mjs";
import {
  assertRecursionSafe,
  inspectReviewArtifact,
  runCopyReview,
  runDualDesign,
  runDualReview,
  runOrchestration,
  runReviewGate,
  runSingleTask,
  validateCallerArgs
} from "../core/orchestrator.mjs";
import { getFullModelCatalog, resolveRoute } from "../core/router.mjs";
import {
  loadHostSession,
  postBoardMessage,
  readActiveBoardPins,
  readBoardPosts,
  readBoardPostsBySeqs,
  readJsonSafe
} from "../core/state.mjs";
import { applyJobPatch } from "../core/worktree.mjs";

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PKG = readJsonSafe(path.join(PACKAGE_ROOT, "package.json"), { version: "1.0.0" });
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05"];
let serverShuttingDown = false;

const TOOLS = [
  {
    name: "relay_setup",
    description:
      "Check health, binary paths, and auth readiness for all three engines (Antigravity `agy`, Claude Code `claude`, OpenAI Codex `codex`) and inspect active host context.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cwd: { type: "string" },
        host: { type: "string", enum: ["agy", "claude", "codex", "cli"] }
      }
    }
  },
  {
    name: "relay_models",
    description:
      "List live discovered models, aliases, supported efforts, and host-aware role profiles across agy, claude, and codex.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        includeHidden: { type: "boolean" },
        includeAgyProbe: { type: "boolean" }
      }
    }
  },
  {
    name: "relay_route",
    description:
      "Resolve engine/model routing for a role profile (advisor, implementer, reviewer, architect, coder, coder-max, ultra, docs, fast, swarm-worker, dual-audit, boost-trio, auto) or explicit spec while excluding the current host by default.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        host: { type: "string", enum: ["agy", "claude", "codex", "cli"] },
        excludeHost: { type: "boolean", default: true },
        profile: { type: "string" },
        spec: { type: "string" },
        engine: { type: "string", enum: ["agy", "claude", "codex"] },
        model: { type: "string" },
        effort: { type: "string" },
        prompt: { type: "string" },
        mode: { type: "string", enum: ["readonly", "write"] },
        authorEngine: { type: "string", enum: ["agy", "claude", "codex"] },
        strict: { type: "boolean" }
      }
    }
  },
  {
    name: "relay_run",
    description:
      "Execute a scoped task on agy, claude, or codex. Supports background=true (recommended for long tasks to avoid MCP RPC timeouts) and mandatory git worktree isolation for mode='write'.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["prompt"],
      properties: {
        cwd: { type: "string" },
        host: { type: "string", enum: ["agy", "claude", "codex", "cli"] },
        background: { type: "boolean", default: false },
        prompt: { type: "string" },
        role: { type: "string" },
        workflowId: { type: "string" },
        boardId: { type: "string" },
        profile: { type: "string" },
        spec: { type: "string" },
        engine: { type: "string", enum: ["agy", "claude", "codex"] },
        model: { type: "string" },
        effort: { type: "string" },
        mode: { type: "string", enum: ["readonly", "write"], default: "readonly" },
        worktree: { type: "boolean" },
        ownedFiles: { type: "array", items: { type: "string" } },
        forbiddenFiles: { type: "array", items: { type: "string" } },
        invariants: { type: "array", items: { type: "string" } },
        decisionsMade: { type: "array", items: { type: "string" } },
        doNotRelitigate: { type: "array", items: { type: "string" } },
        supersededDecisions: { type: "array", items: { type: "string" } },
        deprecatedInvariants: { type: "array", items: { type: "string" } },
        acceptanceCriteria: { type: "array", items: { type: "string" } },
        parentHandoffId: { type: "string" },
        handoffId: { type: "string" },
        handoff: { type: "boolean" },
        includeHostDigest: { type: "boolean" },
        includeRepoHandoff: { type: "boolean" },
        includeBoardDigest: { type: "boolean" },
        resumeRole: { type: "boolean" },
        resumeSessionId: { type: "string" },
        forkSession: { type: "boolean" },
        outputSchema: { type: "object" },
        timeoutMs: { type: "number" }
      }
    }
  },
  {
    name: "relay_review",
    description:
      "Run Goldfish (zero-history) adversarial code review (`action='run'`) or paginate stored findings without side effects (`action='inspect'`, `reviewId`).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["run", "inspect"], default: "run" },
        reviewId: { type: "string" },
        offset: { type: "number", default: 0 },
        limit: { type: "number", default: 10 },
        severity: { type: "string" },
        cwd: { type: "string" },
        host: { type: "string", enum: ["agy", "claude", "codex", "cli"] },
        background: { type: "boolean", default: false },
        engine: { type: "string", enum: ["both", "agy", "claude", "codex"], default: "both" },
        scope: { type: "string", enum: ["auto", "working-tree", "branch"] },
        base: { type: "string" },
        focus: { type: "string" },
        model: { type: "string" },
        agyModel: { type: "string" },
        codexModel: { type: "string" },
        claudeModel: { type: "string" },
        effort: { type: "string" },
        native: { type: "boolean" },
        timeoutMs: { type: "number" }
      }
    }
  },
  {
    name: "relay_review_gate",
    description:
      "Bounded 2-round cycle-scoped blocking vs advisory review gate (`action='run'` or `action='inspect'` with `reviewId`). Escalates after maxRounds within an unpassed cycle.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["run", "inspect"], default: "run" },
        reviewId: { type: "string" },
        offset: { type: "number", default: 0 },
        limit: { type: "number", default: 10 },
        severity: { type: "string" },
        cwd: { type: "string" },
        host: { type: "string", enum: ["agy", "claude", "codex", "cli"] },
        background: { type: "boolean", default: false },
        gateKey: { type: "string" },
        workflowId: { type: "string" },
        maxRounds: { type: "number", default: 2 },
        reset: { type: "boolean", default: false },
        engine: { type: "string", enum: ["both", "agy", "claude", "codex"], default: "both" },
        scope: { type: "string", enum: ["auto", "working-tree", "branch"] },
        base: { type: "string" },
        focus: { type: "string" },
        effort: { type: "string" },
        timeoutMs: { type: "number" }
      }
    }
  },
  {
    name: "relay_design",
    description:
      "Anti-anchoring dual-track architecture design vault: `start` (runs independent advisor without host draft), `submit_host` (seals host draft), `reveal` (returns both + 4-section merge template).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["start", "submit_host", "reveal"] },
        cwd: { type: "string" },
        host: { type: "string", enum: ["agy", "claude", "codex", "cli"] },
        background: { type: "boolean", default: false },
        designId: { type: "string" },
        requirement: { type: "string" },
        contextPaths: { type: "array", items: { type: "string" } },
        advisorSpec: { type: "string" },
        hostDraft: { type: "string" },
        hostDraftPath: { type: "string" }
      }
    }
  },
  {
    name: "relay_copy_review",
    description:
      "Have the advisor engine audit UI copy, status labels (2-4 words), README, or technical docs and return a structured `location | current | problem | suggestion` table.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cwd: { type: "string" },
        host: { type: "string", enum: ["agy", "claude", "codex", "cli"] },
        content: { type: "string" },
        filePath: { type: "string" },
        audience: { type: "string" },
        purpose: { type: "string" },
        advisorSpec: { type: "string" },
        workflowId: { type: "string" }
      }
    }
  },
  {
    name: "relay_orchestrate",
    description:
      "Run multi-engine workflows: `teamwork`, `boost` (with forked peer cross-critique), `swarm` (pre-validated DAG + board), or `pipeline`. Supports background=true.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["pattern"],
      properties: {
        cwd: { type: "string" },
        host: { type: "string", enum: ["agy", "claude", "codex", "cli"] },
        background: { type: "boolean", default: false },
        pattern: { type: "string", enum: ["teamwork", "boost", "swarm", "pipeline"] },
        workflowId: { type: "string" },
        boardId: { type: "string" },
        goal: { type: "string" },
        prompt: { type: "string" },
        models: { type: "array", items: { type: "string" } },
        crossCritique: { type: "boolean" },
        crossVerify: { type: "boolean" },
        architectProfile: { type: "string" },
        architectSpec: { type: "string" },
        verifierSpec: { type: "string" },
        tasks: { type: "array", items: { type: "object" } },
        workers: { type: "array", items: { type: "object" } },
        stages: { type: "array", items: { type: "object" } },
        includeHostDigest: { type: "boolean" },
        includeRepoHandoff: { type: "boolean" },
        maxConcurrency: { type: "number" },
        maxPerEngine: { type: "number" },
        timeoutMs: { type: "number" }
      }
    }
  },
  {
    name: "relay_apply",
    description:
      "Check or apply a captured git patch from a completed isolated worktree job (`mode='check'` or `mode='apply'`).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["jobId"],
      properties: {
        cwd: { type: "string" },
        jobId: { type: "string" },
        mode: { type: "string", enum: ["check", "apply"], default: "check" }
      }
    }
  },
  {
    name: "relay_handoff",
    description:
      "Create or inspect portable Handoff Packets across agy, claude, and codex, or list workspace-scoped Claude sessions.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["create", "inspect", "list_claude_sessions"] },
        cwd: { type: "string" },
        parentHandoffId: { type: "string" },
        handoffId: { type: "string" },
        workflowId: { type: "string" },
        boardId: { type: "string" },
        fromHost: { type: "string", enum: ["agy", "claude", "codex", "cli"] },
        toEngine: { type: "string", enum: ["agy", "claude", "codex"] },
        role: { type: "string" },
        goal: { type: "string" },
        ownedFiles: { type: "array", items: { type: "string" } },
        forbiddenFiles: { type: "array", items: { type: "string" } },
        invariants: { type: "array", items: { type: "string" } },
        decisionsMade: { type: "array", items: { type: "string" } },
        doNotRelitigate: { type: "array", items: { type: "string" } },
        supersededDecisions: { type: "array", items: { type: "string" } },
        deprecatedInvariants: { type: "array", items: { type: "string" } },
        openQuestions: { type: "array", items: { type: "string" } },
        evidence: { type: "array", items: { type: "string" } },
        acceptanceCriteria: { type: "array", items: { type: "string" } },
        includeHostDigest: { type: "boolean" },
        includeRepoHandoff: { type: "boolean" },
        includeBoardDigest: { type: "boolean" }
      }
    }
  },
  {
    name: "relay_board",
    description:
      "Read (3-tier Pin/Stub/Recall by default, or view='full' / pinsOnly / seqs) or post messages (supporting pinId / supersedes) on the shared board.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["read", "post"] },
        cwd: { type: "string" },
        boardId: { type: "string", default: "default" },
        view: { type: "string", enum: ["tiered", "full"], default: "tiered" },
        pinsOnly: { type: "boolean", default: false },
        seqs: { type: "array", items: { type: "number" } },
        since: { type: "number", default: 0 },
        limit: {
          type: "number",
          description: "Entry cap (defaults to 100 when view='tiered'; unbounded 0 when view='full')."
        },
        author: { type: "string" },
        tag: { type: "string" },
        text: { type: "string" },
        pinId: { type: "string" },
        supersedes: { type: "string" }
      }
    }
  },
  {
    name: "relay_jobs",
    description:
      "List, inspect status, wait (up to 90s), retrieve results (set compact=false for full raw recall), or cancel Trirelay background jobs.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["list", "status", "wait", "result", "cancel"] },
        cwd: { type: "string" },
        jobId: { type: "string" },
        waitTimeoutMs: { type: "number", default: 30000 },
        limit: { type: "number", default: 20 },
        compact: { type: "boolean", default: true }
      }
    }
  }
];

function assertJsonType(value, propSchema, fieldName) {
  if (value === undefined || value === null) return;
  const expected = propSchema?.type;
  if (expected === "string" && typeof value !== "string") {
    throw new Error(`Invalid type for "${fieldName}": expected string.`);
  }
  if (expected === "boolean" && typeof value !== "boolean") {
    throw new Error(`Invalid type for "${fieldName}": expected boolean.`);
  }
  if (expected === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`Invalid type for "${fieldName}": expected finite number.`);
  }
  if (expected === "object" && (typeof value !== "object" || Array.isArray(value))) {
    throw new Error(`Invalid type for "${fieldName}": expected object.`);
  }
  if (expected === "array") {
    if (!Array.isArray(value)) {
      throw new Error(`Invalid type for "${fieldName}": expected array.`);
    }
    if (propSchema.items) {
      for (let i = 0; i < value.length; i += 1) {
        assertJsonType(value[i], propSchema.items, `${fieldName}[${i}]`);
      }
    }
  }
  if (Array.isArray(propSchema?.enum) && !propSchema.enum.includes(value)) {
    throw new Error(`Invalid value for "${fieldName}": "${value}" not in [${propSchema.enum.join(", ")}].`);
  }
}

function validateToolInputAgainstSchema(toolDef, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`Invalid arguments for ${toolDef.name}: expected JSON object.`);
  }
  const allowedProps = toolDef.inputSchema?.properties ?? {};
  for (const key of Object.keys(args)) {
    if (!(key in allowedProps)) {
      throw new Error(`Security/validation error: unknown property "${key}" is not allowed on ${toolDef.name}.`);
    }
    assertJsonType(args[key], allowedProps[key], key);
  }
  for (const req of toolDef.inputSchema?.required ?? []) {
    if (args[req] === undefined || args[req] === null || args[req] === "") {
      throw new Error(`Missing required argument "${req}" for ${toolDef.name}.`);
    }
  }
}

function assertAllowedWorkspace(cwd) {
  const resolved = resolveWorkspaceRoot(cwd || process.cwd());
  const rawAllowed = process.env.TRIRELAY_ALLOWED_ROOTS;
  if (!rawAllowed) return resolved;
  const roots = rawAllowed.split(path.delimiter).filter(Boolean).map((r) => canonicalizePath(r));
  if (roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    return resolved;
  }
  throw new Error(`Security error: workspace "${resolved}" is outside TRIRELAY_ALLOWED_ROOTS.`);
}

async function handleToolCall(name, args = {}) {
  const toolDef = TOOLS.find((t) => t.name === name);
  if (!toolDef) {
    throw new Error(`Unknown tool: ${name}`);
  }
  validateToolInputAgainstSchema(toolDef, args);
  const cwd = assertAllowedWorkspace(args.cwd || process.cwd());

  switch (name) {
    case "relay_setup": {
      const host = resolveHost(args.host);
      const [agy, codex, claude] = await Promise.all([
        Promise.resolve(checkAgyHealth(cwd)),
        Promise.resolve(checkCodexHealth(cwd)),
        Promise.resolve(checkClaudeHealth(cwd))
      ]);
      const availableEngines = [agy.ready && "agy", claude.ready && "claude", codex.ready && "codex"].filter(Boolean);
      return {
        ready: availableEngines.length >= 2,
        allThreeReady: Boolean(agy.ready && claude.ready && codex.ready),
        host,
        availableEngines,
        workspaceRoot: cwd,
        agy,
        claude,
        codex,
        hostSession: loadHostSession(cwd)
      };
    }

    case "relay_models":
      return getFullModelCatalog({
        includeHidden: Boolean(args.includeHidden),
        includeAgyProbe: args.includeAgyProbe !== false
      });

    case "relay_route":
      return resolveRoute(args);

    case "relay_run": {
      assertRecursionSafe(cwd);
      validateCallerArgs(args);
      if (args.background) {
        return launchBackgroundJob(
          cwd,
          { kind: "run", workflowId: args.workflowId, role: args.role, mode: args.mode, engine: args.engine },
          ({ jobId, logFile, signal }) =>
            runSingleTask(cwd, args, { jobId, logFile, signal })
        );
      }
      const controller = new AbortController();
      const promise = runSingleTask(cwd, args, { signal: controller.signal });
      registerActiveAbortController(controller, promise);
      const res = await promise;
      return { isToolError: !res.ok, data: res };
    }

    case "relay_review": {
      assertRecursionSafe(cwd);
      validateCallerArgs(args);
      if (args.action === "inspect" || args.reviewId) {
        return inspectReviewArtifact(cwd, args);
      }
      if (args.background) {
        return launchBackgroundJob(
          cwd,
          { kind: "review", workflowId: "review", role: "reviewer", mode: "readonly" },
          ({ signal }) => runDualReview(cwd, args, { signal })
        );
      }
      const controller = new AbortController();
      const promise = runDualReview(cwd, args, { signal: controller.signal });
      registerActiveAbortController(controller, promise);
      const res = await promise;
      return { isToolError: !res.ok, data: res };
    }

    case "relay_review_gate": {
      if (args.action === "inspect" || args.reviewId) {
        return inspectReviewArtifact(cwd, args);
      }
      if (args.background && !args.reset) {
        assertRecursionSafe(cwd);
        validateCallerArgs(args);
        return launchBackgroundJob(
          cwd,
          { kind: "review-gate", workflowId: args.gateKey || args.workflowId || "default-gate", role: "reviewer", mode: "readonly" },
          ({ signal }) => runReviewGate(cwd, args, { signal })
        );
      }
      const controller = new AbortController();
      const promise = runReviewGate(cwd, args, { signal: controller.signal });
      registerActiveAbortController(controller, promise);
      return await promise;
    }

    case "relay_design": {
      if (args.action === "start" && args.background) {
        assertRecursionSafe(cwd);
        validateCallerArgs(args);
        return launchBackgroundJob(
          cwd,
          { kind: "design", workflowId: args.designId || "design", role: "advisor", mode: "readonly" },
          ({ signal }) => runDualDesign(cwd, args, { signal })
        );
      }
      const controller = new AbortController();
      const promise = runDualDesign(cwd, args, { signal: controller.signal });
      registerActiveAbortController(controller, promise);
      return await promise;
    }

    case "relay_copy_review": {
      const controller = new AbortController();
      const promise = runCopyReview(cwd, args, { signal: controller.signal });
      registerActiveAbortController(controller, promise);
      return await promise;
    }

    case "relay_orchestrate": {
      assertRecursionSafe(cwd);
      validateCallerArgs(args);
      if (args.background) {
        return launchBackgroundJob(
          cwd,
          { kind: args.pattern, workflowId: args.workflowId || args.pattern, role: "orchestrator", mode: "readonly" },
          ({ signal }) => runOrchestration(cwd, args, { signal })
        );
      }
      const controller = new AbortController();
      const promise = runOrchestration(cwd, args, { signal: controller.signal });
      registerActiveAbortController(controller, promise);
      const res = await promise;
      return { isToolError: !res.ok, data: res };
    }

    case "relay_apply": {
      const detail = await handleJobControl(cwd, { action: "result", jobId: args.jobId, exact: true });
      return applyJobPatch(cwd, detail.job, { mode: args.mode || "check" });
    }

    case "relay_handoff": {
      if (args.action === "create") {
        return createHandoffPacket(cwd, args);
      }
      if (args.action === "inspect") {
        const packet = loadHandoffPacket(cwd, args.handoffId);
        if (!packet) {
          throw new Error(`Handoff packet "${args.handoffId}" not found.`);
        }
        return packet;
      }
      if (args.action === "list_claude_sessions") {
        return {
          workspaceRoot: cwd,
          sessions: listWorkspaceClaudeSessions(cwd)
        };
      }
      throw new Error(`Unknown relay_handoff action: ${args.action}`);
    }

    case "relay_board": {
      const boardId = args.boardId || "default";
      if (args.action === "read") {
        if (Array.isArray(args.seqs) && args.seqs.length > 0) {
          return { boardId, view: "seqs", posts: readBoardPostsBySeqs(cwd, boardId, args.seqs) };
        }
        if (args.pinsOnly) {
          return { boardId, view: "pinsOnly", pins: readActiveBoardPins(cwd, boardId) };
        }
        if (args.view === "full") {
          const fullLimit = args.limit !== undefined ? args.limit : 0;
          const posts = readBoardPosts(cwd, boardId, { since: args.since ?? 0, limit: fullLimit });
          return { boardId, view: "full", posts };
        }
        const posts = readBoardPosts(cwd, boardId, { since: args.since ?? 0, limit: args.limit ?? 100 });
        const activePins = readActiveBoardPins(cwd, boardId);
        return buildTieredBoardView(posts, { pinnedPosts: activePins, boardId, cwd });
      }
      if (args.action === "post") {
        return postBoardMessage(cwd, boardId, {
          author: args.author || "coordinator",
          tag: args.tag || "[update]",
          text: args.text || "",
          pinId: args.pinId,
          supersedes: args.supersedes
        });
      }
      throw new Error(`Unknown relay_board action: ${args.action}`);
    }

    case "relay_jobs":
      return await handleJobControl(cwd, args);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function sendResponse(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function sendError(id, code, message, data = undefined) {
  const err = data === undefined ? { code, message } : { code, message, data };
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: err })}\n`);
}

async function handleRequest(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    sendError(null, -32600, "Invalid Request: expected JSON-RPC object.");
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined || id === null) {
    return;
  }
  if (serverShuttingDown) {
    sendError(id, -32000, "MCP server is shutting down.");
    return;
  }

  try {
    if (method === "initialize") {
      const reqVersion = params?.protocolVersion;
      const negotiated = SUPPORTED_PROTOCOL_VERSIONS.includes(reqVersion)
        ? reqVersion
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      sendResponse(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: {
          name: "trirelay",
          version: PKG.version || "1.0.0"
        }
      });
      return;
    }

    if (method === "ping") {
      sendResponse(id, {});
      return;
    }

    if (method === "tools/list") {
      sendResponse(id, { tools: TOOLS });
      return;
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const toolArgs = params?.arguments ?? {};
      try {
        const rawResult = await handleToolCall(toolName, toolArgs);
        const isToolError = Boolean(rawResult && typeof rawResult === "object" && "isToolError" in rawResult && rawResult.isToolError);
        const payload =
          rawResult && typeof rawResult === "object" && "data" in rawResult && "isToolError" in rawResult
            ? rawResult.data
            : rawResult;

        const allowUnboundedRecall =
          (toolName === "relay_jobs" && toolArgs.compact === false) ||
          (toolName === "relay_board" && (toolArgs.view === "full" || toolArgs.pinsOnly === true || Array.isArray(toolArgs.seqs))) ||
          ((toolName === "relay_review" || toolName === "relay_review_gate") && (toolArgs.action === "inspect" || Boolean(toolArgs.reviewId))) ||
          (toolName === "relay_handoff" && toolArgs.action === "inspect");

        const recallCwd =
          payload && typeof payload === "object" && typeof payload.workspaceRoot === "string"
            ? payload.workspaceRoot
            : typeof toolArgs.cwd === "string" && toolArgs.cwd.trim()
              ? resolveWorkspaceRoot(toolArgs.cwd)
              : null;

        const serialized = serializeMcpPayload(toolName, payload, {
          maxBytes: resolveMcpMaxBytes(),
          compact: !allowUnboundedRecall,
          cwd: recallCwd
        });

        sendResponse(id, {
          content: [{ type: "text", text: serialized.text }],
          isError: isToolError
        });
      } catch (err) {
        sendResponse(id, {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true
        });
      }
      return;
    }

    sendError(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    sendError(id, -32603, err instanceof Error ? err.message : String(err));
  }
}

export function startMcpServer() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let shutdownPromise = null;
  const shutdown = async (exitOnFinish = false) => {
    serverShuttingDown = true;
    try {
      rl.close();
    } catch {
      // Ignore close failure.
    }
    if (!shutdownPromise) {
      shutdownPromise = cancelAllActiveInProcessJobs(2500).catch(() => {});
    }
    await shutdownPromise;
    if (exitOnFinish) {
      process.exit(0);
    }
  };
  rl.on("close", () => {
    void shutdown(false);
  });
  process.on("SIGTERM", () => {
    void shutdown(true);
  });
  process.on("SIGINT", () => {
    void shutdown(true);
  });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      sendError(null, -32700, `Parse error: ${err.message}`);
      return;
    }
    void handleRequest(parsed);
  });
}
