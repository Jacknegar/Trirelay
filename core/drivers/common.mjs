import { spawn } from "node:child_process";
import process from "node:process";

import { buildWorkerEnv, getRecursionDepth } from "../env.mjs";

export function buildWorkerGuardrailPrompt(engine) {
  const nextDepth = getRecursionDepth() + 1;
  return [
    `[Trirelay Worker Policy | engine=${engine} | depth=${nextDepth}]`,
    "You are running as a delegated worker inside a Trirelay workflow.",
    "Complete your scoped task directly using only your local tools within the assigned scope.",
    "Do NOT delegate back to trirelay, agy-ask, codex-worker, claude-worker, or spawn recursive multi-engine workflows."
  ].join(" ");
}

export function tryExtractJson(text) {
  if (!text || typeof text !== "string") {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function isPreDispatchFailure({ errorText = "", hasStartedTurn = false, touchedCount = 0, commandCount = 0 } = {}) {
  if (hasStartedTurn || touchedCount > 0 || commandCount > 0) {
    return false;
  }
  return /\b(enoent|not found|not authenticated|unauthorized|login required|401|403|429|rate limit|quota|capacity|overloaded|503|service unavailable|invalid model)\b/i.test(
    String(errorText || "")
  );
}

/**
 * Spawn a CLI subprocess in its own process group (on POSIX) with timeout
 * escalation (SIGTERM -> SIGKILL after 3s) and optional stdin payload.
 */
export function spawnJsonlProcess({
  bin,
  args,
  cwd,
  engine,
  stdinText = null,
  timeoutMs = 600000,
  signal = null,
  onLine = null,
  onStderr = null
}) {
  return new Promise((resolve) => {
    const useProcessGroup = process.platform !== "win32";
    const env = buildWorkerEnv(process.env, {
      depth: getRecursionDepth() + 1,
      engine
    });

    const proc = spawn(bin, args, {
      cwd,
      env,
      detached: useProcessGroup,
      stdio: [stdinText !== null ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true
    });

    let stdoutBuf = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let forceKillTimer = null;

    function terminateTree() {
      if (!proc || proc.exitCode !== null) return;
      try {
        if (useProcessGroup && proc.pid) {
          process.kill(-proc.pid, "SIGTERM");
        } else {
          proc.kill("SIGTERM");
        }
      } catch {
        // Ignore already-exited process.
      }
      forceKillTimer = setTimeout(() => {
        if (proc.exitCode === null) {
          try {
            if (useProcessGroup && proc.pid) {
              process.kill(-proc.pid, "SIGKILL");
            } else {
              proc.kill("SIGKILL");
            }
          } catch {
            // Ignore.
          }
        }
      }, 3000);
      forceKillTimer.unref?.();
    }

    const timeoutTimer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            terminateTree();
          }, timeoutMs)
        : null;
    timeoutTimer?.unref?.();

    const onAbort = () => {
      aborted = true;
      terminateTree();
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    function cleanup() {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }

    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");

    proc.stdout.on("data", (chunk) => {
      stdoutBuf += chunk;
      let idx = stdoutBuf.indexOf("\n");
      while (idx !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (line) {
          onLine?.(line);
        }
        idx = stdoutBuf.indexOf("\n");
      }
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
      onStderr?.(chunk);
    });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        code: null,
        spawnError: err,
        timedOut,
        aborted,
        stderr,
        trailingStdout: stdoutBuf.trim()
      });
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      const tail = stdoutBuf.trim();
      if (tail) {
        onLine?.(tail);
      }
      resolve({
        code,
        spawnError: null,
        timedOut,
        aborted,
        stderr,
        trailingStdout: tail
      });
    });

    if (stdinText !== null && proc.stdin) {
      proc.stdin.end(String(stdinText));
    }
  });
}
