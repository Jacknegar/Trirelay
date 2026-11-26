import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SLEEP_BUF = new SharedArrayBuffer(4);
const SLEEP_VIEW = new Int32Array(SLEEP_BUF);

function sleepSync(ms) {
  Atomics.wait(SLEEP_VIEW, 0, 0, Math.max(1, ms));
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function tryBreakStaleLock(lockDir, staleMs) {
  // Serialize stale recovery via a dedicated reclaim mutex so two contenders cannot
  // observe the same stale lock and have the second deleter remove a fresh winner's lock.
  const reclaimDir = `${lockDir}.reclaim`;
  try {
    fs.mkdirSync(reclaimDir, { mode: 0o700 });
  } catch (err) {
    if (err?.code === "EEXIST") {
      try {
        if (Date.now() - fs.statSync(reclaimDir).mtimeMs > 5000) {
          fs.rmSync(reclaimDir, { recursive: true, force: true });
        }
      } catch {
        // Ignore.
      }
    }
    return false;
  }

  try {
    const metaPath = path.join(lockDir, "owner.json");
    let owner = null;
    try {
      owner = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } catch {
      owner = null;
    }

    let ageMs = 0;
    try {
      ageMs = Date.now() - fs.statSync(lockDir).mtimeMs;
    } catch {
      return false;
    }

    // NEVER break a lock whose owner PID is still alive.
    if (owner?.pid && isProcessAlive(owner.pid)) {
      return false;
    }

    if ((owner?.pid && ageMs > 1000) || (!owner?.pid && ageMs > staleMs)) {
      try {
        fs.rmSync(lockDir, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  } finally {
    try {
      fs.rmSync(reclaimDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failure.
    }
  }
}

/**
 * Execute `fn` synchronously under an exclusive filesystem `mkdir` lock.
 * Provides atomic cross-process mutual exclusion on both Linux and macOS.
 */
export function withFileLockSync(targetPath, fn, { timeoutMs = 15000, staleMs = 60000 } = {}) {
  const lockDir = `${targetPath}.lock`;
  fs.mkdirSync(path.dirname(lockDir), { recursive: true, mode: 0o700 });

  const token = randomBytes(8).toString("hex");
  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  let backoffMs = 8;

  while (Date.now() <= deadline) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      try {
        fs.writeFileSync(
          path.join(lockDir, "owner.json"),
          JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }),
          { mode: 0o600 }
        );
      } catch {
        // Metadata write is best-effort.
      }
      acquired = true;
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") {
        throw err;
      }
      if (tryBreakStaleLock(lockDir, staleMs)) {
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      sleepSync(Math.min(backoffMs, remaining));
      backoffMs = Math.min(60, Math.round(backoffMs * 1.4));
    }
  }

  if (!acquired) {
    throw new Error(`Timed out acquiring state lock: ${lockDir}`);
  }

  try {
    return fn();
  } finally {
    try {
      const metaPath = path.join(lockDir, "owner.json");
      const current = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (current?.token === token && current?.pid === process.pid) {
        fs.rmSync(lockDir, { recursive: true, force: true });
      }
    } catch {
      // If metadata cannot be read, only remove if lock dir is still ours.
    }
  }
}
