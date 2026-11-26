import os from "node:os";
import path from "node:path";

import { probeBinary, resolveExecutable, runSync } from "../env.mjs";
import { buildWorkerGuardrailPrompt, isPreDispatchFailure, spawnJsonlProcess, tryExtractJson } from "./common.mjs";

function resolveClaudeBin() {
  return resolveExecutable("claude", {
    envOverride: "TRIRELAY_CLAUDE_BIN",
    extraCandidates: [
      path.join(os.homedir(), ".local", "bin", "claude"),
      path.join(os.homedir(), ".claude", "local", "claude")
    ]
  });
}

export function checkClaudeHealth(cwd) {
  const bin = resolveClaudeBin();
  if (!bin) {
    return { ready: false, available: false, path: null, detail: "claude executable not found", auth: null };
  }
  const ver = probeBinary("claude", ["--version"], {
    cwd,
    envOverride: "TRIRELAY_CLAUDE_BIN",
    timeoutMs: 8000
  });
  if (!ver.available) {
    return { ready: false, available: false, path: bin, detail: ver.detail, auth: null };
  }
  const authRes = runSync(bin, ["auth", "status"], { cwd, timeoutMs: 10000 });
  let auth = null;
  try {
    const parsed = JSON.parse(authRes.stdout);
    auth = {
      loggedIn: Boolean(parsed?.loggedIn),
      ...(parsed?.authMethod ? { authMethod: parsed.authMethod } : {}),
      ...(parsed?.apiProvider ? { apiProvider: parsed.apiProvider } : {}),
      ...(parsed?.subscriptionType ? { subscriptionType: parsed.subscriptionType } : {})
    };
  } catch {
    auth = { loggedIn: authRes.status === 0 };
  }
  return {
    ready: Boolean(ver.available && auth?.loggedIn),
    available: true,
    path: bin,
    detail: ver.detail,
    auth
  };
}

export function buildClaudeArgs({
  model = null,
  effort = null,
  fallbackModel = null,
  mode = "readonly",
  resumeSessionId = null,
  forkSession = false,
  outputSchema = null,
  appendSystemPrompt = null,
  maxBudgetUsd = null,
  addDirs = [],
  strictMcpConfig = true
}) {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-prompts",
    "none"
  ];

  if (strictMcpConfig) {
    args.push("--strict-mcp-config");
  }
  if (model) {
    args.push("--model", model);
  }
  if (effort) {
    args.push("--effort", effort);
  }
  if (fallbackModel) {
    args.push("--fallback-model", fallbackModel);
  }

  // Use `dontAsk` + explicit `--tools` narrowing for readonly so Claude
  // does not enter interactive `plan` mode or call ExitPlanMode.
  if (mode === "write") {
    args.push(
      "--permission-mode",
      "acceptEdits",
      "--tools",
      "Read,Glob,Grep,Edit,Write,MultiEdit",
      "--allowedTools",
      "Read,Glob,Grep,Edit,Write,MultiEdit",
      "--disallowedTools",
      "Bash"
    );
  } else {
    args.push(
      "--permission-mode",
      "dontAsk",
      "--tools",
      "Read,Glob,Grep",
      "--allowedTools",
      "Read,Glob,Grep",
      "--disallowedTools",
      "Edit,Write,MultiEdit,NotebookEdit,Bash"
    );
  }

  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
    if (forkSession) {
      args.push("--fork-session");
    }
  }

  if (outputSchema) {
    let normalized = outputSchema;
    if (typeof outputSchema === "string") {
      try {
        normalized = JSON.parse(outputSchema);
      } catch {
        normalized = outputSchema;
      }
    }
    if (normalized && typeof normalized === "object" && "$schema" in normalized) {
      const { $schema: _omitSchema, ...rest } = normalized;
      normalized = rest;
    }
    args.push("--json-schema", typeof normalized === "string" ? normalized : JSON.stringify(normalized));
  }

  const combinedSystem = [buildWorkerGuardrailPrompt("claude"), appendSystemPrompt].filter(Boolean).join("\n\n");
  args.push("--append-system-prompt", combinedSystem);

  if (maxBudgetUsd != null && Number.isFinite(Number(maxBudgetUsd))) {
    args.push("--max-budget-usd", String(maxBudgetUsd));
  }

  for (const dir of addDirs ?? []) {
    if (dir) {
      args.push("--add-dir", dir);
    }
  }

  return args;
}

export async function runClaudeTurn({
  cwd,
  prompt,
  model = null,
  effort = null,
  fallbackModel = null,
  mode = "readonly",
  resumeSessionId = null,
  forkSession = false,
  outputSchema = null,
  appendSystemPrompt = null,
  maxBudgetUsd = null,
  addDirs = [],
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
      engine: "claude",
      model,
      effort,
      sessionId: resumeSessionId ?? null,
      turnId: null,
      output: "",
      structuredOutput: null,
      touchedFiles: [],
      commandsRun: [],
      usage: null,
      costUsd: null,
      durationMs: 0,
      preDispatchFailure: true,
      error: "Claude task requires a non-empty prompt."
    };
  }

  const bin = resolveClaudeBin();
  if (!bin) {
    return {
      ok: false,
      incomplete: false,
      engine: "claude",
      model,
      effort,
      sessionId: resumeSessionId ?? null,
      turnId: null,
      output: "",
      structuredOutput: null,
      touchedFiles: [],
      commandsRun: [],
      usage: null,
      costUsd: null,
      durationMs: 0,
      preDispatchFailure: true,
      error: "Claude Code CLI (`claude`) executable not found."
    };
  }

  const args = buildClaudeArgs({
    model,
    effort,
    fallbackModel,
    mode,
    resumeSessionId,
    forkSession,
    outputSchema,
    appendSystemPrompt,
    maxBudgetUsd,
    addDirs
  });

  let sessionId = resumeSessionId ?? null;
  let resolvedModel = model ?? null;
  let finalOutput = "";
  let structuredOutput = null;
  let resultEvent = null;
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

    if (ev.type === "system" && ev.subtype === "init") {
      hasStartedTurn = true;
      if (ev.session_id) sessionId = ev.session_id;
      if (ev.model) resolvedModel = ev.model;
      onProgress?.(`Claude initialized (${resolvedModel ?? "default"}, session ${sessionId ?? "ephemeral"}).`);
      return;
    }

    if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
      hasStartedTurn = true;
      for (const block of ev.message.content) {
        if (block.type === "tool_use") {
          const input = block.input ?? {};
          if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(block.name) && input.file_path) {
            touchedFiles.add(input.file_path);
          }
          if (block.name === "Bash" && input.command) {
            commandsRun.push({ command: input.command, exitCode: null, status: "invoked" });
          }
          onProgress?.(`Claude tool: ${block.name}`);
        } else if (block.type === "text" && block.text) {
          finalOutput = block.text;
        }
      }
      return;
    }

    if (ev.type === "result") {
      hasStartedTurn = true;
      resultEvent = ev;
      if (ev.session_id) sessionId = ev.session_id;
      if (typeof ev.result === "string" && ev.result.length > 0) {
        finalOutput = ev.result;
      }
      if (ev.structured_output !== undefined) {
        structuredOutput = ev.structured_output;
      } else if (outputSchema && finalOutput) {
        structuredOutput = tryExtractJson(finalOutput);
      }
    }
  }

  const procRes = await spawnJsonlProcess({
    bin,
    args,
    cwd,
    engine: "claude",
    stdinText: cleanPrompt,
    timeoutMs,
    signal,
    onLine: handleLine
  });

  if (procRes.spawnError) {
    const errMsg = procRes.spawnError.message;
    return {
      ok: false,
      incomplete: false,
      engine: "claude",
      model: resolvedModel,
      effort,
      sessionId,
      turnId: null,
      output: finalOutput,
      structuredOutput,
      touchedFiles: [...touchedFiles],
      commandsRun,
      usage: null,
      costUsd: null,
      durationMs: Date.now() - startedAt,
      preDispatchFailure: procRes.spawnError.code === "ENOENT" || isPreDispatchFailure({ errorText: errMsg, hasStartedTurn }),
      error: errMsg
    };
  }

  const missingResultEvent = procRes.code === 0 && !resultEvent;
  const isError =
    procRes.timedOut ||
    procRes.aborted ||
    procRes.code !== 0 ||
    Boolean(resultEvent?.is_error) ||
    missingResultEvent;

  const errMsg = procRes.aborted
    ? "Claude Code turn was cancelled."
    : procRes.timedOut
      ? `Claude Code timed out after ${timeoutMs}ms.`
      : missingResultEvent
        ? "Claude Code exited cleanly without an authoritative result event."
        : isError
          ? resultEvent?.result || procRes.stderr.trim() || `Claude exited with code ${procRes.code}.`
          : null;

  return {
    ok: !isError,
    incomplete: Boolean(missingResultEvent || procRes.timedOut || procRes.aborted),
    engine: "claude",
    model: resolvedModel,
    effort,
    sessionId,
    turnId: resultEvent?.uuid ?? null,
    output: finalOutput,
    structuredOutput,
    touchedFiles: [...touchedFiles],
    commandsRun,
    usage: resultEvent?.usage ?? null,
    costUsd: resultEvent?.total_cost_usd ?? null,
    durationMs: Date.now() - startedAt,
    preDispatchFailure: isError && isPreDispatchFailure({
      errorText: errMsg,
      hasStartedTurn,
      touchedCount: touchedFiles.size,
      commandCount: commandsRun.length
    }),
    error: errMsg
  };
}
