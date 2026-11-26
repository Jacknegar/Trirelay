import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  VALID_ENGINES,
  normalizeEngineName,
  resolveClaudeHome,
  resolveCodexHome,
  resolveConfigDir,
  resolveHost
} from "./env.mjs";
import { readJsonSafe } from "./state.mjs";
import { discoverAgyModels } from "./drivers/agy.mjs";
import { readCodexConfigDefaults } from "./drivers/codex.mjs";

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_ROUTING_PATH = path.join(PACKAGE_ROOT, "config", "routing.json");

export const VALID_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const AGY_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CODEX_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export function loadRoutingConfig() {
  const base = readJsonSafe(DEFAULT_ROUTING_PATH, { aliases: {}, profiles: {}, defaults: {}, hostRoleDefaults: {} });
  const overridePath = path.join(resolveConfigDir(), "routing.json");
  const override = readJsonSafe(overridePath, null);
  if (!override) {
    return base;
  }
  return {
    ...base,
    defaults: { ...(base.defaults ?? {}), ...(override.defaults ?? {}) },
    aliases: { ...(base.aliases ?? {}), ...(override.aliases ?? {}) },
    profiles: { ...(base.profiles ?? {}), ...(override.profiles ?? {}) },
    hostRoleDefaults: { ...(base.hostRoleDefaults ?? {}), ...(override.hostRoleDefaults ?? {}) },
    sensitivePathPatterns: Array.isArray(override.sensitivePathPatterns)
      ? override.sensitivePathPatterns
      : base.sensitivePathPatterns ?? []
  };
}

export function discoverCodexModels({ includeHidden = false } = {}) {
  const defaults = readCodexConfigDefaults();
  const cachePath = path.join(resolveCodexHome(), "models_cache.json");
  const cache = readJsonSafe(cachePath, { models: [] });
  const raw = Array.isArray(cache?.models) ? cache.models : [];
  const models = raw
    .filter((item) => includeHidden || item?.visibility === "list")
    .map((item) => ({
      engine: "codex",
      id: item.slug,
      displayName: item.display_name ?? item.slug,
      visibility: item.visibility ?? "list",
      defaultEffort: item.default_reasoning_level ?? null,
      supportedEfforts: Array.isArray(item.supported_reasoning_levels)
        ? item.supported_reasoning_levels.map((x) => x?.effort).filter(Boolean)
        : CODEX_EFFORTS
    }));

  return {
    defaultModel: defaults.model ?? models[0]?.id ?? null,
    defaultEffort: defaults.effort ?? null,
    models
  };
}

export function discoverClaudeModels() {
  const settingsPath = path.join(resolveClaudeHome(), "settings.json");
  const settings = readJsonSafe(settingsPath, {});
  const modelSettings =
    settings?.modelSettings && typeof settings.modelSettings === "object" ? settings.modelSettings : {};

  const defaultAlias = typeof settings?.model === "string" && settings.model.trim() ? settings.model.trim() : "opus";
  const seen = new Set();
  const models = [];

  for (const item of [
    { id: "opus", displayName: "Claude Opus (alias)", defaultEffort: "high" },
    { id: "sonnet", displayName: "Claude Sonnet (alias)", defaultEffort: "high" },
    { id: "haiku", displayName: "Claude Haiku (alias)", defaultEffort: "low" },
    { id: "fable", displayName: "Claude Fable (alias)", defaultEffort: "high" }
  ]) {
    seen.add(item.id);
    models.push({
      engine: "claude",
      id: item.id,
      displayName: item.displayName,
      visibility: "list",
      defaultEffort: item.defaultEffort,
      supportedEfforts: CLAUDE_EFFORTS
    });
  }

  for (const [modelId, cfg] of Object.entries(modelSettings)) {
    if (seen.has(modelId)) continue;
    seen.add(modelId);
    models.push({
      engine: "claude",
      id: modelId,
      displayName: modelId,
      visibility: "list",
      defaultEffort: cfg?.effortLevel ?? "high",
      supportedEfforts: CLAUDE_EFFORTS
    });
  }

  return {
    defaultModel: defaultAlias,
    defaultEffort: modelSettings[defaultAlias]?.effortLevel ?? "high",
    models
  };
}

export function getFullModelCatalog({ includeHidden = false, includeAgyProbe = true } = {}) {
  const routing = loadRoutingConfig();
  const codex = discoverCodexModels({ includeHidden });
  const claude = discoverClaudeModels();
  const agy = includeAgyProbe
    ? discoverAgyModels()
    : { defaultModel: null, defaultEffort: null, models: [] };

  return {
    agy,
    codex,
    claude,
    aliases: routing.aliases ?? {},
    profiles: routing.profiles ?? {},
    hostRoleDefaults: routing.hostRoleDefaults ?? {},
    defaults: routing.defaults ?? {}
  };
}

function inferEngineFromModelName(modelName, catalog) {
  const lower = String(modelName || "").toLowerCase();
  if (!lower) return null;
  if (lower.startsWith("claude") || ["opus", "sonnet", "fable", "haiku"].includes(lower)) {
    return "claude";
  }
  if (lower.startsWith("gemini") || lower.includes("orchestrator") || catalog.agy?.models?.some((m) => m.id.toLowerCase() === lower)) {
    return "agy";
  }
  if (
    lower.startsWith("gpt-") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4") ||
    catalog.codex?.models?.some((m) => m.id.toLowerCase() === lower)
  ) {
    return "codex";
  }
  if (catalog.claude?.models?.some((m) => m.id.toLowerCase() === lower)) {
    return "claude";
  }
  return null;
}

function clampOrValidateEffort(engine, modelId, requestedEffort, catalog, strict = false) {
  if (!requestedEffort) {
    return { effort: null, warning: null };
  }
  const normalized = String(requestedEffort).trim().toLowerCase();
  const pool =
    engine === "codex"
      ? catalog.codex?.models ?? []
      : engine === "claude"
        ? catalog.claude?.models ?? []
        : catalog.agy?.models ?? [];

  const matched = modelId ? pool.find((m) => m.id.toLowerCase() === String(modelId).toLowerCase()) : null;
  const fallbackSupported =
    engine === "codex" ? CODEX_EFFORTS : engine === "claude" ? CLAUDE_EFFORTS : AGY_EFFORTS;
  const supported = matched?.supportedEfforts?.length ? matched.supportedEfforts : fallbackSupported;

  if (supported.includes(normalized)) {
    return { effort: normalized, warning: null };
  }

  if (strict) {
    throw new Error(
      `Effort "${normalized}" is not supported by ${engine}:${modelId || "default"}. Supported: ${supported.join(", ")}.`
    );
  }

  const order =
    normalized === "ultra"
      ? ["max", "xhigh", "high"]
      : normalized === "max"
        ? ["xhigh", "high"]
        : normalized === "none" || normalized === "minimal"
          ? ["low", "medium"]
          : ["high", "medium", "low"];

  const mapped = order.find((candidate) => supported.includes(candidate)) ?? supported[0] ?? null;
  return {
    effort: mapped,
    warning: `Mapped unsupported effort "${normalized}" on ${engine}:${modelId || "default"} -> "${mapped}".`
  };
}

/**
 * Parse a spec such as:
 *   "codex:gpt-6.2-astra@max"
 *   "codex@high"
 *   "claude:opus@high"
 *   "agy@high"
 *   "agy:gemini-4-neon-high"
 *   "opus@high"
 */
export function parseModelSpec(
  spec,
  { defaultEngine = null, explicitEffort = null, strict = false, catalog = null } = {}
) {
  const cat = catalog ?? getFullModelCatalog({ includeHidden: true, includeAgyProbe: false });
  const routing = loadRoutingConfig();

  if (!spec || !String(spec).trim()) {
    const engine = normalizeEngineName(defaultEngine) || "codex";
    const engineCat = cat[engine] ?? {};
    const model = engineCat.defaultModel ?? null;
    const rawEffort = explicitEffort ?? engineCat.defaultEffort ?? null;
    const checked = clampOrValidateEffort(engine, model, rawEffort, cat, strict);
    return {
      engine,
      model,
      effort: checked.effort,
      spec: `${engine}${model ? `:${model}` : ""}${checked.effort ? `@${checked.effort}` : ""}`,
      warning: checked.warning
    };
  }

  let raw = String(spec).trim();
  let specEffort = null;
  const atIdx = raw.lastIndexOf("@");
  if (atIdx > 0) {
    specEffort = raw.slice(atIdx + 1).trim();
    raw = raw.slice(0, atIdx).trim();
  }

  const aliasTarget = routing.aliases?.[raw.toLowerCase()];
  if (aliasTarget) {
    raw = aliasTarget;
  }

  let engine = null;
  let model = null;
  const colonIdx = raw.indexOf(":");
  if (colonIdx > 0) {
    const rawEngine = raw.slice(0, colonIdx).trim();
    engine = normalizeEngineName(rawEngine);
    if (!engine) {
      throw new Error(`Unsupported engine "${rawEngine}" in spec "${spec}". Valid engines: ${VALID_ENGINES.join(", ")}.`);
    }
    const rawModel = raw.slice(colonIdx + 1).trim();
    if (rawModel) {
      const innerAlias = routing.aliases?.[rawModel.toLowerCase()];
      if (innerAlias) {
        model = innerAlias.includes(":") ? innerAlias.split(":", 2)[1] : innerAlias;
      } else {
        model = rawModel;
      }
    }
  } else {
    const maybeEngine = normalizeEngineName(raw);
    if (maybeEngine) {
      engine = maybeEngine;
      model = cat[engine]?.defaultModel ?? null;
    } else {
      model = raw;
      engine = inferEngineFromModelName(model, cat) || normalizeEngineName(defaultEngine);
      if (!engine) {
        throw new Error(`Could not infer engine for model "${model}". Prefix with "agy:", "claude:", or "codex:".`);
      }
    }
  }

  const desiredEffort = explicitEffort ?? specEffort ?? null;
  const checked = clampOrValidateEffort(engine, model, desiredEffort, cat, strict);
  return {
    engine,
    model,
    effort: checked.effort,
    spec: `${engine}${model ? `:${model}` : ""}${checked.effort ? `@${checked.effort}` : ""}`,
    warning: checked.warning
  };
}

export function inferProfileFromPrompt(prompt = "", mode = "readonly") {
  const text = String(prompt || "").toLowerCase();
  if (/\b(ultra|proof|theorem|mathematical|first[- ]principles|root[- ]cause|race condition|deadlock|cuda kernel)\b/.test(text)) {
    return { profile: "ultra", reason: "High-rigor mathematical/kernel/concurrency keywords detected." };
  }
  if (/\b(copy|readme|wording|ux text|label|documentation|prose)\b/.test(text)) {
    return { profile: "docs", reason: "Documentation/copy review keywords detected." };
  }
  if (/\b(architect|architecture|design|plan|spec|rfc|interface|decompose|trade[- ]?off)\b/.test(text)) {
    return { profile: "advisor", reason: "Architecture/design keywords detected." };
  }
  if (/\b(review|audit|adversarial|vulnerability|security|bug hunt|regression|check diff)\b/.test(text)) {
    return { profile: "reviewer", reason: "Review/audit keywords detected." };
  }
  if (/\b(quick|fast|grep|find|list|locate|triage|summarize log)\b/.test(text)) {
    return { profile: "fast", reason: "Low-latency triage/discovery keywords detected." };
  }
  if (mode === "write") {
    return { profile: "implementer", reason: "Write-mode implementation task." };
  }
  return { profile: "advisor", reason: "Default read-only advisory task." };
}

export function oppositeVerifierSpec({ authorEngine = null, host = null, effort = "high", catalog = null } = {}) {
  const currentHost = resolveHost(host);
  const routing = loadRoutingConfig();
  const hostDefaults = routing.hostRoleDefaults?.[currentHost] ?? routing.hostRoleDefaults?.cli ?? {};
  const candidates = [
    hostDefaults.reviewer,
    hostDefaults.secondReviewer,
    hostDefaults.advisor,
    ...VALID_ENGINES
  ].filter(Boolean);

  const chosen =
    candidates.find((eng) => eng !== authorEngine && eng !== currentHost) ||
    candidates.find((eng) => eng !== authorEngine);

  if (!chosen) {
    throw new Error(`Cannot select an independent verifier distinct from authorEngine="${authorEngine}".`);
  }
  return parseModelSpec(`${chosen}@${effort}`, { catalog });
}

export function resolveRoute({
  profile = null,
  spec = null,
  engine = null,
  model = null,
  effort = null,
  prompt = "",
  mode = "readonly",
  host = null,
  excludeHost = true,
  authorEngine = null,
  strict = false
} = {}) {
  const catalog = getFullModelCatalog({ includeHidden: true, includeAgyProbe: false });
  const routing = loadRoutingConfig();
  const activeHost = resolveHost(host);

  // 1. Explicit spec/engine/model wins unconditionally and NEVER falls back to a different provider.
  if (spec || model || engine) {
    let normEngine = null;
    if (engine) {
      normEngine = normalizeEngineName(engine);
      if (!normEngine) {
        throw new Error(`Invalid engine "${engine}". Valid engines: ${VALID_ENGINES.join(", ")}.`);
      }
    }

    const combinedSpec = spec
      ? spec
      : model
        ? `${normEngine ? `${normEngine}:` : ""}${model}`
        : `${normEngine}`;

    const primary = parseModelSpec(combinedSpec, {
      defaultEngine: normEngine,
      explicitEffort: effort,
      strict,
      catalog
    });

    return {
      source: "explicit",
      host: activeHost,
      profile: profile ?? null,
      reason: "Explicit engine, model, or spec (no cross-provider fallback).",
      primary,
      fallback: [],
      fanout: null
    };
  }

  // 2. Opposite-engine verifier (never falls back to authorEngine or active host)
  if (profile === "opposite-verifier") {
    const primary = oppositeVerifierSpec({
      authorEngine: normalizeEngineName(authorEngine),
      host: activeHost,
      effort: effort || "high",
      catalog
    });
    const secondary = VALID_ENGINES.find(
      (eng) => eng !== normalizeEngineName(authorEngine) && eng !== primary.engine && eng !== activeHost
    );
    return {
      source: "cross-verifier",
      host: activeHost,
      profile: "opposite-verifier",
      reason: `Independent verifier distinct from authorEngine="${authorEngine || "none"}" (host=${activeHost}).`,
      primary,
      fallback: secondary ? [parseModelSpec(`${secondary}@${effort || "high"}`, { catalog })] : [],
      fanout: null
    };
  }

  // 3. Profile resolution
  let chosenProfile = profile;
  let reason = `Matched routing profile "${profile}".`;
  if (!chosenProfile || chosenProfile === "auto") {
    const inferred = inferProfileFromPrompt(prompt, mode);
    chosenProfile = inferred.profile;
    reason = inferred.reason;
  }

  const profileDef = routing.profiles?.[chosenProfile];
  if (!profileDef) {
    const available = Object.keys(routing.profiles ?? {}).join(", ");
    throw new Error(`Unknown routing profile "${chosenProfile}". Available: ${available}.`);
  }

  const shouldExclude = excludeHost && activeHost !== "cli";

  if (Array.isArray(profileDef.fanout) && profileDef.fanout.length > 0) {
    let parsedFanout = profileDef.fanout.map((item) =>
      parseModelSpec(item, { explicitEffort: effort, strict, catalog })
    );
    if (shouldExclude) {
      const filtered = parsedFanout.filter((item) => item.engine !== activeHost);
      if (filtered.length > 0) {
        parsedFanout = filtered;
      }
    }
    return {
      source: "profile-fanout",
      host: activeHost,
      profile: chosenProfile,
      reason: `${reason} (host=${activeHost}, excludeHost=${shouldExclude})`,
      primary: parsedFanout[0],
      fallback: [],
      fanout: parsedFanout
    };
  }

  const hostRoleMap = routing.hostRoleDefaults?.[activeHost] ?? {};
  const hostPreferredEngine = profileDef.roleKind ? hostRoleMap[profileDef.roleKind] : null;

  let candidates = (profileDef.candidates ?? []).map((item) =>
    parseModelSpec(item, { explicitEffort: effort, strict, catalog })
  );

  if (shouldExclude) {
    const nonHost = candidates.filter((c) => c.engine !== activeHost);
    if (nonHost.length > 0) {
      candidates = nonHost;
    }
  }

  if (hostPreferredEngine) {
    const idx = candidates.findIndex((c) => c.engine === hostPreferredEngine);
    if (idx > 0) {
      const [preferred] = candidates.splice(idx, 1);
      candidates.unshift(preferred);
    } else if (idx === -1 && (!shouldExclude || hostPreferredEngine !== activeHost)) {
      candidates.unshift(parseModelSpec(`${hostPreferredEngine}@${effort || "high"}`, { strict, catalog }));
    }
  }

  if (candidates.length === 0) {
    throw new Error(`No eligible engine candidates for profile "${chosenProfile}" under host="${activeHost}".`);
  }

  return {
    source: "profile",
    host: activeHost,
    profile: chosenProfile,
    reason: `${reason} (host=${activeHost})`,
    primary: candidates[0],
    fallback: candidates.slice(1),
    fanout: null
  };
}
