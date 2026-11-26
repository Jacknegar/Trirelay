#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { checkAgyHealth } from "../core/drivers/agy.mjs";
import { checkClaudeHealth } from "../core/drivers/claude.mjs";
import { checkCodexHealth } from "../core/drivers/codex.mjs";
import { resolveHost, resolveWorkspaceRoot } from "../core/env.mjs";
import { createHandoffPacket, listWorkspaceClaudeSessions, loadHandoffPacket } from "../core/handoff.mjs";
import { executeInstall } from "../core/installer.mjs";
import { handleJobControl } from "../core/jobs.mjs";
import {
  assertRecursionSafe,
  inspectReviewArtifact,
  runCopyReview,
  runDualDesign,
  runDualReview,
  runOrchestration,
  runReviewGate,
  runSingleTask
} from "../core/orchestrator.mjs";
import { getFullModelCatalog, resolveRoute } from "../core/router.mjs";
import { postBoardMessage, readActiveBoardPins, readBoardPosts, readBoardPostsBySeqs } from "../core/state.mjs";
import { applyJobPatch } from "../core/worktree.mjs";

const BOOLEAN_FLAGS = new Set([
  "json",
  "all",
  "write",
  "worktree",
  "no-worktree",
  "handoff",
  "host-digest",
  "repo-handoff",
  "board-digest",
  "no-board-digest",
  "resume-role",
  "fork",
  "strict",
  "native",
  "cross-critique",
  "cross-verify",
  "no-cross-verify",
  "reset",
  "apply",
  "dry-run",
  "no-exclude-host",
  "no-compact",
  "pins-only"
]);

function parseArgs(argv) {
  const options = {};
  const positionals = [];
  const multi = new Set([
    "model-list",
    "owned-file",
    "forbidden-file",
    "invariant",
    "decision",
    "do-not-relitigate",
    "supersede",
    "deprecate-invariant",
    "criterion",
    "context"
  ]);

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const eqIdx = token.indexOf("=");
    if (eqIdx !== -1) {
      const key = token.slice(2, eqIdx);
      const val = token.slice(eqIdx + 1);
      if (multi.has(key)) {
        options[key] = options[key] || [];
        options[key].push(val);
      } else {
        options[key] = val === "false" ? false : val === "true" ? true : val;
      }
      continue;
    }
    const key = token.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      options[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      if (multi.has(key)) {
        options[key] = options[key] || [];
        options[key].push(next);
      } else {
        options[key] = next;
      }
      i += 1;
    } else {
      options[key] = true;
    }
  }
  return { options, positionals };
}

function readJsonArg(rawOrPath, cwd) {
  if (!rawOrPath) return null;
  const str = String(rawOrPath).trim();
  if (str.startsWith("{") || str.startsWith("[")) {
    return JSON.parse(str);
  }
  return JSON.parse(fs.readFileSync(path.resolve(cwd, str), "utf8"));
}

function printOutput(data, asJson = false) {
  if (asJson) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (typeof data === "string") {
    process.stdout.write(data.endsWith("\n") ? data : `${data}\n`);
    return;
  }
  console.log(JSON.stringify(data, null, 2));
}

function printUsage() {
  console.log(
    [
      "Usage: trirelay <subcommand> [options]",
      "",
      "Subcommands:",
      "  doctor [--host agy|claude|codex|cli] [--cwd <dir>] [--json]",
      "  models [--all] [--json]",
      "  route [--host <h>] [--profile <p>] [--spec <engine:model@effort>] [--engine <agy|claude|codex>] [prompt]",
      "  run [--engine <agy|claude|codex>] [--model <m>] [--effort <e>] [--spec <s>] [--profile <p>] [--write] [--worktree|--no-worktree] [--handoff] [--board-digest] [--resume-role] [--fork] [--timeout <ms>] [--json] [prompt]",
      "  review [--engine <both|agy|claude|codex>] [--scope <auto|working-tree|branch>] [--base <ref>] [--effort <e>] [--native] [--json] [focus]",
      "  review-gate [--gate-key <k>] [--max-rounds 2] [--reset] [--engine <both|...>] [focus]",
      "  design start|submit-host|reveal [--id <designId>] [--context <path>] [--draft-file <path>] [requirement|draft]",
      "  copy-review [--file <path>] [--audience <a>] [--purpose <p>] [--json] [content]",
      "  teamwork [--goal <text>] [--tasks-file <json>] [--no-cross-verify] [--json]",
      "  boost [--models <s1,s2,...>] [--cross-critique] [--json] [prompt]",
      "  swarm --workers-file <json> [--workflow <w>] [--json]",
      "  pipeline --stages-file <json> [--workflow <w>] [--json]",
      "  apply <jobId> [--mode check|apply] [--json]",
      "  handoff create|inspect|sessions [options]",
      "  board read|post [--board <id>] [--view tiered|full] [--since <seq>] [--author <a>] [--tag <t>] [text]",
      "  jobs [list|status|wait|result|cancel] [jobId] [--wait-ms <ms>] [--no-compact] [--json]",
      "  install [--host all|agy|claude|codex] [--dry-run | --apply] [--json]"
    ].join("\n")
  );
}

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  if (!sub || sub === "help" || sub === "--help") {
    printUsage();
    return;
  }

  const { options, positionals } = parseArgs(rest);
  const cwd = resolveWorkspaceRoot(options.cwd || process.cwd());
  const asJson = Boolean(options.json);
  const host = options.host || undefined;

  switch (sub) {
    case "doctor":
    case "setup": {
      const detectedHost = resolveHost(host);
      const [agy, claude, codex] = await Promise.all([
        Promise.resolve(checkAgyHealth(cwd)),
        Promise.resolve(checkClaudeHealth(cwd)),
        Promise.resolve(checkCodexHealth(cwd))
      ]);
      const availableEngines = [agy.ready && "agy", claude.ready && "claude", codex.ready && "codex"].filter(Boolean);
      const payload = {
        ready: availableEngines.length >= 2,
        allThreeReady: Boolean(agy.ready && claude.ready && codex.ready),
        host: detectedHost,
        availableEngines,
        workspaceRoot: cwd,
        agy,
        claude,
        codex
      };
      printOutput(payload, true);
      if (!payload.ready) process.exitCode = 1;
      break;
    }

    case "models": {
      printOutput(getFullModelCatalog({ includeHidden: Boolean(options.all), includeAgyProbe: true }), true);
      break;
    }

    case "route": {
      const res = resolveRoute({
        host,
        excludeHost: !options["no-exclude-host"],
        profile: options.profile,
        spec: options.spec,
        engine: options.engine,
        model: options.model,
        effort: options.effort,
        mode: options.write ? "write" : options.mode || "readonly",
        authorEngine: options["author-engine"],
        strict: Boolean(options.strict),
        prompt: positionals.join(" ")
      });
      printOutput(res, true);
      break;
    }

    case "run": {
      const prompt = options["prompt-file"]
        ? fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8")
        : positionals.join(" ");
      const mode = options.write ? "write" : options.mode || "readonly";
      const res = await runSingleTask(cwd, {
        host,
        excludeHost: !options["no-exclude-host"],
        prompt,
        role: options.role || "worker",
        workflowId: options.workflow || "default",
        boardId: options.board || undefined,
        profile: options.profile,
        spec: options.spec,
        engine: options.engine,
        model: options.model,
        effort: options.effort,
        mode,
        worktree: mode === "write" ? true : Boolean(options.worktree),
        handoff: Boolean(options.handoff),
        handoffId: options["handoff-id"],
        parentHandoffId: options["parent-handoff"],
        includeHostDigest: Boolean(options["host-digest"]),
        includeRepoHandoff: Boolean(options["repo-handoff"]),
        includeBoardDigest: options["no-board-digest"] ? false : options["board-digest"] ? true : undefined,
        resumeRole: Boolean(options["resume-role"]),
        resumeSessionId: options["resume-session"],
        forkSession: Boolean(options.fork),
        timeoutMs: options.timeout ? Number(options.timeout) : undefined,
        ownedFiles: options["owned-file"] ?? [],
        forbiddenFiles: options["forbidden-file"] ?? ["docs/handoff.md"],
        invariants: options.invariant ?? [],
        decisionsMade: options.decision ?? [],
        doNotRelitigate: options["do-not-relitigate"] ?? [],
        supersededDecisions: options.supersede ?? [],
        deprecatedInvariants: options["deprecate-invariant"] ?? [],
        acceptanceCriteria: options.criterion ?? []
      });
      printOutput(asJson ? res : res.output || res.error || "", asJson);
      if (!res.ok) process.exitCode = 1;
      break;
    }

    case "review": {
      if (positionals[0] === "inspect" || options["review-id"]) {
        const res = inspectReviewArtifact(cwd, {
          reviewId: options["review-id"] || positionals[1],
          offset: options.offset ? Number(options.offset) : 0,
          limit: options.limit ? Number(options.limit) : 10,
          severity: options.severity || null
        });
        printOutput(res, true);
        break;
      }
      const res = await runDualReview(cwd, {
        host,
        engine: options.engine || "both",
        scope: options.scope || "auto",
        base: options.base || null,
        model: options.model || null,
        effort: options.effort || undefined,
        native: Boolean(options.native),
        focus: positionals.join(" ")
      });
      printOutput(res, true);
      if (!res.ok) process.exitCode = 1;
      break;
    }

    case "review-gate": {
      const res = await runReviewGate(cwd, {
        host,
        gateKey: options["gate-key"] || options.workflow || "default-gate",
        maxRounds: options["max-rounds"] ? Number(options["max-rounds"]) : undefined,
        reset: Boolean(options.reset),
        engine: options.engine || "both",
        scope: options.scope || "auto",
        base: options.base || null,
        effort: options.effort || undefined,
        timeoutMs: options.timeout ? Number(options.timeout) : undefined,
        focus: positionals.join(" ")
      });
      printOutput(res, true);
      if (!res.ok) process.exitCode = 1;
      break;
    }

    case "design": {
      const rawAction = positionals[0] || "start";
      const action = rawAction === "submit-host" ? "submit_host" : rawAction;
      const res = await runDualDesign(cwd, {
        action,
        host,
        designId: options.id || options["design-id"],
        requirement: action === "start" ? options.requirement || positionals.slice(1).join(" ") : undefined,
        contextPaths: options.context ?? [],
        advisorSpec: options["advisor-spec"],
        hostDraft: action === "submit_host" ? options.draft || positionals.slice(1).join(" ") : undefined,
        hostDraftPath: options["draft-file"]
      });
      printOutput(res, true);
      if (!res.ok) process.exitCode = 1;
      break;
    }

    case "copy-review": {
      const res = await runCopyReview(cwd, {
        host,
        content: positionals.join(" "),
        filePath: options.file,
        audience: options.audience,
        purpose: options.purpose,
        advisorSpec: options["advisor-spec"]
      });
      printOutput(res, true);
      if (!res.ok) process.exitCode = 1;
      break;
    }

    case "boost": {
      const models = options.models
        ? String(options.models).split(",").map((s) => s.trim()).filter(Boolean)
        : options["model-list"] ?? undefined;
      const res = await runOrchestration(cwd, {
        host,
        pattern: "boost",
        workflowId: options.workflow,
        models,
        crossCritique: Boolean(options["cross-critique"]),
        timeoutMs: options.timeout ? Number(options.timeout) : undefined,
        includeHostDigest: Boolean(options["host-digest"]),
        includeRepoHandoff: Boolean(options["repo-handoff"]),
        prompt: options.prompt || positionals.join(" ")
      });
      printOutput(res, true);
      if (!res.ok) process.exitCode = 1;
      break;
    }

    case "teamwork": {
      const tasks = options["tasks-file"] ? readJsonArg(options["tasks-file"], cwd) : undefined;
      const res = await runOrchestration(cwd, {
        host,
        pattern: "teamwork",
        workflowId: options.workflow,
        goal: options.goal || positionals.join(" "),
        tasks,
        crossVerify: options["no-cross-verify"] ? false : true,
        architectProfile: options["architect-profile"],
        architectSpec: options["architect-spec"],
        verifierSpec: options["verifier-spec"]
      });
      printOutput(res, true);
      if (!res.ok) process.exitCode = 1;
      break;
    }

    case "swarm": {
      const workers = readJsonArg(options["workers-file"], cwd);
      const res = await runOrchestration(cwd, {
        host,
        pattern: "swarm",
        workflowId: options.workflow,
        workers
      });
      printOutput(res, true);
      if (!res.ok) process.exitCode = 1;
      break;
    }

    case "pipeline": {
      const stages = readJsonArg(options["stages-file"], cwd);
      const res = await runOrchestration(cwd, {
        host,
        pattern: "pipeline",
        workflowId: options.workflow,
        stages
      });
      printOutput(res, true);
      if (!res.ok) process.exitCode = 1;
      break;
    }

    case "apply": {
      const jobId = positionals[0] || options.id;
      if (!jobId) throw new Error("Usage: trirelay apply <jobId> [--mode check|apply]");
      const detail = await handleJobControl(cwd, { action: "result", jobId });
      printOutput(applyJobPatch(cwd, detail.job, { mode: options.mode || "check" }), true);
      break;
    }

    case "handoff": {
      const action = positionals[0];
      if (action === "create") {
        printOutput(
          createHandoffPacket(cwd, {
            workflowId: options.workflow || "default",
            parentHandoffId: options["parent-handoff"] || null,
            fromHost: options.from || resolveHost(host),
            toEngine: options.to || "codex",
            role: options.role || "worker",
            goal: options.goal || positionals.slice(1).join(" "),
            ownedFiles: options["owned-file"] ?? [],
            forbiddenFiles: options["forbidden-file"] ?? ["docs/handoff.md"],
            invariants: options.invariant ?? [],
            decisionsMade: options.decision ?? [],
            doNotRelitigate: options["do-not-relitigate"] ?? [],
            supersededDecisions: options.supersede ?? [],
            deprecatedInvariants: options["deprecate-invariant"] ?? [],
            acceptanceCriteria: options.criterion ?? [],
            includeHostDigest: Boolean(options["host-digest"]),
            includeRepoHandoff: Boolean(options["repo-handoff"]),
            includeBoardDigest: Boolean(options["board-digest"]),
            boardId: options.board || options.workflow || "default"
          }),
          true
        );
      } else if (action === "inspect") {
        const packet = loadHandoffPacket(cwd, options.id || positionals[1]);
        if (!packet) throw new Error("Handoff packet not found.");
        printOutput(packet, true);
      } else if (action === "sessions") {
        printOutput({ workspaceRoot: cwd, sessions: listWorkspaceClaudeSessions(cwd) }, true);
      } else {
        throw new Error("Usage: trirelay handoff create|inspect|sessions [options]");
      }
      break;
    }

    case "board": {
      const action = positionals[0] || "read";
      const boardId = options.board || "default";
      if (action === "read") {
        if (options["pins-only"]) {
          printOutput({ boardId, view: "pinsOnly", pins: readActiveBoardPins(cwd, boardId) }, true);
          break;
        }
        if (options.seqs) {
          const seqs = String(options.seqs).split(",").map((s) => Number(s.trim())).filter(Number.isFinite);
          printOutput({ boardId, view: "seqs", posts: readBoardPostsBySeqs(cwd, boardId, seqs) }, true);
          break;
        }
        const view = options.view || "tiered";
        if (view === "full") {
          const fullLimit = options.limit !== undefined ? Number(options.limit) : 0;
          const posts = readBoardPosts(cwd, boardId, {
            since: Number(options.since || 0),
            limit: fullLimit
          });
          printOutput({ boardId, view: "full", posts }, true);
        } else {
          const posts = readBoardPosts(cwd, boardId, {
            since: Number(options.since || 0),
            limit: Number(options.limit || 100)
          });
          const activePins = readActiveBoardPins(cwd, boardId);
          const { buildTieredBoardView } = await import("../core/compact.mjs");
          printOutput(buildTieredBoardView(posts, { pinnedPosts: activePins, boardId }), true);
        }
      } else if (action === "post") {
        printOutput(
          postBoardMessage(cwd, boardId, {
            author: options.author || "coordinator",
            tag: options.tag || "[update]",
            text: options.text || positionals.slice(1).join(" "),
            pinId: options["pin-id"],
            supersedes: options.supersedes
          }),
          true
        );
      } else {
        throw new Error("Usage: trirelay board read|post [options]");
      }
      break;
    }

    case "jobs": {
      const first = positionals[0];
      const knownActions = new Set(["list", "status", "wait", "result", "cancel"]);
      const action = knownActions.has(first) ? first : first ? "result" : "list";
      const jobId = knownActions.has(first) ? positionals[1] || options.id : first || options.id;
      const res = await handleJobControl(cwd, {
        action,
        jobId,
        waitTimeoutMs: options["wait-ms"] ? Number(options["wait-ms"]) : undefined
      });
      printOutput(res, true);
      break;
    }

    case "install": {
      const rawHost = String(options.host || "all").toLowerCase();
      const hosts = rawHost === "all" ? ["agy", "claude", "codex"] : rawHost.split(",").map((s) => s.trim()).filter(Boolean);
      const res = executeInstall({
        hosts,
        apply: Boolean(options.apply) && !options["dry-run"]
      });
      printOutput(res, true);
      if (!res.ok) process.exitCode = 1;
      break;
    }

    default:
      throw new Error(`Unknown subcommand: ${sub}`);
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
