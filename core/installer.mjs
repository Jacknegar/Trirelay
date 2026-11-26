import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalizePath, resolveClaudeHome, resolveCodexHome, resolveExecutable, runSync } from "./env.mjs";

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function isTrirelayManagedLink(destPath, packageRoot) {
  try {
    const lst = fs.lstatSync(destPath);
    if (!lst.isSymbolicLink()) return false;
    return canonicalizePath(destPath) === canonicalizePath(packageRoot) ||
      canonicalizePath(destPath).startsWith(`${canonicalizePath(packageRoot)}${path.sep}`);
  } catch {
    return false;
  }
}

function linkSkillSafely(srcSkillDir, destSkillDir, { force = false } = {}) {
  fs.mkdirSync(path.dirname(destSkillDir), { recursive: true });
  if (fs.existsSync(destSkillDir) || (() => { try { fs.lstatSync(destSkillDir); return true; } catch { return false; } })()) {
    if (isTrirelayManagedLink(destSkillDir, PACKAGE_ROOT)) {
      fs.unlinkSync(destSkillDir);
    } else if (force) {
      throw new Error(`Refusing to overwrite non-symlink skill directory "${destSkillDir}" automatically; move or remove it manually first.`);
    } else {
      return {
        ok: false,
        skipped: true,
        path: destSkillDir,
        reason: `Existing non-managed skill at ${destSkillDir}; leaving untouched.`
      };
    }
  }
  fs.symlinkSync(srcSkillDir, destSkillDir, "dir");
  return { ok: true, method: "symlink", path: destSkillDir };
}

export function planInstall({
  hosts = ["agy", "claude", "codex"],
  homeDir = null,
  packageRoot = PACKAGE_ROOT
} = {}) {
  const effectiveHome = homeDir || os.homedir();
  const codexHome = homeDir ? path.join(effectiveHome, ".codex") : resolveCodexHome();
  const claudeHome = homeDir ? path.join(effectiveHome, ".claude") : resolveClaudeHome();
  const launcherPath = path.join(packageRoot, "scripts", "mcp-launcher.sh");
  const skillsDir = path.join(packageRoot, "skills");
  const skillNames = fs.existsSync(skillsDir)
    ? fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : [];

  const actions = [];

  if (hosts.includes("agy")) {
    const dest = path.join(effectiveHome, ".gemini", "config", "plugins", "trirelay");
    actions.push({
      host: "agy",
      description: `Link Antigravity plugin bundle to ${dest}`,
      target: dest,
      command: `ln -s "${packageRoot}" "${dest}"`
    });
  }

  if (hosts.includes("claude")) {
    const claudeBin = resolveExecutable("claude") || "claude";
    actions.push({
      host: "claude",
      description: "Register Trirelay MCP server, skills, and plugin instructions for Claude Code",
      command: `${claudeBin} mcp add --scope user trirelay -- "${launcherPath}"`,
      pluginMarketplaceHint: `${claudeBin} plugin marketplace add "${packageRoot}" && ${claudeBin} plugin install trirelay`,
      skillsTarget: path.join(claudeHome, "skills"),
      skillNames
    });
  }

  if (hosts.includes("codex")) {
    const codexBin = resolveExecutable("codex") || "codex";
    actions.push({
      host: "codex",
      description: "Register Trirelay MCP server and skills for OpenAI Codex",
      command: `${codexBin} mcp add trirelay -- "${launcherPath}"`,
      skillsTarget: path.join(codexHome, "skills"),
      skillNames
    });
  }

  return {
    platform: process.platform,
    packageRoot,
    launcherPath,
    actions,
    collaborationSnippetPath: path.join(packageRoot, "docs", "collaboration-snippet.md")
  };
}

export function executeInstall({
  hosts = ["agy", "claude", "codex"],
  homeDir = null,
  packageRoot = PACKAGE_ROOT,
  apply = false
} = {}) {
  const plan = planInstall({ hosts, homeDir, packageRoot });
  if (!apply) {
    return {
      ok: true,
      dryRun: true,
      message: "Dry-run preview only. Re-run with `--apply` to install (existing non-symlink directories and global CLAUDE.md/CODEX.md/GEMINI.md are never overwritten).",
      ...plan
    };
  }

  const effectiveHome = homeDir || os.homedir();
  const codexHome = homeDir ? path.join(effectiveHome, ".codex") : resolveCodexHome();
  const claudeHome = homeDir ? path.join(effectiveHome, ".claude") : resolveClaudeHome();
  const results = [];
  const launcherPath = plan.launcherPath;
  const skillsDir = path.join(packageRoot, "skills");

  if (hosts.includes("agy")) {
    const agyPluginsRoot = path.join(effectiveHome, ".gemini", "config", "plugins");
    const dest = path.join(agyPluginsRoot, "trirelay");
    fs.mkdirSync(agyPluginsRoot, { recursive: true });

    if (canonicalizePath(dest) === canonicalizePath(packageRoot)) {
      results.push({ host: "agy", ok: true, method: "in-place", target: dest });
    } else if (fs.existsSync(dest) || (() => { try { fs.lstatSync(dest); return true; } catch { return false; } })()) {
      if (isTrirelayManagedLink(dest, packageRoot)) {
        fs.unlinkSync(dest);
        fs.symlinkSync(packageRoot, dest, "dir");
        results.push({ host: "agy", ok: true, method: "symlink-refreshed", target: dest });
      } else {
        results.push({
          host: "agy",
          ok: false,
          error: `Destination "${dest}" already exists and is not a Trirelay symlink. Remove or back it up manually before installing.`
        });
      }
    } else {
      fs.symlinkSync(packageRoot, dest, "dir");
      results.push({ host: "agy", ok: true, method: "symlink", target: dest });
    }
  }

  if (hosts.includes("claude")) {
    const claudeBin = resolveExecutable("claude");
    let mcpRes = { status: 1, stderr: "claude binary not found", stdout: "" };
    if (claudeBin) {
      mcpRes = runSync(claudeBin, ["mcp", "add", "--scope", "user", "trirelay", "--", launcherPath], {
        timeoutMs: 15000
      });
    }
    const claudeSkillsRoot = path.join(claudeHome, "skills");
    const linked = [];
    for (const name of fs.readdirSync(skillsDir)) {
      const src = path.join(skillsDir, name);
      if (fs.statSync(src).isDirectory()) {
        linked.push(linkSkillSafely(src, path.join(claudeSkillsRoot, name)));
      }
    }
    results.push({
      host: "claude",
      ok: mcpRes.status === 0 && linked.every((l) => l.ok),
      mcpOutput: (mcpRes.stdout || mcpRes.stderr || "").trim(),
      skillsLinked: linked,
      hookNote: `To enable Claude's SessionStart hook too, load the plugin directory with \`claude --plugin-dir "${packageRoot}"\` or add it via \`claude plugin marketplace add "${packageRoot}"\`.`
    });
  }

  if (hosts.includes("codex")) {
    const codexBin = resolveExecutable("codex");
    let mcpRes = { status: 1, stderr: "codex binary not found", stdout: "" };
    if (codexBin) {
      mcpRes = runSync(codexBin, ["mcp", "add", "trirelay", "--", launcherPath], {
        timeoutMs: 15000
      });
    }
    const codexSkillsRoot = path.join(codexHome, "skills");
    const linked = [];
    for (const name of fs.readdirSync(skillsDir)) {
      const src = path.join(skillsDir, name);
      if (fs.statSync(src).isDirectory()) {
        linked.push(linkSkillSafely(src, path.join(codexSkillsRoot, name)));
      }
    }
    results.push({
      host: "codex",
      ok: mcpRes.status === 0 && linked.every((l) => l.ok),
      mcpOutput: (mcpRes.stdout || mcpRes.stderr || "").trim(),
      skillsLinked: linked
    });
  }

  return {
    ok: results.every((r) => r.ok),
    dryRun: false,
    packageRoot,
    results,
    note: `To enable the optional collaboration protocol in your global instructions, review ${plan.collaborationSnippetPath} and include it manually.`
  };
}
