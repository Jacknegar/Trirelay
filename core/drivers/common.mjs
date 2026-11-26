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
 * escalation (SIGTERM -> SIGKILL after killGraceMs), stdin EPIPE protection,
 * and forced group cleanup + settlement even if grandchildren outlive the parent CLI.
 */
export function spawnJsonlProcess({
  bin,
  args,
  cwd,
  engine,
  stdinText = null,
  timeoutMs = 600000,
  killGraceMs = 1500,
  signal = null,
  onLine = null,
  onStderr = null
}) {
  return new Promise((resolve) => {
    const useProcessGroup = process.platform !== "win32";
    const graceMs = Math.max(100, Math.min(3000, Number.isFinite(Number(killGraceMs)) ? Number(killGraceMs) : 1500));
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
    let stdinError = null;
    let processExited = false;
    let exitCode = null;
    let timedOut = false;
    let aborted = false;
    let terminating = false;
    let settled = false;
    let forceKillTimer = null;
    let finalSettleTimer = null;

    function destroyStreams() {
      try { proc.stdin?.destroy(); } catch {}
      try { proc.stdout?.destroy(); } catch {}
      try { proc.stderr?.destroy(); } catch {}
    }

    function cleanup() {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (finalSettleTimer) clearTimeout(finalSettleTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }

    function finalize(codeOverride = undefined) {
      if (settled) return;
      settled = true;
      cleanup();
      const tail = stdoutBuf.trim();
      if (tail) {
        onLine?.(tail);
      }
      resolve({
        code: codeOverride !== undefined ? codeOverride : exitCode,
        spawnError: null,
        timedOut,
        aborted,
        stdinError: stdinError ? (stdinError.message || String(stdinError)) : null,
        stderr,
        trailingStdout: tail
      });
    }

    function terminateTree() {
      if (terminating || settled) return;
      terminating = true;

      // Signal the entire process group even if the lead CLI already exited while
      // orphaned descendant workers/tools still hold stdio pipes open.
      try {
        if (useProcessGroup && proc.pid) {
          process.kill(-proc.pid, "SIGTERM");
        } else if (!processExited) {
          proc.kill("SIGTERM");
        }
      } catch {
        // Ignore ESRCH when process/group already exited.
      }

      forceKillTimer = setTimeout(() => {
        try {
          if (useProcessGroup && proc.pid) {
            process.kill(-proc.pid, "SIGKILL");
          } else if (!processExited) {
            proc.kill("SIGKILL");
          }
        } catch {
          // Ignore ESRCH.
        }
        destroyStreams();
        finalSettleTimer = setTimeout(() => finalize(exitCode), 250);
        finalSettleTimer.unref?.();
      }, graceMs);
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

    if (proc.stdin) {
      proc.stdin.on("error", (err) => {
        // Early-exit children close stdin before reading large prompts (EPIPE / ERR_STREAM_DESTROYED).
        stdinError = err;
      });
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

    proc.on("exit", (code) => {
      processExited = true;
      exitCode = code;
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
        stdinError: stdinError ? (stdinError.message || String(stdinError)) : null,
        stderr,
        trailingStdout: stdoutBuf.trim()
      });
    });

    proc.on("close", (code) => {
      finalize(code ?? exitCode);
    });

    if (stdinText !== null && proc.stdin) {
      try {
        proc.stdin.end(String(stdinText));
      } catch (err) {
        stdinError = err;
      }
    }
  });
}
