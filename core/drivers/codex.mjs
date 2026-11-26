import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { probeBinary, resolveCodexHome, resolveExecutable, runSync } from "../env.mjs";
import { validateOpaqueId } from "../state.mjs";
import { buildWorkerGuardrailPrompt, isPreDispatchFailure, spawnJsonlProcess, tryExtractJson } from "./common.mjs";

const CODEX_ALLOWED_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

function resolveCodexBin() {
  return resolveExecutable("codex", {
    envOverride: "TRIRELAY_CODEX_BIN",
    extraCandidates: [
      path.join(os.homedir(), ".nvm", "versions", "node", process.version, "bin", "codex")
    ]
  });
}

export function readCodexConfigDefaults() {
  const configPath = path.join(resolveCodexHome(), "config.toml");
  const defaults = { model: null, effort: null, configPath };
  if (!fs.existsSync(configPath)) {
    return defaults;
  }
  try {
    const lines = fs.readFileSync(configPath, "utf8").split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("[")) break;
      const m = line.match(/^model\s*=\s*["']([^"']+)["']/);
      if (m) {
        defaults.model = m[1];
        continue;
      }
      const e = line.match(/^model_reasoning_effort\s*=\s*["']([^"']+)["']/);
      if (e) {
        defaults.effort = e[1];
      }
    }
  } catch {
    // Ignore parse errors.
  }
  return defaults;
}

export function checkCodexHealth(cwd) {
  const bin = resolveCodexBin();
  if (!bin) {
    return { ready: false, available: false, path: null, detail: "codex executable not found", auth: null };
  }
  const ver = probeBinary("codex", ["--version"], {
    cwd,
    envOverride: "TRIRELAY_CODEX_BIN",
    timeoutMs: 8000
  });
  if (!ver.available) {
    return { ready: false, available: false, path: bin, detail: ver.detail, auth: null };
  }

  const loginRes = runSync(bin, ["login", "status"], { cwd, timeoutMs: 8000 });
  const statusText = (loginRes.stdout || loginRes.stderr || "").trim();
  const authJsonExists = fs.existsSync(path.join(resolveCodexHome(), "auth.json"));
  const loggedIn = loginRes.status === 0 || /logged in/i.test(statusText) || authJsonExists;
  const defaults = readCodexConfigDefaults();

  return {
    ready: Boolean(ver.available && loggedIn),
    available: true,
    path: bin,
    detail: ver.detail,
    auth: {
      loggedIn,
      detail: statusText || (authJsonExists ? "auth.json present" : "not logged in")
    },
    defaultModel: defaults.model,
    defaultEffort: defaults.effort
  };
}

export function listConfiguredCodexMcpServers() {
  const configPath = path.join(resolveCodexHome(), "config.toml");
  if (!fs.existsSync(configPath)) return [];
  const servers = new Set();
  try {
    const lines = fs.readFileSync(configPath, "utf8").split(/\r?\n/);
    let inMcpServersSection = false;
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      if (trimmed.startsWith("[")) {
        inMcpServersSection = /^\[\s*mcp_servers\s*\](?:\s*(?:#.*)?)?$/.test(trimmed);
        // Match [ mcp_servers . name ] with arbitrary TOML whitespace around dots & brackets
        // (ignoring sub-tables like [mcp_servers.figma.env]).
        const match = trimmed.match(
          /^\[\s*mcp_servers\s*\.\s*(?:"([^"\\]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*\](?:\s*(?:#.*)?)?$/
        );
        if (match) {
          const name = match[1] || match[2] || match[3];
          if (name) servers.add(name);
        }
        continue;
      }

      if (inMcpServersSection) {
        const inlineMatch = trimmed.match(/^(?:"([^"\\]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*=/);
        if (inlineMatch) {
          const name = inlineMatch[1] || inlineMatch[2] || inlineMatch[3];
          if (name) servers.add(name);
        }
      }
    }
  } catch {
    // Ignore parse errors.
  }
  return [...servers];
}

function formatTomlKeySegment(name) {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

export function resolveDisabledCodexMcpServers({ keepMcp = null, allowList = null } = {}) {
  const configured = listConfiguredCodexMcpServers();
  if (configured.length === 0) return [];

  const keepEnv = /^(1|true|yes)$/i.test(String(process.env.TRIRELAY_CODEX_KEEP_MCP ?? ""));
  const effectiveKeep = keepMcp ?? keepEnv;
  const rawAllow = allowList ?? process.env.TRIRELAY_CODEX_MCP_ALLOW ?? "";
  const allowed = new Set(
    String(rawAllow)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );

  const disabled = [];
  for (const name of configured) {
    // Always disable trirelay/trimesh inside worker subprocesses to prevent recursive MCP loops.
    if (name === "trirelay" || name === "trimesh") {
      disabled.push(name);
      continue;
    }
    if (!effectiveKeep && !allowed.has(name)) {
      disabled.push(name);
    }
  }
  return disabled.sort();
}

export function buildCodexExecArgs({
  cwd,
  model = null,
  effort = null,
  mode = "readonly",
  resumeThreadId = null,
  forkSession = false,
  schemaFile = null,
  lastMessageFile = null,
  disabledMcpServers = resolveDisabledCodexMcpServers()
}) {
  const sandboxMode = mode === "write" ? "workspace-write" : "read-only";
  const commonFlags = [
    "--json",
    "--skip-git-repo-check",
    "-c",
    `sandbox_mode="${sandboxMode}"`
  ];
  for (const serverName of disabledMcpServers ?? []) {
    commonFlags.push("-c", `mcp_servers.${formatTomlKeySegment(serverName)}.enabled=false`);
  }

  if (model) {
    commonFlags.push("-m", model);
  }
  if (effort) {
    commonFlags.push("-c", `model_reasoning_effort="${effort}"`);
  }
  if (schemaFile) {
    commonFlags.push("--output-schema", schemaFile);
  }
  if (lastMessageFile) {
    commonFlags.push("-o", lastMessageFile);
  }

  if (resumeThreadId) {
    const safeThreadId = validateOpaqueId(resumeThreadId, "resumeSessionId");
    const sub = forkSession ? "fork" : "resume";
    return ["exec", sub, ...commonFlags, "--", safeThreadId, "-"];
  }

  return ["exec", ...commonFlags, "-C", cwd, "-s", sandboxMode, "-"];
}

export async function runCodexTurn({
  cwd,
  prompt,
  model = null,
  effort = null,
  mode = "readonly",
  resumeSessionId = null,
  forkSession = false,
  outputSchema = null,
  appendSystemPrompt = null,
  timeoutMs = 600000,
  signal = null,
  onProgress = null
}) {
  const startedAt = Date.now();
  const cleanPrompt = String(prompt ?? "").trim();
  if (!cleanPrompt) {
    return {
      ok: false,
      incomplete: false,
      engine: "codex",
      model,
      effort,
      sessionId: resumeSessionId ?? null,
      turnId: null,
      output: "",
      structuredOutput: null,
      touchedFiles: [],
      commandsRun: [],
      usage: null,
      durationMs: 0,
      preDispatchFailure: true,
      error: "Codex task requires a non-empty prompt."
    };
  }

  const bin = resolveCodexBin();
  if (!bin) {
    return {
      ok: false,
      incomplete: false,
      engine: "codex",
      model,
      effort,
      sessionId: resumeSessionId ?? null,
      turnId: null,
      output: "",
      structuredOutput: null,
      touchedFiles: [],
      commandsRun: [],
      usage: null,
      durationMs: 0,
      preDispatchFailure: true,
      error: "Codex CLI (`codex`) executable not found."
    };
  }

  const tmpPrefix = `trirelay-codex-${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const schemaFile = outputSchema ? path.join(os.tmpdir(), `${tmpPrefix}.schema.json`) : null;
  const lastMsgFile = path.join(os.tmpdir(), `${tmpPrefix}.last.txt`);

  if (schemaFile) {
    const schemaPayload = typeof outputSchema === "string" ? outputSchema : JSON.stringify(outputSchema, null, 2);
    fs.writeFileSync(schemaFile, schemaPayload, { encoding: "utf8", mode: 0o600 });
  }

  const guardrail = [buildWorkerGuardrailPrompt("codex"), appendSystemPrompt].filter(Boolean).join("\n\n");
  const fullPrompt = `${guardrail}\n\n${cleanPrompt}`;

  const args = buildCodexExecArgs({
    cwd,
    model,
    effort,
    mode,
    resumeThreadId: resumeSessionId,
    forkSession,
    schemaFile,
    lastMessageFile: lastMsgFile
  });

  let sessionId = resumeSessionId ?? null;
  let turnId = null;
  let finalOutput = "";
  let turnCompleted = false;
  let turnFailedMessage = null;
  let usage = null;
  let hasStartedTurn = false;
  const touchedFiles = new Set();
  const commandsRun = [];

  function handleLine(line) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (!ev || typeof ev !== "object") return;

    if (ev.type === "thread.started" && ev.thread_id) {
      sessionId = ev.thread_id;
      onProgress?.(`Codex thread started (${sessionId}).`);
      return;
    }

    if (ev.type === "turn.started") {
      hasStartedTurn = true;
      if (ev.turn_id) turnId = ev.turn_id;
      onProgress?.("Codex turn started.");
      return;
    }

    if (ev.type === "item.completed" && ev.item) {
      hasStartedTurn = true;
      const item = ev.item;
      if (item.type === "agent_message" && typeof item.text === "string") {
        finalOutput = item.text;
      } else if (item.type === "command_execution") {
        commandsRun.push({
          command: item.command || "",
          exitCode: item.exit_code ?? null,
          status: item.status ?? null
        });
        onProgress?.(`Codex command: ${(item.command || "").slice(0, 120)}`);
      } else if (item.type === "file_change" && Array.isArray(item.changes)) {
        for (const ch of item.changes) {
          if (ch?.path) touchedFiles.add(ch.path);
        }
        onProgress?.(`Codex modified ${item.changes.length} file(s).`);
      }
      return;
    }

    if (ev.type === "turn.completed") {
      hasStartedTurn = true;
      turnCompleted = true;
      if (ev.usage) usage = ev.usage;
      return;
    }

    if (ev.type === "turn.failed" || ev.type === "error") {
      turnFailedMessage = ev.error?.message || ev.message || "Codex turn failed.";
    }
  }

  try {
    const procRes = await spawnJsonlProcess({
      bin,
      args,
      cwd,
      engine: "codex",
      stdinText: fullPrompt,
      timeoutMs,
      signal,
      onLine: handleLine
    });

    if (!finalOutput && fs.existsSync(lastMsgFile)) {
      try {
        finalOutput = fs.readFileSync(lastMsgFile, "utf8").trim();
      } catch {
        // Ignore.
      }
    }

    const structuredOutput = outputSchema ? tryExtractJson(finalOutput) : null;

    if (procRes.spawnError) {
      const errMsg = procRes.spawnError.message;
      return {
        ok: false,
        incomplete: false,
        engine: "codex",
        model,
        effort,
        sessionId,
        turnId,
        output: finalOutput,
        structuredOutput,
        touchedFiles: [...touchedFiles],
        commandsRun,
        usage,
        durationMs: Date.now() - startedAt,
        preDispatchFailure: procRes.spawnError.code === "ENOENT" || isPreDispatchFailure({ errorText: errMsg, hasStartedTurn }),
        error: errMsg
      };
    }

    const missingTerminalEvent = procRes.code === 0 && !turnCompleted && !turnFailedMessage;
    const isError =
      procRes.timedOut ||
      procRes.aborted ||
      procRes.code !== 0 ||
      Boolean(turnFailedMessage) ||
      missingTerminalEvent;

    const errMsg = procRes.aborted
      ? "Codex turn was cancelled."
      : procRes.timedOut
        ? `Codex timed out after ${timeoutMs}ms.`
        : turnFailedMessage
          ? turnFailedMessage
          : missingTerminalEvent
            ? "Codex exited cleanly without a turn.completed event."
            : isError
              ? procRes.stderr.trim() || `Codex exited with code ${procRes.code}.`
              : null;

    return {
      ok: !isError,
      incomplete: Boolean(missingTerminalEvent || procRes.timedOut || procRes.aborted),
      engine: "codex",
      model,
      effort,
      sessionId,
      turnId,
      output: finalOutput,
      structuredOutput,
      touchedFiles: [...touchedFiles],
      commandsRun,
      usage,
      durationMs: Date.now() - startedAt,
      preDispatchFailure:
        isError &&
        isPreDispatchFailure({
          errorText: errMsg,
          hasStartedTurn,
          touchedCount: touchedFiles.size,
          commandCount: commandsRun.length
        }),
      error: errMsg
    };
  } finally {
    for (const tmp of [schemaFile, lastMsgFile]) {
      if (tmp && fs.existsSync(tmp)) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // Ignore cleanup failure.
        }
      }
    }
  }
}

export async function runCodexNativeReview({
  cwd,
  base = null,
  commit = null,
  focus = null,
  model = null,
  effort = "high",
  timeoutMs = 600000,
  signal = null,
  onProgress = null
}) {
  const startedAt = Date.now();
  const bin = resolveCodexBin();
  if (!bin) {
    return {
      ok: false,
      incomplete: false,
      engine: "codex",
      model,
      effort,
      sessionId: null,
      turnId: null,
      output: "",
      durationMs: 0,
      preDispatchFailure: true,
      error: "Codex CLI (`codex`) executable not found."
    };
  }

  const args = [
    "exec",
    "review",
    "--json",
    "--skip-git-repo-check"
  ];
  for (const serverName of resolveDisabledCodexMcpServers()) {
    args.push("-c", `mcp_servers.${formatTomlKeySegment(serverName)}.enabled=false`);
  }
  if (model) args.push("-m", model);
  if (effort) {
    const normEffort = String(effort).trim().toLowerCase();
    if (!CODEX_ALLOWED_EFFORTS.has(normEffort)) {
      throw new Error(`Invalid Codex effort "${effort}". Allowed: ${[...CODEX_ALLOWED_EFFORTS].join(", ")}.`);
    }
    args.push("-c", `model_reasoning_effort="${normEffort}"`);
  }
  if (base) {
    args.push("--base", base);
  } else if (commit) {
    args.push("--commit", commit);
  } else {
    args.push("--uncommitted");
  }
  if (focus) {
    args.push("-");
  }

  let sessionId = null;
  let finalOutput = "";
  let turnCompleted = false;
  let turnFailedMessage = null;

  const procRes = await spawnJsonlProcess({
    bin,
    args,
    cwd,
    engine: "codex",
    stdinText: focus ? String(focus) : null,
    timeoutMs,
    signal,
    onLine: (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.type === "thread.started" && ev.thread_id) {
        sessionId = ev.thread_id;
      } else if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item.text) {
        finalOutput = ev.item.text;
      } else if (ev.type === "turn.completed") {
        turnCompleted = true;
      } else if (ev.type === "turn.failed" || ev.type === "error") {
        turnFailedMessage = ev.error?.message || ev.message || "Codex review failed.";
      }
      onProgress?.(`Codex review: ${ev.type}`);
    }
  });

  const isError = procRes.timedOut || procRes.aborted || procRes.code !== 0 || Boolean(turnFailedMessage) || !turnCompleted;
  return {
    ok: !isError,
    incomplete: Boolean(!turnCompleted || procRes.timedOut || procRes.aborted),
    engine: "codex",
    model,
    effort,
    sessionId,
    turnId: null,
    output: finalOutput,
    durationMs: Date.now() - startedAt,
    error: isError ? turnFailedMessage || procRes.stderr.trim() || `Codex review failed (code ${procRes.code})` : null
  };
}
