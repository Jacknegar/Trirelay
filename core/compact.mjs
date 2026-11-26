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

/**
 * Build a 3-tier board view (Pin -> Programmatic Stub -> On-Demand Recall).
 * Merges active pins from `pinnedPosts` so early pins survive past sliding windows,
 * avoids silently slicing active pins when within budget, and explicitly reports
 * any omitted or truncated pins with exact recall coordinates.
 */
export function buildTieredBoardView(
  posts = [],
  { pinnedPosts = null, recentFull = 3, maxStubChars = 120, maxBytes = 2400, boardId = "default" } = {}
) {
  const rawPosts = Array.isArray(posts) ? posts : [];
  const activePins = Array.isArray(pinnedPosts) ? pinnedPosts.filter((p) => p && (p.status == null || p.status === "active")) : [];
  const activePinSeqs = new Set(activePins.map((p) => p.seq).filter((s) => s != null));
  const mergedBySeq = new Map();
  for (const p of activePins) {
    if (p?.seq != null) mergedBySeq.set(p.seq, { ...p, _isActivePin: true });
  }
  for (const p of rawPosts) {
    if (!p) continue;
    const key = p.seq ?? Symbol("anon");
    const tagLower = String(p.tag ?? "").toLowerCase();
    const isActivePin =
      pinnedPosts !== null
        ? activePinSeqs.has(p.seq)
        : PINNED_BOARD_TAGS.has(tagLower);
    const prev = mergedBySeq.get(key);
    mergedBySeq.set(key, { ...(prev ?? {}), ...p, _isActivePin: prev?._isActivePin || isActivePin });
  }

  const list = [...mergedBySeq.values()].sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));
  if (list.length === 0) {
    return {
      view: "tiered",
      boardId,
      totalPosts: 0,
      pinnedTotal: 0,
      pinnedShown: 0,
      pinnedCount: 0,
      stubCount: 0,
      recentCount: 0,
      omittedPinnedCount: 0,
      omittedPinnedSeqs: [],
      truncatedPinnedSeqs: [],
      posts: [],
      recallHint: `relay_board(action="read", boardId="${boardId}", view="full")`
    };
  }

  const recentStart = Math.max(0, list.length - Math.max(0, recentFull));
  const items = list.map((p, idx) => {
    const isPinned = Boolean(p._isActivePin);
    const isRecent = idx >= recentStart;
    if (isPinned || isRecent) {
      const textStr = String(p?.text ?? "");
      return {
        pinned: isPinned,
        recent: isRecent,
        entry: {
          seq: p?.seq ?? null,
          ...(p?.pinId ? { pinId: p.pinId } : {}),
          timestamp: p?.timestamp ?? null,
          author: p?.author ?? "unknown",
          tag: p?.tag ?? "[update]",
          ...(Array.isArray(p?.mentions) && p.mentions.length > 0 ? { mentions: p.mentions } : {}),
          // Do NOT blindly slice active pins at 400B; preserve full hard constraints whenever budget allows.
          text: isPinned ? textStr : truncateWithByteNotice(textStr, 400),
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
  const allPinnedSeqs = items.filter((i) => i.pinned && i.entry.seq != null).map((i) => i.entry.seq);
  const pinnedOriginalBytes = new Map(
    items.filter((i) => i.pinned).map((i) => [i.entry.seq, Buffer.byteLength(String(i.entry.text ?? ""), "utf8")])
  );

  // Phase 1: convert non-pinned recent full posts into compact stubs if needed.
  let active = items;
  if (!fitsBudget(active.map((i) => i.entry))) {
    active = active.map((i) => {
      if (!i.pinned && !i.entry.stub) {
        return { ...i, entry: formatBoardStub(i.entry, maxStubChars) };
      }
      return i;
    });
  }

  // Phase 2: drop oldest non-pinned entries first so active pins are preserved intact.
  while (active.length > 0 && !fitsBudget(active.map((i) => i.entry))) {
    const dropIdx = active.findIndex((i) => !i.pinned);
    if (dropIdx === -1) break;
    active = [...active.slice(0, dropIdx), ...active.slice(dropIdx + 1)];
  }

  // Phase 3: if active pins alone exceed maxBytes, tighten proportionally, then omit oldest pins and report honestly.
  const truncatedPinnedSeqs = new Set();
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
      if (e.text && Buffer.byteLength(e.text, "utf8") > perPinnedBudget) {
        e.text = truncateWithByteNotice(e.text, perPinnedBudget);
        if (i.pinned && e.seq != null) truncatedPinnedSeqs.add(e.seq);
      }
      if (e.summary && Buffer.byteLength(e.summary, "utf8") > perPinnedBudget) {
        e.summary = truncateWithByteNotice(e.summary, perPinnedBudget);
        if (i.pinned && e.seq != null) truncatedPinnedSeqs.add(e.seq);
      }
      return { ...i, entry: e };
    });
    while (active.length > 1 && !fitsBudget(active.map((i) => i.entry))) {
      // Drop transient [blocker] auto-pins before explicit [decision] / [invariant] / [pin] records.
      const blockerIdx = active.findIndex((i) => String(i.entry?.tag || "") === "[blocker]");
      if (blockerIdx !== -1) {
        active.splice(blockerIdx, 1);
      } else {
        active.shift();
      }
    }
    if (active.length === 1 && !fitsBudget(active.map((i) => i.entry))) {
      const e = active[0].entry;
      const room = Math.max(24, maxBytes - 160);
      const nextEntry = {
        seq: e.seq ?? null,
        tag: sliceUtf8Bytes(String(e.tag ?? "[pin]"), 24),
        author: sliceUtf8Bytes(String(e.author ?? "worker"), 32),
        ...(e.text
          ? { text: truncateWithByteNotice(e.text, room) }
          : { summary: truncateWithByteNotice(String(e.summary ?? ""), room) }),
        ...(e.pinned ? { pinned: true } : {})
      };
      if (active[0].pinned && e.seq != null && Buffer.byteLength(String(nextEntry.text ?? ""), "utf8") < (pinnedOriginalBytes.get(e.seq) ?? 0)) {
        truncatedPinnedSeqs.add(e.seq);
      }
      active[0] = { ...active[0], entry: nextEntry };
      if (!fitsBudget(active.map((i) => i.entry))) {
        active = [];
      }
    }
  }

  const finalEntries = active.map((i) => i.entry);
  const shownPinnedSeqs = new Set(active.filter((i) => i.pinned && i.entry.seq != null).map((i) => i.entry.seq));
  const omittedPinnedSeqs = allPinnedSeqs.filter((seq) => !shownPinnedSeqs.has(seq));
  const truncatedArr = [...truncatedPinnedSeqs].filter((seq) => shownPinnedSeqs.has(seq));
  const needExactPinRecall = omittedPinnedSeqs.length > 0 || truncatedArr.length > 0;
  const targetSeqs = [...new Set([...omittedPinnedSeqs, ...truncatedArr])];
  const recallHint = needExactPinRecall
    ? `relay_board(action="read", boardId="${boardId}", view="full", pinsOnly=true${targetSeqs.length ? `, seqs=${JSON.stringify(targetSeqs)}` : ""})`
    : `relay_board(action="read", boardId="${boardId}", view="full")`;

  return {
    view: "tiered",
    boardId,
    totalPosts: Math.max(rawPosts.length, list.length),
    pinnedTotal: allPinnedSeqs.length,
    pinnedShown: shownPinnedSeqs.size,
    pinnedCount: shownPinnedSeqs.size,
    stubCount: finalEntries.filter((e) => e.stub).length,
    recentCount: finalEntries.filter((e) => !e.stub).length,
    omittedPinnedCount: omittedPinnedSeqs.length,
    omittedPinnedSeqs,
    truncatedPinnedSeqs: truncatedArr,
    posts: finalEntries,
    recallHint
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function unwrapJobPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  if (payload.job && typeof payload.job === "object") {
    const jobResult = payload.job.result && typeof payload.job.result === "object" ? payload.job.result : {};
    return {
      ...jobResult,
      ...payload.job,
      ...payload,
      reviewId: payload.reviewId || payload.job.reviewId || jobResult.reviewId || null,
      decision: payload.decision || payload.job.decision || jobResult.decision || null,
      verdict: payload.verdict || payload.job.verdict || jobResult.verdict || null,
      totalFindings: payload.totalFindings ?? payload.job.totalFindings ?? jobResult.totalFindings ?? null,
      blockingCount: payload.blockingCount ?? payload.job.blockingCount ?? jobResult.blockingCount ?? null,
      advisoryCount: payload.advisoryCount ?? payload.job.advisoryCount ?? jobResult.advisoryCount ?? null,
      blockingFindings: payload.blockingFindings ?? jobResult.blockingFindings,
      remainingBlockingFindings: payload.remainingBlockingFindings ?? jobResult.remainingBlockingFindings,
      findings: payload.findings ?? jobResult.findings,
      deliverableMode: payload.deliverableMode || payload.job.deliverableMode || jobResult.deliverableMode || null,
      ignoredOnlyDeliverables: payload.ignoredOnlyDeliverables ?? payload.job.ignoredOnlyDeliverables ?? jobResult.ignoredOnlyDeliverables,
      ignoredFiles: payload.ignoredFiles ?? payload.job.ignoredFiles ?? jobResult.ignoredFiles,
      worktreePath: payload.worktreePath || payload.job.worktreePath || jobResult.worktreePath || null
    };
  }
  return payload;
}

function buildRecallPointer(toolName, payload) {
  const view = unwrapJobPayload(payload);
  if (view?.reviewId) {
    return `relay_review(action="inspect", reviewId="${view.reviewId}", offset=0, limit=10)`;
  }
  const jobId = view?.jobId || view?.job?.id || view?.id;
  if (jobId) {
    return `relay_jobs(action="result", jobId="${jobId}", compact=false)`;
  }
  if (view?.handoffId || view?.packet?.handoffId) {
    const hid = view?.handoffId || view?.packet?.handoffId;
    return `relay_handoff(action="inspect", handoffId="${hid}")`;
  }
  if (view?.boardId) {
    return `relay_board(action="read", boardId="${view.boardId}", view="full")`;
  }
  return toolName ? `Inspect local job/artifact records for ${toolName} directly.` : "Inspect artifact paths directly.";
}

function shrinkBulkyStrings(obj, perFieldBytes, stripStructuredOutput = false) {
  if (!obj || typeof obj !== "object") return obj;

  const stringFields = ["output", "rawOutput", "logTail", "hostDraft", "diff", "contextDigest", "text", "body", "trigger_path", "recommendation"];
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

  for (const arrKey of ["reviews", "perspectives", "critiques", "stages", "workers", "posts", "findings", "blockingFindings", "remainingBlockingFindings", "advisoryFindings"]) {
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

function isBlockingLike(finding) {
  const s = String(finding?.severity ?? "").toLowerCase();
  return s === "blocking" || s === "critical" || s === "high";
}

function buildBlockingPreview(payload, maxItems = 6) {
  const view = unwrapJobPayload(payload);
  const source = Array.isArray(view?.blockingFindings) && view.blockingFindings.length
    ? view.blockingFindings
    : Array.isArray(view?.remainingBlockingFindings) && view.remainingBlockingFindings.length
      ? view.remainingBlockingFindings
      : Array.isArray(view?.findings)
        ? view.findings.filter(isBlockingLike)
        : [];
  return source.slice(0, maxItems).map((f, idx) => ({
    id: f.id || `F${idx + 1}`,
    file: sliceUtf8Bytes(String(f.file || "unknown"), 64),
    ...(f.line_start != null ? { line: f.line_start } : {}),
    title: sliceUtf8Bytes(String(f.title || ""), 80),
    ...(f.trigger_path ? { trigger: sliceUtf8Bytes(String(f.trigger_path), 100) } : {})
  }));
}

function buildMinimalSummary(toolName, payload, originalBytes, maxBytes) {
  const view = unwrapJobPayload(payload);
  const recallFull = buildRecallPointer(toolName, view);
  const rawJobId = view?.jobId || view?.job?.id || view?.id || null;
  const rawHandoffId = view?.handoffId || view?.packet?.handoffId || null;
  const rawPatchPath = view?.patchPath || view?.job?.patchPath || null;
  const rawWorktreePath = view?.worktreePath || view?.job?.worktreePath || null;
  const rawDeliverableMode = view?.deliverableMode || view?.job?.deliverableMode || null;
  const rawIgnoredOnly = view?.ignoredOnlyDeliverables ?? view?.job?.ignoredOnlyDeliverables;
  const rawIgnoredFiles = view?.ignoredFiles || view?.job?.ignoredFiles;
  const rawReviewId = view?.reviewId || null;

  const totalFindings =
    view?.totalFindings ??
    (Array.isArray(view?.findings)
      ? view.findings.length
      : (Array.isArray(view?.blockingFindings) || Array.isArray(view?.advisoryFindings))
        ? (view?.blockingFindings?.length ?? 0) + (view?.advisoryFindings?.length ?? 0)
        : Array.isArray(view?.remainingBlockingFindings)
          ? view.remainingBlockingFindings.length
          : null);
  const blockingCount =
    view?.blockingCount ??
    (Array.isArray(view?.blockingFindings)
      ? view.blockingFindings.length
      : Array.isArray(view?.remainingBlockingFindings)
        ? view.remainingBlockingFindings.length
        : Array.isArray(view?.findings)
          ? view.findings.filter(isBlockingLike).length
          : null);
  const advisoryCount =
    view?.advisoryCount ??
    (Array.isArray(view?.advisoryFindings)
      ? view.advisoryFindings.length
      : totalFindings != null && blockingCount != null
        ? totalFindings - blockingCount
        : null);

  const blockingPreview = buildBlockingPreview(view, 5);

  const base = {
    ...(typeof view?.ok === "boolean" ? { ok: view.ok } : {}),
    ...(view?.status ? { status: sliceUtf8Bytes(String(view.status), 32) } : {}),
    ...(rawReviewId ? { reviewId: sliceUtf8Bytes(String(rawReviewId), 96) } : {}),
    ...(view?.artifactPath ? { artifactPath: truncateWithByteNotice(String(view.artifactPath), Math.min(200, Math.floor(maxBytes / 4))) } : {}),
    ...(view?.cycleId ? { cycleId: sliceUtf8Bytes(String(view.cycleId), 64) } : {}),
    ...(view?.round != null ? { round: view.round } : {}),
    ...(rawJobId ? { jobId: sliceUtf8Bytes(String(rawJobId), 96) } : {}),
    ...(rawHandoffId ? { handoffId: sliceUtf8Bytes(String(rawHandoffId), 96) } : {}),
    ...(rawPatchPath ? { patchPath: truncateWithByteNotice(String(rawPatchPath), Math.min(200, Math.floor(maxBytes / 4))) } : {}),
    ...(rawWorktreePath ? { worktreePath: truncateWithByteNotice(String(rawWorktreePath), Math.min(200, Math.floor(maxBytes / 4))) } : {}),
    ...(rawDeliverableMode ? { deliverableMode: sliceUtf8Bytes(String(rawDeliverableMode), 32) } : {}),
    ...(typeof rawIgnoredOnly === "boolean" ? { ignoredOnlyDeliverables: rawIgnoredOnly } : {}),
    ...(Array.isArray(rawIgnoredFiles) && rawIgnoredFiles.length
      ? { ignoredFiles: rawIgnoredFiles.slice(0, 6).map((f) => sliceUtf8Bytes(String(f), 80)) }
      : {}),
    ...(view?.verdict ? { verdict: sliceUtf8Bytes(String(view.verdict), 32) } : {}),
    ...(view?.decision ? { decision: sliceUtf8Bytes(String(view.decision), 32) } : {}),
    ...(totalFindings != null ? { totalFindings } : {}),
    ...(blockingCount != null ? { blockingCount } : {}),
    ...(advisoryCount != null ? { advisoryCount } : {}),
    ...(blockingPreview.length > 0 ? { blockingPreview } : {}),
    ...(view?.designId ? { designId: sliceUtf8Bytes(String(view.designId), 96) } : {}),
    ...(view?.gateKey ? { gateKey: sliceUtf8Bytes(String(view.gateKey), 96) } : {}),
    ...(view?.sessionId ? { sessionId: sliceUtf8Bytes(String(view.sessionId), 96) } : {}),
    ...(view?.durationMs != null ? { durationMs: view.durationMs } : {}),
    ...(Array.isArray(view?.changedFiles) ? { changedFiles: view.changedFiles.slice(0, 8).map((f) => sliceUtf8Bytes(String(f), 80)) } : {}),
    ...(Array.isArray(view?.scopeViolations) && view.scopeViolations.length
      ? { scopeViolations: view.scopeViolations.slice(0, 3).map((v) => sliceUtf8Bytes(String(v), 100)) }
      : {}),
    ...(view?.error ? { error: truncateWithByteNotice(view.error, Math.min(240, Math.floor(maxBytes / 5))) } : {}),
    _compacted: true,
    _originalBytes: originalBytes,
    _recall: truncateWithByteNotice(recallFull, Math.min(220, Math.floor(maxBytes / 4)))
  };

  if (Buffer.byteLength(JSON.stringify(base), "utf8") <= maxBytes) {
    return base;
  }

  // Trim blockingPreview items progressively before dropping counts/IDs.
  while (Array.isArray(base.blockingPreview) && base.blockingPreview.length > 1) {
    base.blockingPreview.pop();
    if (Buffer.byteLength(JSON.stringify(base), "utf8") <= maxBytes) {
      return base;
    }
  }

  const dropOrder = [
    "ignoredFiles",
    "changedFiles",
    "scopeViolations",
    "artifactPath",
    "error",
    "worktreePath",
    "patchPath",
    "blockingPreview",
    "sessionId",
    "designId",
    "gateKey",
    "cycleId",
    "round",
    "durationMs",
    "advisoryCount",
    "ignoredOnlyDeliverables",
    "deliverableMode",
    "verdict",
    "decision",
    "status",
    "handoffId",
    "jobId",
    "totalFindings",
    "blockingCount",
    "reviewId"
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

  // Pass 1: truncate bulky text fields (~700 bytes each), preserving findings/metadata.
  const pass1 = shrinkBulkyStrings(cloneJson(payload), Math.min(700, Math.floor(budget * 0.25)), false);
  pass1._compacted = true;
  pass1._originalBytes = originalBytes;
  pass1._recall = buildRecallPointer(toolName, payload);
  const preview1 = buildBlockingPreview(payload, 5);
  if (preview1.length > 0 && pass1.blockingPreview === undefined) {
    pass1.blockingPreview = preview1;
  }
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
  if (preview1.length > 0 && pass2.blockingPreview === undefined) {
    const withPreview = { ...pass2, blockingPreview: preview1 };
    if (Buffer.byteLength(JSON.stringify(withPreview), "utf8") <= budget) {
      return withPreview;
    }
  }
  if (Buffer.byteLength(JSON.stringify(pass2), "utf8") <= budget) {
    return pass2;
  }

  // Pass 3: guaranteed-bounded summary preserving reviewId, blockingPreview & exact recall pointer.
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
