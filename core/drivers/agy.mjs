import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { probeBinary, resolveExecutable, runSync } from "../env.mjs";
import { ensureSubdir, generateId } from "../state.mjs";
import { buildWorkerGuardrailPrompt, isPreDispatchFailure, spawnJsonlProcess, tryExtractJson } from "./common.mjs";

function resolveAgyBin() {
  return resolveExecutable("agy", {
    envOverride: "TRIRELAY_AGY_BIN",
    extraCandidates: [
      path.join(os.homedir(), ".local", "bin", "agy"),
      path.join(os.homedir(), ".gemini", "antigravity", "bin", "agy")
    ]
  });
}

export function discoverAgyModels() {
  const bin = resolveAgyBin();
  if (!bin) {
    return { defaultModel: null, defaultEffort: null, models: [] };
  }
  const res = runSync(bin, ["models"], { timeoutMs: 25000 });
  if (res.status !== 0 || !res.stdout) {
    return { defaultModel: null, defaultEffort: null, models: [] };
  }

  const models = [];
  for (const rawLine of res.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("Fetching ")) continue;
    const parts = line.split(/\t+/);
    const id = parts[0]?.trim();
    const displayName = parts[1]?.trim() || id;
    if (!id || id.includes(" ")) continue;
    models.push({
      engine: "agy",
      id,
      displayName,
      visibility: "list",
      defaultEffort: null,
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"]
    });
  }

  return {
    defaultModel: models[0]?.id ?? null,
    defaultEffort: null,
    models
  };
}

export function checkAgyHealth(cwd) {
  const bin = resolveAgyBin();
  if (!bin) {
    return { ready: false, available: false, path: null, detail: "agy executable not found", auth: null };
  }
  const ver = probeBinary("agy", ["--help"], {
    cwd,
    envOverride: "TRIRELAY_AGY_BIN",
    timeoutMs: 8000
  });
  if (!ver.available) {
    return { ready: false, available: false, path: bin, detail: ver.detail, auth: null };
  }

  const modelsRes = runSync(bin, ["models"], { cwd, timeoutMs: 25000 });
  const hasModels = modelsRes.status === 0 && /\S+\t/.test(modelsRes.stdout || "");
  return {
    ready: Boolean(ver.available && hasModels),
    available: true,
    path: bin,
    detail: hasModels ? "agy CLI ready" : modelsRes.stderr.trim() || "agy models unavailable",
    auth: {
      loggedIn: hasModels,
      detail: hasModels ? "Authenticated via Antigravity CLI" : "Run `agy` to authenticate"
    }
  };
}

export function buildAgyArgs({
  prompt,
  model = null,
  effort = null,
  mode = "readonly",
  resumeSessionId = null,
  outputSchema = null,
  addDirs = [],
  timeoutMs = 600000
}) {
  const timeoutSec = Math.max(10, Math.ceil(timeoutMs / 1000));
  const args = [
    "--output-format",
    "stream-json",
    "--print-timeout",
    `${timeoutSec}s`
  ];

  if (mode === "write") {
    args.push("--mode", "accept-edits");
  } else {
    args.push("--mode", "plan", "--sandbox");
  }

  if (model) {
    args.push("--model", model);
  }
  const hasEffortSuffix = Boolean(model && /-(?:low|medium|high|xhigh|max)$/i.test(model));
  if (model && !hasEffortSuffix && effort && effort !== "ultra" && effort !== "none" && effort !== "minimal") {
    args.push("--effort", effort);
  }
  if (resumeSessionId) {
    args.push("--conversation", resumeSessionId);
  }
  if (outputSchema) {
    args.push("--json-schema", typeof outputSchema === "string" ? outputSchema : JSON.stringify(outputSchema));
  }
  for (const dir of addDirs) {
    if (dir) {
      args.push("--add-dir", dir);
    }
  }

  // Always attach prompt via `--print=<prompt>` so flags or leading dashes never collide.
  args.push(`--print=${prompt}`);
  return args;
}

export async function runAgyTurn({
  cwd,
  prompt,
  model = null,
  effort = null,
  mode = "readonly",
  resumeSessionId = null,
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
      engine: "agy",
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
      error: "Antigravity task requires a non-empty prompt."
    };
  }

  const bin = resolveAgyBin();
  if (!bin) {
    return {
      ok: false,
      incomplete: false,
      engine: "agy",
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
      error: "Antigravity CLI (`agy`) executable not found."
    };
  }

  const guardrail = [buildWorkerGuardrailPrompt("agy"), appendSystemPrompt].filter(Boolean).join("\n");
  const fullPrompt = `${guardrail}\n\n${cleanPrompt}`;

  // Avoid Linux MAX_ARG_STRLEN (128 KiB per argv string) by staging oversized prompts in stateDir.
  let stagedPromptFile = null;
  let effectivePromptArg = fullPrompt;
  const addDirs = [];
  if (Buffer.byteLength(fullPrompt, "utf8") > 96 * 1024) {
    const promptsDir = ensureSubdir(cwd, "prompts");
    stagedPromptFile = path.join(promptsDir, `${generateId("agy-prompt")}.md`);
    fs.writeFileSync(stagedPromptFile, fullPrompt, { encoding: "utf8", mode: 0o600 });
    addDirs.push(promptsDir);
    effectivePromptArg = `Read the full task prompt file at ${stagedPromptFile} using view_file and execute it directly.`;
  }

  const args = buildAgyArgs({
    prompt: effectivePromptArg,
    model,
    effort,
    mode,
    resumeSessionId,
    outputSchema,
    addDirs,
    timeoutMs
  });

  let sessionId = resumeSessionId ?? null;
  let finalOutput = "";
  let textAccumulator = "";
  let resultEvent = null;
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

    if (ev.conversation_id) {
      sessionId = ev.conversation_id;
    }

    if (ev.event === "init") {
      hasStartedTurn = true;
      onProgress?.(`Antigravity initialized (conversation ${sessionId ?? "ephemeral"}).`);
      return;
    }

    if (ev.event === "step_update" && ev.step_update) {
      hasStartedTurn = true;
      const su = ev.step_update;
      if (su.conversation_id) sessionId = su.conversation_id;
      if (su.step_type === "agent_response" && typeof su.text_delta === "string") {
        textAccumulator += su.text_delta;
      }
      if (su.step_type === "run_command" && su.state === "DONE") {
        commandsRun.push({ command: su.command || "run_command", exitCode: su.exit_code ?? null, status: su.state });
      }
      if (su.usage) usage = su.usage;
      if (su.state === "DONE" && su.step_type && su.step_type !== "user_input") {
        onProgress?.(`Antigravity step: ${su.step_type}`);
      }
      return;
    }

    if (ev.event === "result" && ev.result) {
      hasStartedTurn = true;
      resultEvent = ev.result;
      if (resultEvent.conversation_id) sessionId = resultEvent.conversation_id;
      if (typeof resultEvent.response === "string") {
        finalOutput = resultEvent.response.trim();
      }
      if (resultEvent.usage) usage = resultEvent.usage;
    }
  }

  let procRes;
  try {
    procRes = await spawnJsonlProcess({
      bin,
      args,
      cwd,
      engine: "agy",
      stdinText: null,
      timeoutMs,
      signal,
      onLine: handleLine
    });
  } finally {
    if (stagedPromptFile && fs.existsSync(stagedPromptFile)) {
      try {
        fs.unlinkSync(stagedPromptFile);
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  if (!finalOutput && textAccumulator.trim()) {
    finalOutput = textAccumulator.trim();
  }

  const structuredOutput = outputSchema ? tryExtractJson(finalOutput) : null;

  if (procRes.spawnError) {
    const errMsg = procRes.spawnError.message;
    return {
      ok: false,
      incomplete: false,
      engine: "agy",
      model,
      effort,
      sessionId,
      turnId: null,
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

  const resultStatus = String(resultEvent?.status || "").toUpperCase();
  const missingResultEvent = procRes.code === 0 && !resultEvent;
  const failedStatus = resultEvent && resultStatus !== "SUCCESS";
  const isError =
    procRes.timedOut ||
    procRes.aborted ||
    procRes.code !== 0 ||
    Boolean(failedStatus) ||
    missingResultEvent;

  const errMsg = procRes.aborted
    ? "Antigravity turn was cancelled."
    : procRes.timedOut
      ? `Antigravity timed out after ${timeoutMs}ms.`
      : failedStatus
        ? resultEvent.error || `Antigravity returned status ${resultStatus}`
        : missingResultEvent
          ? "Antigravity exited cleanly without an authoritative result event."
          : isError
            ? procRes.stderr.trim() || `Antigravity exited with code ${procRes.code}.`
            : null;

  return {
    ok: !isError,
    incomplete: Boolean(missingResultEvent || procRes.timedOut || procRes.aborted),
    engine: "agy",
    model,
    effort,
    sessionId,
    turnId: null,
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
}
