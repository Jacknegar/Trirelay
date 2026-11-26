import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const VALID_ENGINES = ["agy", "claude", "codex"];
export const VALID_HOSTS = ["agy", "claude", "codex", "cli"];

const NESTED_HOST_ENV_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_PLUGIN_DATA",
  "PLUGIN_ROOT",
  "PLUGIN_DATA",
  "ANTIGRAVITY_CONVERSATION_ID",
  "ANTIGRAVITY_TRAJECTORY_ID",
  "ANTIGRAVITY_SOURCE_METADATA",
  "ANTIGRAVITY_AGENT",
  "ANTIGRAVITY_CSRF_TOKEN",
  "ANTIGRAVITY_LS_ADDRESS",
  "ANTIGRAVITY_CREDENTIAL_SCOPE",
  "ANTIGRAVITY_LS_VERSION",
  "ANTIGRAVITY_PROJECT_ID",
  "ANTIGRAVITY_AGENTAPI_EXE",
  "ANTIGRAVITY_PLUGIN_SHIM_DIR",
  "ANTIGRAVITY_APP_DATA_DIR",
  "CODEX_THREAD_ID"
];

function isExecutableFile(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) {
      return false;
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function normalizeEngineName(raw) {
  const val = String(raw || "").trim().toLowerCase();
  if (!val) return null;
  if (val === "antigravity" || val === "agy" || val === "gemini") return "agy";
  if (val === "claude" || val === "claude-code") return "claude";
  if (val === "codex" || val === "openai-codex") return "codex";
  return null;
}

export function resolveHost(explicitHost = null) {
  const explicit = normalizeEngineName(explicitHost) || (explicitHost === "cli" ? "cli" : null);
  if (explicit) return explicit;

  const fromEnv = normalizeEngineName(process.env.TRIRELAY_HOST);
  if (fromEnv) return fromEnv;
  if (process.env.TRIRELAY_HOST === "cli") return "cli";

  if (process.env.ANTIGRAVITY_LS_ADDRESS || process.env.ANTIGRAVITY_CSRF_TOKEN || process.env.ANTIGRAVITY_CONVERSATION_ID) {
    return "agy";
  }
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_SESSION_ID) {
    return "claude";
  }
  if (process.env.CODEX_THREAD_ID || process.env.CODEX_SANDBOX) {
    return "codex";
  }
  return "cli";
}

export function getFallbackBinDirs() {
  const home = os.homedir();
  return [
    path.dirname(process.execPath),
    path.join(home, ".local", "bin"),
    path.join(home, ".gemini", "antigravity", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".asdf", "shims"),
    path.join(home, ".local", "share", "fnm", "aliases", "default", "bin"),
    path.join(home, ".nvm", "versions", "node", process.version, "bin"),
    path.join(home, ".claude", "local"),
    "/usr/bin",
    "/bin"
  ];
}

export function augmentedEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  const sep = path.delimiter;
  const inherited = String(env[pathKey] ?? "").split(sep).filter(Boolean);
  const fallbacks = getFallbackBinDirs();

  const merged = [];
  const seen = new Set();
  for (const entry of [...inherited, ...fallbacks]) {
    if (entry && !seen.has(entry)) {
      seen.add(entry);
      merged.push(entry);
    }
  }
  env[pathKey] = merged.join(sep);
  return env;
}

export function buildWorkerEnv(baseEnv = process.env, { depth = 1, engine = null } = {}) {
  const env = augmentedEnv(baseEnv);
  for (const key of NESTED_HOST_ENV_VARS) {
    delete env[key];
  }
  env.TRIRELAY_DEPTH = String(depth);
  env.TRIRELAY_WORKER = "1";
  if (engine) {
    env.TRIRELAY_WORKER_ENGINE = engine;
  }
  return env;
}

export function getRecursionDepth(env = process.env) {
  const parsed = Number.parseInt(String(env.TRIRELAY_DEPTH ?? "0"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function getMaxRecursionDepth(env = process.env) {
  const parsed = Number.parseInt(String(env.TRIRELAY_MAX_DEPTH ?? "1"), 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

export function resolveExecutable(name, { envOverride = null, extraCandidates = [], env = process.env } = {}) {
  if (envOverride && env[envOverride]) {
    const explicit = env[envOverride].trim();
    if (isExecutableFile(explicit)) {
      return explicit;
    }
  }

  const effectiveEnv = augmentedEnv(env);
  const pathKey = Object.keys(effectiveEnv).find((key) => key.toLowerCase() === "path") || "PATH";
  const dirs = String(effectiveEnv[pathKey] ?? "").split(path.delimiter).filter(Boolean);

  for (const dir of dirs) {
    const full = path.join(dir, name);
    if (isExecutableFile(full)) {
      return full;
    }
  }

  for (const candidate of extraCandidates) {
    if (candidate && isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function runSync(command, args = [], options = {}) {
  const encoding = options.encoding === "buffer" ? "buffer" : (options.encoding ?? "utf8");
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? augmentedEnv(process.env),
    encoding,
    input: options.input,
    timeout: options.timeoutMs ?? 15000,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
    stdio: options.stdio ?? "pipe",
    windowsHide: true
  });
  return {
    command,
    args,
    status: result.status ?? (result.error ? 1 : 0),
    signal: result.signal ?? null,
    stdout: result.stdout ?? (encoding === "buffer" ? Buffer.alloc(0) : ""),
    stderr: result.stderr ?? (encoding === "buffer" ? Buffer.alloc(0) : ""),
    error: result.error ?? null
  };
}

export function probeBinary(name, args = ["--version"], options = {}) {
  const resolved = resolveExecutable(name, {
    envOverride: options.envOverride,
    extraCandidates: options.extraCandidates ?? [],
    env: options.env ?? process.env
  });
  if (!resolved) {
    return { available: false, path: null, detail: `${name} executable not found on PATH` };
  }
  const res = runSync(resolved, args, options);
  if (res.error && res.error.code === "ENOENT") {
    return { available: false, path: null, detail: `${name} not found` };
  }
  if (res.error) {
    return { available: false, path: resolved, detail: res.error.message };
  }
  if (res.status !== 0) {
    const detail = String(res.stderr).trim() || String(res.stdout).trim() || `exit ${res.status}`;
    return { available: false, path: resolved, detail };
  }
  return {
    available: true,
    path: resolved,
    detail: String(res.stdout).trim() || String(res.stderr).trim() || "ok"
  };
}

export function canonicalizePath(targetPath) {
  const resolved = path.resolve(targetPath || process.cwd());
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    // Walk up until an existing ancestor is found, canonicalize it, and re-append remainder.
    const parts = [];
    let cur = resolved;
    while (cur && cur !== path.dirname(cur)) {
      if (fs.existsSync(cur)) {
        try {
          return path.join(fs.realpathSync.native(cur), ...parts.reverse());
        } catch {
          break;
        }
      }
      parts.push(path.basename(cur));
      cur = path.dirname(cur);
    }
    return resolved;
  }
}

export function resolvePathInsideWorkspace(workspaceRoot, filePath, label = "filePath") {
  const rootCanonical = canonicalizePath(workspaceRoot);
  const candidate = path.isAbsolute(String(filePath))
    ? String(filePath)
    : path.resolve(rootCanonical, String(filePath));
  const targetCanonical = canonicalizePath(candidate);
  if (targetCanonical !== rootCanonical && !targetCanonical.startsWith(`${rootCanonical}${path.sep}`)) {
    throw new Error(`Security error: ${label} "${filePath}" resolves outside workspace (${targetCanonical}).`);
  }
  return targetCanonical;
}

export function resolveWorkspaceRoot(cwd = process.cwd()) {
  const canonicalCwd = canonicalizePath(cwd);
  const gitTop = runSync("git", ["rev-parse", "--show-toplevel"], { cwd: canonicalCwd, timeoutMs: 3000 });
  if (gitTop.status === 0 && String(gitTop.stdout).trim()) {
    return canonicalizePath(String(gitTop.stdout).trim());
  }
  return canonicalCwd;
}

export function resolveCodexHome() {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

export function resolveClaudeHome() {
  return path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
}

export function resolveAgyHome() {
  return path.resolve(process.env.AGY_HOME || path.join(os.homedir(), ".gemini"));
}

export function resolveConfigDir() {
  return path.resolve(
    process.env.TRIRELAY_CONFIG_DIR ||
      path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "trirelay")
  );
}

export function resolveBaseStateRoot() {
  return path.resolve(
    process.env.TRIRELAY_STATE_DIR ||
      path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "trirelay")
  );
}
