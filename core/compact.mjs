import process from "node:process";

export const DEFAULT_MCP_MAX_BYTES = 8500;
export const PINNED_BOARD_TAGS = new Set(["[decision]", "[pin]", "[blocker]"]);

export function resolveMcpMaxBytes(override = null) {
  const raw = override ?? process.env.TRIRELAY_MCP_MAX_BYTES;
  if (raw == null || raw === "") {
    return DEFAULT_MCP_MAX_BYTES;
  }
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MCP_MAX_BYTES;
  }
  return Math.max(1024, Math.min(65536, parsed));
}

export function sliceUtf8Bytes(text, maxBytes) {
  const str = String(text ?? "");
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  const limit = Math.trunc(maxBytes);
  if (limit <= 0) return "";
  if (Buffer.byteLength(str, "utf8") <= limit) return str;

  let bytes = 0;
  let endIndex = 0;
  for (let i = 0; i < str.length; ) {
    const cp = str.codePointAt(i);
    const unitLen = cp > 0xffff ? 2 : 1;
    const chBytes = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (bytes + chBytes > limit) break;
    bytes += chBytes;
    i += unitLen;
    endIndex = i;
  }
  return str.slice(0, endIndex);
}

export function truncateWithByteNotice(text, maxBytes) {
  const str = String(text ?? "");
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  const limit = Math.trunc(maxBytes);
  const totalBytes = Buffer.byteLength(str, "utf8");
  if (totalBytes <= limit) return str;

  if (limit < 56) {
    if (limit <= 3) return sliceUtf8Bytes(str, limit);
    return `${sliceUtf8Bytes(str, limit - 3)}...`;
  }

  const maxNoticeBytes = Buffer.byteLength(
    `\n... [truncated: showed ${totalBytes} of ${totalBytes} bytes]`,
    "utf8"
  );
  const cutoffBytes = Math.max(0, limit - maxNoticeBytes);
  if (cutoffBytes < 8) {
    return `${sliceUtf8Bytes(str, limit - 3)}...`;
  }

  let slice = sliceUtf8Bytes(str, cutoffBytes);
  const lastNewline = slice.lastIndexOf("\n");
  if (lastNewline > 0 && Buffer.byteLength(slice.slice(0, lastNewline), "utf8") > cutoffBytes * 0.6) {
    slice = slice.slice(0, lastNewline);
  }
  const shownBytes = Buffer.byteLength(slice, "utf8");
  const result = `${slice}\n... [truncated: showed ${shownBytes} of ${totalBytes} bytes]`;
  return Buffer.byteLength(result, "utf8") <= limit ? result : sliceUtf8Bytes(result, limit);
}

export function formatBoardStub(post, maxSummaryChars = 120) {
  const collapsed = String(post?.text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  let summary = collapsed;
  if (collapsed.length > maxSummaryChars) {
    const cut = Math.max(16, maxSummaryChars - 3);
    // Respect surrogate pairs if slicing inside astral characters.
    let end = cut;
    const code = collapsed.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) {
      end -= 1;
    }
    summary = `${collapsed.slice(0, end)}...`;
  }
  return {
    seq: post?.seq ?? null,
    author: post?.author ?? "unknown",
    tag: post?.tag ?? "[update]",
    summary,
    stub: true,
    ...(post?.handoffId ? { handoffId: post.handoffId } : {}),
    ...(post?.patchPath ? { patchPath: post.patchPath } : {})
  };
}

export function buildTieredBoardView(
  posts = [],
  { recentFull = 3, maxStubChars = 120, maxBytes = 2400, boardId = "default" } = {}
) {
  const list = Array.isArray(posts) ? posts : [];
  if (list.length === 0) {
    return {
      view: "tiered",
      boardId,
      totalPosts: 0,
      pinnedCount: 0,
      stubCount: 0,
      recentCount: 0,
      posts: [],
      recallHint: `relay_board(action="read", boardId="${boardId}", view="full")`
    };
  }

  const recentStart = Math.max(0, list.length - Math.max(0, recentFull));
  const items = list.map((p, idx) => {
    const tagLower = String(p?.tag ?? "").toLowerCase();
    const isPinned = PINNED_BOARD_TAGS.has(tagLower);
    const isRecent = idx >= recentStart;
    if (isPinned || isRecent) {
      return {
        pinned: isPinned,
        recent: isRecent,
        entry: {
          seq: p?.seq ?? null,
          timestamp: p?.timestamp ?? null,
          author: p?.author ?? "unknown",
          tag: p?.tag ?? "[update]",
          ...(Array.isArray(p?.mentions) && p.mentions.length > 0 ? { mentions: p.mentions } : {}),
          text: truncateWithByteNotice(String(p?.text ?? ""), 400),
          ...(p?.handoffId ? { handoffId: p.handoffId } : {}),
          ...(p?.patchPath ? { patchPath: p.patchPath } : {}),
          ...(p?.model ? { model: p.model } : {}),
          ...(isPinned ? { pinned: true } : {})
        }
      };
    }
    return {
      pinned: false,
      recent: false,
      entry: formatBoardStub(p, maxStubChars)
    };
  });

  const fitsBudget = (arr) => Buffer.byteLength(JSON.stringify(arr), "utf8") <= maxBytes;

  // Phase 1: convert non-pinned recent full posts (oldest first) into stubs if needed.
  let active = items;
  if (!fitsBudget(active.map((i) => i.entry))) {
    active = active.map((i) => {
      if (!i.pinned && !i.entry.stub) {
        return { ...i, entry: formatBoardStub(i.entry, maxStubChars) };
      }
      return i;
    });
  }

  // Phase 2: drop oldest non-pinned stubs until within budget (never drop pinned decisions first).
  while (active.length > 0 && !fitsBudget(active.map((i) => i.entry))) {
    const dropIdx = active.findIndex((i) => !i.pinned);
    if (dropIdx === -1) break;
    active = [...active.slice(0, dropIdx), ...active.slice(dropIdx + 1)];
  }

  // Phase 3: if even pinned posts exceed maxBytes, tighten pinned fields proportionally, then trim oldest.
  if (!fitsBudget(active.map((i) => i.entry))) {
    const perPinnedBudget = Math.max(48, Math.floor(maxBytes / Math.max(1, active.length)) - 64);
    active = active.map((i) => {
      const e = { ...i.entry };
      if (e.author && Buffer.byteLength(e.author, "utf8") > 48) {
        e.author = truncateWithByteNotice(e.author, 48);
      }
      if (e.tag && Buffer.byteLength(e.tag, "utf8") > 24) {
        e.tag = truncateWithByteNotice(e.tag, 24);
      }
      if (e.patchPath && Buffer.byteLength(e.patchPath, "utf8") > 96) {
        e.patchPath = truncateWithByteNotice(e.patchPath, 96);
      }
      if (e.text) {
        e.text = truncateWithByteNotice(e.text, perPinnedBudget);
      }
      if (e.summary) {
        e.summary = truncateWithByteNotice(e.summary, perPinnedBudget);
      }
      return { ...i, entry: e };
    });
    while (active.length > 1 && !fitsBudget(active.map((i) => i.entry))) {
      active.shift();
    }
    // Guarantee single remaining entry still fits inside maxBytes.
    if (active.length === 1 && !fitsBudget(active.map((i) => i.entry))) {
      const e = active[0].entry;
      const room = Math.max(24, maxBytes - 160);
      active[0] = {
        ...active[0],
        entry: {
          seq: e.seq ?? null,
          tag: sliceUtf8Bytes(String(e.tag ?? "[pin]"), 24),
          author: sliceUtf8Bytes(String(e.author ?? "worker"), 32),
          ...(e.text ? { text: truncateWithByteNotice(e.text, room) } : { summary: truncateWithByteNotice(String(e.summary ?? ""), room) }),
          ...(e.pinned ? { pinned: true } : {})
        }
      };
      if (!fitsBudget(active.map((i) => i.entry))) {
        active = [];
      }
    }
  }

  const finalEntries = active.map((i) => i.entry);
  return {
    view: "tiered",
    boardId,
    totalPosts: list.length,
    pinnedCount: active.filter((i) => i.pinned).length,
    stubCount: finalEntries.filter((e) => e.stub).length,
    recentCount: finalEntries.filter((e) => !e.stub).length,
    posts: finalEntries,
    recallHint: `relay_board(action="read", boardId="${boardId}", view="full")`
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildRecallPointer(toolName, payload) {
  const jobId = payload?.jobId || payload?.job?.id;
  if (jobId) {
    return `relay_jobs(action="result", jobId="${jobId}", compact=false)`;
  }
  if (payload?.handoffId || payload?.packet?.handoffId) {
    const hid = payload?.handoffId || payload?.packet?.handoffId;
    return `relay_handoff(action="inspect", handoffId="${hid}")`;
  }
  if (payload?.boardId) {
    return `relay_board(action="read", boardId="${payload.boardId}", view="full")`;
  }
  return toolName ? `Re-run ${toolName} with narrower scope or read artifacts directly.` : "Inspect artifact paths directly.";
}

function shrinkBulkyStrings(obj, perFieldBytes, stripStructuredOutput = false) {
  if (!obj || typeof obj !== "object") return obj;

  const stringFields = ["output", "rawOutput", "logTail", "hostDraft", "diff", "contextDigest", "text"];
  for (const field of stringFields) {
    if (typeof obj[field] === "string" && Buffer.byteLength(obj[field], "utf8") > perFieldBytes) {
      obj[field] = truncateWithByteNotice(obj[field], perFieldBytes);
    }
  }

  if (stripStructuredOutput && "structuredOutput" in obj && obj.structuredOutput != null) {
    delete obj.structuredOutput;
  }

  for (const nestedKey of ["job", "result", "advisor", "verification", "packet", "architect"]) {
    if (obj[nestedKey] && typeof obj[nestedKey] === "object") {
      shrinkBulkyStrings(obj[nestedKey], perFieldBytes, stripStructuredOutput);
    }
  }

  for (const arrKey of ["reviews", "perspectives", "critiques", "stages", "workers", "posts", "findings", "blockingFindings", "advisoryFindings"]) {
    if (Array.isArray(obj[arrKey])) {
      for (const item of obj[arrKey]) {
        if (item && typeof item === "object") {
          shrinkBulkyStrings(item, perFieldBytes, stripStructuredOutput);
        }
      }
    }
  }

  return obj;
}

function buildMinimalSummary(toolName, payload, originalBytes, maxBytes) {
  const recallFull = buildRecallPointer(toolName, payload);
  const rawJobId = payload?.jobId || payload?.job?.id || null;
  const rawHandoffId = payload?.handoffId || payload?.packet?.handoffId || null;
  const rawPatchPath = payload?.patchPath || payload?.job?.patchPath || null;

  const base = {
    ...(typeof payload?.ok === "boolean" ? { ok: payload.ok } : {}),
    ...(payload?.status ? { status: sliceUtf8Bytes(String(payload.status), 32) } : {}),
    ...(rawJobId ? { jobId: sliceUtf8Bytes(String(rawJobId), 96) } : {}),
    ...(rawHandoffId ? { handoffId: sliceUtf8Bytes(String(rawHandoffId), 96) } : {}),
    ...(rawPatchPath ? { patchPath: truncateWithByteNotice(String(rawPatchPath), Math.min(200, Math.floor(maxBytes / 4))) } : {}),
    ...(payload?.verdict ? { verdict: sliceUtf8Bytes(String(payload.verdict), 32) } : {}),
    ...(payload?.decision ? { decision: sliceUtf8Bytes(String(payload.decision), 32) } : {}),
    ...(payload?.designId ? { designId: sliceUtf8Bytes(String(payload.designId), 96) } : {}),
    ...(payload?.gateKey ? { gateKey: sliceUtf8Bytes(String(payload.gateKey), 96) } : {}),
    ...(payload?.sessionId ? { sessionId: sliceUtf8Bytes(String(payload.sessionId), 96) } : {}),
    ...(payload?.durationMs != null ? { durationMs: payload.durationMs } : {}),
    ...(Array.isArray(payload?.changedFiles) ? { changedFiles: payload.changedFiles.slice(0, 8).map((f) => sliceUtf8Bytes(String(f), 80)) } : {}),
    ...(Array.isArray(payload?.scopeViolations) && payload.scopeViolations.length
      ? { scopeViolations: payload.scopeViolations.slice(0, 3).map((v) => sliceUtf8Bytes(String(v), 100)) }
      : {}),
    ...(payload?.error ? { error: truncateWithByteNotice(payload.error, Math.min(240, Math.floor(maxBytes / 5))) } : {}),
    _compacted: true,
    _originalBytes: originalBytes,
    _recall: truncateWithByteNotice(recallFull, Math.min(220, Math.floor(maxBytes / 4)))
  };

  if (Buffer.byteLength(JSON.stringify(base), "utf8") <= maxBytes) {
    return base;
  }

  const dropOrder = [
    "changedFiles",
    "scopeViolations",
    "error",
    "patchPath",
    "sessionId",
    "designId",
    "gateKey",
    "durationMs",
    "verdict",
    "decision",
    "status",
    "handoffId",
    "jobId"
  ];
  for (const key of dropOrder) {
    delete base[key];
    if (Buffer.byteLength(JSON.stringify(base), "utf8") <= maxBytes) {
      return base;
    }
  }

  const fixedOverhead = Buffer.byteLength(JSON.stringify({ _compacted: true, _originalBytes: originalBytes, _recall: "" }), "utf8");
  const recallRoom = Math.max(16, maxBytes - fixedOverhead - 8);
  const minimal = {
    _compacted: true,
    _originalBytes: originalBytes,
    _recall: sliceUtf8Bytes(recallFull, recallRoom)
  };
  if (Buffer.byteLength(JSON.stringify(minimal), "utf8") <= maxBytes) {
    return minimal;
  }
  return { _compacted: true };
}

export function compactMcpPayload(toolName, payload, { maxBytes = resolveMcpMaxBytes(), enabled = true } = {}) {
  if (!enabled || payload == null || typeof payload !== "object") {
    return payload;
  }
  const budget = resolveMcpMaxBytes(maxBytes);
  const rawCompact = JSON.stringify(payload);
  const originalBytes = Buffer.byteLength(rawCompact, "utf8");
  if (originalBytes <= budget) {
    return payload;
  }

  // Pass 1: truncate bulky text fields (~700 bytes each), preserving structured arrays/metadata.
  const pass1 = shrinkBulkyStrings(cloneJson(payload), Math.min(700, Math.floor(budget * 0.25)), false);
  pass1._compacted = true;
  pass1._originalBytes = originalBytes;
  pass1._recall = buildRecallPointer(toolName, payload);
  if (Buffer.byteLength(JSON.stringify(pass1), "utf8") <= budget) {
    return pass1;
  }

  // Pass 2: aggressive string cap (~200 bytes) and strip duplicate per-worker structuredOutput.
  const pass2 = shrinkBulkyStrings(cloneJson(payload), Math.min(200, Math.floor(budget * 0.1)), true);
  if (Array.isArray(pass2.posts) && pass2.posts.length > 6) {
    pass2.posts = buildTieredBoardView(pass2.posts, { recentFull: 2, maxBytes: Math.floor(budget * 0.45) }).posts;
  }
  pass2._compacted = true;
  pass2._originalBytes = originalBytes;
  pass2._recall = buildRecallPointer(toolName, payload);
  if (Buffer.byteLength(JSON.stringify(pass2), "utf8") <= budget) {
    return pass2;
  }

  // Pass 3: guaranteed-bounded summary preserving control fields & recall IDs.
  return buildMinimalSummary(toolName, payload, originalBytes, budget);
}

export function serializeMcpPayload(toolName, payload, { maxBytes = resolveMcpMaxBytes(), compact = true } = {}) {
  if (!compact || payload == null || typeof payload !== "object") {
    const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
    return { text, compacted: false, bytes: Buffer.byteLength(text, "utf8") };
  }

  const budget = resolveMcpMaxBytes(maxBytes);
  const pretty = JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(pretty, "utf8") <= budget) {
    return { text: pretty, compacted: false, bytes: Buffer.byteLength(pretty, "utf8") };
  }

  const compactRaw = JSON.stringify(payload);
  if (Buffer.byteLength(compactRaw, "utf8") <= budget) {
    return { text: compactRaw, compacted: false, bytes: Buffer.byteLength(compactRaw, "utf8") };
  }

  const compactedObj = compactMcpPayload(toolName, payload, { maxBytes: budget, enabled: true });
  const text = JSON.stringify(compactedObj);
  return {
    text,
    compacted: Boolean(compactedObj?._compacted),
    bytes: Buffer.byteLength(text, "utf8")
  };
}
