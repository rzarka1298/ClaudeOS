import {
  APPROVAL_RESPONSE_BUDGET_BYTES,
  type ApprovalItemDraft,
  ApprovalItemViewSchema,
  type ApprovalSummary,
  ApprovalSummarySchema,
  type AuditRow,
  HOSTILE_CORPUS,
  type NoteId,
  type ProposalId,
  type StoredProposal,
} from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { DEFAULT_DRAFT } from "./test-support/fake-operation.js";
import { assembleSnapshot, buildApprovalView, summaryOf } from "./view.js";

const ID = "p000000000000000000000001" as ProposalId;

function stored(patch: Partial<StoredProposal> = {}): StoredProposal {
  return {
    proposalId: ID,
    operation: "session.force-terminate",
    subject: "SUBJECT-SENTINEL",
    dedupeKey: "key",
    requester: { kind: "skill", label: "Planner" },
    projectId: "project-1",
    runId: "r000000000000000000000001",
    reason: "REASON-SENTINEL",
    payloadJson: '{"secret":"PAYLOAD-SENTINEL"}',
    payloadHash: "a".repeat(64),
    state: "pending",
    revision: 3,
    createdAt: "2026-10-06T12:00:00.000Z",
    expiresAt: "2026-10-06T12:15:00.000Z",
    approvedAt: null,
    decidedAt: null,
    decidedVia: null,
    claimFacts: null,
    attempts: 0,
    outcomeCode: null,
    outcomeNote: null,
    mirrorNoteId: "n000000000000000000000001" as NoteId,
    supersedes: null,
    ...patch,
  };
}

const INFO = { title: "Force-terminate Refactor parser", projectName: "Project one" };

describe("summaryOf (Test 7)", () => {
  it("carries only the fields of the domain summary schema and parses against it", () => {
    const summary = summaryOf(stored(), INFO);
    expect(ApprovalSummarySchema.safeParse(summary).success).toBe(true);
    expect(Object.keys(summary).sort()).toEqual(
      [
        "createdAt",
        "decidedAt",
        "expiresAt",
        "operationLabel",
        "outcomeCode",
        "projectName",
        "proposalId",
        "requesterKind",
        "requesterLabel",
        "revision",
        "runId",
        "state",
        "title",
      ].sort(),
    );
  });

  it("contains no payload, reason, subject or target value", () => {
    const written = JSON.stringify(summaryOf(stored(), INFO));
    expect(written).not.toContain("PAYLOAD-SENTINEL");
    expect(written).not.toContain("REASON-SENTINEL");
    expect(written).not.toContain("SUBJECT-SENTINEL");
  });

  it("names the operation with its fixed phrase and the project with the supplied display name", () => {
    const summary = summaryOf(stored(), INFO);
    expect(summary.operationLabel).toBe("Force-terminate a Claude session");
    expect(summary.projectName).toBe("Project one");
    expect(summary.requesterKind).toBe("skill");
    expect(summary.requesterLabel).toBe("Planner");
    expect(summary.state).toBe("pending");
    expect(summary.revision).toBe(3);
  });

  it("neutralises and caps the label and the title at the summary schema maxima, for every hostile entry", () => {
    for (const entry of HOSTILE_CORPUS) {
      const summary = summaryOf(stored({ requester: { kind: "dashboard", label: "x" } }), {
        title: `${entry.text}${entry.text}`,
        projectName: entry.text,
      });
      expect(ApprovalSummarySchema.safeParse(summary).success, entry.name).toBe(true);
      for (const token of entry.tokens) {
        expect(summary.title, entry.name).toContain(token);
      }
    }
  });

  it("cuts an over-long label and title and keeps a control-character run inside the schema maximum", () => {
    const longLabel = "L".repeat(5000);
    const summary = summaryOf(stored({ requester: { kind: "dashboard", label: longLabel } }), {
      title: `${"\u0001".repeat(500)}`,
      projectName: "p".repeat(500),
    });
    expect([...summary.requesterLabel].length).toBeLessThanOrEqual(64);
    expect(summary.title.length).toBeLessThanOrEqual(120);
    expect((summary.projectName ?? "").length).toBeLessThanOrEqual(120);
    expect(ApprovalSummarySchema.safeParse(summary).success).toBe(true);
  });

  it("keeps a falsy project name null, and drops a run id or outcome code that is not well formed", () => {
    const summary: ApprovalSummary = summaryOf(
      stored({ runId: "not a run id", outcomeCode: "Bad Code!" }),
      { title: "Title", projectName: null },
    );
    expect(summary.projectName).toBeNull();
    expect(summary.runId).toBeNull();
    expect(summary.outcomeCode).toBeNull();
  });

  it("uses a safe fallback label for an operation the table does not know", () => {
    const summary = summaryOf(stored({ operation: "nonsense.thing" }), INFO);
    expect(summary.operationLabel.length).toBeGreaterThan(0);
    expect(summary.operationLabel.length).toBeLessThanOrEqual(80);
  });
});

// ===========================================================================
// Task 3: the view builder and the bounded snapshot

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
const AUDIT: AuditRow[] = [
  { event: "requested", at: "2026-10-06T12:00:00.000Z", code: null },
  { event: "approved", at: "2026-10-06T12:01:00.000Z", code: null },
];
const CTX = { projectName: "Project one" };

function draft(patch: Partial<ApprovalItemDraft> = {}): ApprovalItemDraft {
  return { ...DEFAULT_DRAFT, ...patch };
}

const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|[^\S \n]/u;

/** Every string value in a view, with the path it sits at. */
function strings(value: unknown, path = "view"): [string, string][] {
  if (typeof value === "string") return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${path}[${i}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => strings(v, `${path}.${k}`));
  }
  return [];
}

describe("buildApprovalView (Test 1: completeness)", () => {
  const rich = draft({
    title: "Force-terminate Refactor parser",
    destructive: true,
    effect: "The session's process will be stopped.",
    action: "Ask the session's process to stop, then force it to stop.",
    runName: "Refactor parser",
    target: [
      { label: "Session", value: "Refactor parser", mono: false },
      { label: "Process", value: "node \u00b7 PID 4242", mono: true },
    ],
    change: {
      type: "diff",
      lines: [
        { kind: "removed", text: "state: running" },
        { kind: "added", text: "state: cancelled" },
        { kind: "omitted", text: "", count: 14 },
      ],
    },
    risks: ["Work in progress is lost.", "It cannot be brought back."],
    checkHint: "Check whether the session's process is still running before asking again.",
  });
  const row = stored({
    state: "executed",
    decidedAt: "2026-10-06T12:01:00.000Z",
    decidedVia: "plugin",
    outcomeCode: "executed",
    outcomeNote: "awaiting-exit",
    reason: "Because the session is stuck.",
  });

  it("carries every APPR-03 field and parses against the domain view schema", () => {
    const view = buildApprovalView(row, rich, AUDIT, CTX);
    expect(ApprovalItemViewSchema.safeParse(view).success).toBe(true);
    expect(view.proposalId).toBe(ID);
    expect(view.state).toBe("executed");
    expect(view.revision).toBe(3);
    expect(view.title).toBe("Force-terminate Refactor parser");
    expect(view.destructive).toBe(true);
    expect(view.effect).toBe("The session's process will be stopped.");
    expect(view.expiresAt).toBe(row.expiresAt);
    expect(view.requester).toEqual({ kind: "skill", label: "Planner" });
    expect(view.project).toBe("Project one");
    expect(view.run).toEqual({ runId: row.runId, name: "Refactor parser" });
    expect(view.action).toBe("Ask the session's process to stop, then force it to stop.");
    expect(view.target).toEqual(rich.target);
    expect(view.change).toEqual({
      type: "diff",
      origin: "engine",
      lines: [
        { kind: "removed", text: "state: running", count: null },
        { kind: "added", text: "state: cancelled", count: null },
        { kind: "omitted", text: "", count: 14 },
      ],
    });
    expect(view.reason).toEqual({
      origin: "requester",
      shown: "Because the session is stuck.",
      full: "Because the session is stuck.",
      shortened: false,
    });
    expect(view.risks).toEqual(rich.risks);
    expect(view.checkHint).toBe(rich.checkHint);
    expect(view.record).toEqual({
      requestedAt: row.createdAt,
      payloadHash: row.payloadHash,
      fingerprint: row.payloadHash.slice(0, 12),
      decidedAt: "2026-10-06T12:01:00.000Z",
      decidedVia: "plugin",
      outcomeCode: "executed",
      outcomeNote: "awaiting-exit",
    });
    expect(view.history).toEqual([
      { event: "requested", at: "2026-10-06T12:00:00.000Z" },
      { event: "approved", at: "2026-10-06T12:01:00.000Z" },
    ]);
    expect(view.reviewable).toBe(true);
  });

  it("uses null for a missing project and run, and a payload change as a list of fields", () => {
    const view = buildApprovalView(
      stored({ projectId: null, runId: null }),
      draft({
        change: { type: "payload", fields: [{ label: "title", value: "Weekly review" }] },
      }),
      AUDIT,
      { projectName: null },
    );
    expect(view.project).toBeNull();
    expect(view.run).toBeNull();
    expect(view.change).toEqual({
      type: "payload",
      origin: "engine",
      fields: [{ label: "title", value: "Weekly review" }],
    });
    expect(ApprovalItemViewSchema.safeParse(view).success).toBe(true);
  });

  it("shows a change of none as none", () => {
    const view = buildApprovalView(stored(), draft(), AUDIT, CTX);
    expect(view.change).toEqual({ type: "none", origin: "engine" });
  });
});

describe("buildApprovalView (Test 2: origin)", () => {
  it("marks engine-computed blocks engine and requester-provided blocks requester", () => {
    const engineOwned = buildApprovalView(
      stored(),
      draft({ changeFromRequester: false }),
      AUDIT,
      CTX,
    );
    expect(engineOwned.change.origin).toBe("engine");
    const requesterOwned = buildApprovalView(
      stored(),
      draft({
        changeFromRequester: true,
        change: { type: "diff", lines: [{ kind: "added", text: "x" }] },
      }),
      AUDIT,
      CTX,
    );
    expect(requesterOwned.change.origin).toBe("requester");
    expect(requesterOwned.reason.origin).toBe("requester");
  });

  it("a requester label of System never makes a block engine-origin", () => {
    const view = buildApprovalView(
      stored({ requester: { kind: "automation", label: "System" } }),
      draft({
        changeFromRequester: true,
        change: { type: "payload", fields: [{ label: "a", value: "b" }] },
      }),
      AUDIT,
      CTX,
    );
    expect(view.requester).toEqual({ kind: "automation", label: "System" });
    expect(view.change.origin).toBe("requester");
    expect(view.reason.origin).toBe("requester");
  });
});

describe("buildApprovalView (Test 3: hostile corpus)", () => {
  it("leaves no raw control, format or look-alike blank character, shows visible tokens, and keeps markup literal", () => {
    for (const entry of HOSTILE_CORPUS) {
      const view = buildApprovalView(
        stored({
          requester: { kind: "dashboard", label: "x" },
          reason: entry.text,
        }),
        draft({
          title: entry.text,
          changeFromRequester: true,
          change: { type: "diff", lines: [{ kind: "added", text: entry.text }] },
        }),
        AUDIT,
        { projectName: entry.text },
      );
      for (const [path, value] of strings(view)) {
        const allowed =
          path === "view.reason.shown" || path === "view.reason.full"
            ? value.replace(/\n/g, "")
            : value;
        expect(HIDDEN.test(allowed), `${entry.name} ${path}`).toBe(false);
      }
      for (const token of entry.tokens) {
        expect(view.title, entry.name).toContain(token);
        expect(view.reason.shown, entry.name).toContain(token);
        const line = view.change.type === "diff" ? view.change.lines[0]?.text : "";
        expect(line, entry.name).toContain(token);
      }
      if (entry.identical === true) {
        expect(view.title).toBe(entry.text);
        expect(view.reason.shown).toBe(entry.text);
        const line = view.change.type === "diff" ? view.change.lines[0]?.text : "";
        expect(line).toBe(entry.text);
      }
      expect(ApprovalItemViewSchema.safeParse(view).success, entry.name).toBe(true);
    }
  });

  it("keeps newlines only in the reason", () => {
    const view = buildApprovalView(
      stored({ reason: "one\ntwo\r\nthree", requester: { kind: "dashboard", label: "a\nb" } }),
      draft({
        title: "x\ny",
        effect: "e\nf",
        action: "a\nb",
        target: [{ label: "l\nm", value: "v\nw", mono: false }],
      }),
      AUDIT,
      { projectName: "p\nq" },
    );
    expect(view.reason.shown).toBe("one\ntwo\nthree");
    expect(view.reason.full).toBe("one\ntwo\nthree");
    for (const [path, value] of strings(view)) {
      if (path.startsWith("view.reason")) continue;
      expect(value, path).not.toContain("\n");
    }
    expect(view.title).toBe("x y");
    expect(view.requester.label).toBe("a b");
  });
});

describe("buildApprovalView (Test 4: caps and reviewability)", () => {
  const lines = (n: number, text = "line") =>
    Array.from({ length: n }, () => ({ kind: "added" as const, text }));
  const diff = (n: number, text?: string) =>
    draft({ change: { type: "diff", lines: lines(n, text) } });

  it("cuts a 5,000-character label to the cap", () => {
    const view = buildApprovalView(
      stored({ requester: { kind: "dashboard", label: "L".repeat(5000) } }),
      draft(),
      AUDIT,
      CTX,
    );
    expect([...view.requester.label].length).toBe(64);
  });

  it("an ordinary request is reviewable", () => {
    expect(buildApprovalView(stored(), diff(10), AUDIT, CTX).reviewable).toBe(true);
    expect(buildApprovalView(stored(), diff(500), AUDIT, CTX).reviewable).toBe(true);
  });

  it("a diff of 501 lines is cut to 500 and not reviewable", () => {
    const view = buildApprovalView(stored(), diff(501), AUDIT, CTX);
    expect(view.change.type === "diff" && view.change.lines.length).toBe(500);
    expect(view.reviewable).toBe(false);
  });

  it("a diff of 20,001 characters is cut and not reviewable; exactly 20,000 is reviewable", () => {
    const over = buildApprovalView(stored(), diff(1, "a".repeat(20_001)), AUDIT, CTX);
    expect(over.reviewable).toBe(false);
    const exact = buildApprovalView(stored(), diff(1, "a".repeat(20_000)), AUDIT, CTX);
    expect(exact.reviewable).toBe(true);
  });

  it("a 20,000-character run of control characters that would neutralise to a far longer string is not reviewable and stays bounded", () => {
    const view = buildApprovalView(stored(), diff(1, "\u0001".repeat(20_000)), AUDIT, CTX);
    expect(view.reviewable).toBe(false);
    const text = view.change.type === "diff" ? (view.change.lines[0]?.text ?? "") : "";
    expect(text.length).toBeLessThanOrEqual(20_000);
    expect(ApprovalItemViewSchema.safeParse(view).success).toBe(true);
  });

  it("a payload change is capped the same way", () => {
    const fields = Array.from({ length: 501 }, (_, i) => ({ label: `f${i}`, value: "v" }));
    const view = buildApprovalView(
      stored(),
      draft({ change: { type: "payload", fields } }),
      AUDIT,
      CTX,
    );
    expect(view.change.type === "payload" && view.change.fields.length).toBe(500);
    expect(view.reviewable).toBe(false);
  });

  it("a reason over 1,000 characters shows the first 1,000 and carries the full text up to 4,000", () => {
    const reason = "r".repeat(1500);
    const view = buildApprovalView(stored({ reason }), draft(), AUDIT, CTX);
    expect(view.reason.shown).toBe("r".repeat(1000));
    expect(view.reason.full).toBe(reason);
    expect(view.reason.shortened).toBe(false);
    expect(view.reviewable).toBe(true);
  });

  it("a reason over 4,000 characters is cut, marked shortened and not reviewable", () => {
    const view = buildApprovalView(stored({ reason: "r".repeat(4001) }), draft(), AUDIT, CTX);
    expect(view.reason.full).toBe("r".repeat(4000));
    expect(view.reason.shortened).toBe(true);
    expect(view.reviewable).toBe(false);
  });

  it("a target value over 200 characters, or more than eight rows, is cut and not reviewable", () => {
    const longValue = buildApprovalView(
      stored(),
      draft({ target: [{ label: "Path", value: "v".repeat(201), mono: true }] }),
      AUDIT,
      CTX,
    );
    expect([...(longValue.target[0]?.value ?? "")].length).toBe(200);
    expect(longValue.reviewable).toBe(false);
    const manyRows = buildApprovalView(
      stored(),
      draft({
        target: Array.from({ length: 9 }, (_, i) => ({ label: `r${i}`, value: "v", mono: false })),
      }),
      AUDIT,
      CTX,
    );
    expect(manyRows.target).toHaveLength(8);
    expect(manyRows.reviewable).toBe(false);
  });
});

describe("buildApprovalView (Test 5: response budget)", () => {
  const maxDraft = (glyph: string, diffLines: number, perLine: number): ApprovalItemDraft =>
    draft({
      title: glyph.repeat(120),
      destructive: true,
      effect: glyph.repeat(240),
      action: glyph.repeat(240),
      runName: glyph.repeat(120),
      target: Array.from({ length: 8 }, (_, i) => ({
        label: glyph.repeat(64),
        value: glyph.repeat(200),
        mono: i % 2 === 0,
      })),
      change: {
        type: "diff",
        lines: Array.from({ length: diffLines }, () => ({
          kind: "added" as const,
          text: glyph.repeat(perLine),
        })),
      },
      changeFromRequester: true,
      risks: Array.from({ length: 10 }, () => glyph.repeat(200)),
      checkHint: glyph.repeat(200),
    });
  const maxRow = (glyph: string) =>
    stored({
      requester: { kind: "connector", label: glyph.repeat(64) },
      reason: glyph.repeat(4000),
      outcomeNote: "awaiting-exit",
    });
  const audit: AuditRow[] = Array.from({ length: 25 }, (_, i) => ({
    event: "claimed",
    at: `2026-10-06T12:${String(i).padStart(2, "0")}:00.000Z`,
    code: null,
  }));

  it("keeps a maximum-size ASCII view under the budget, measured in UTF-8 bytes", () => {
    const view = buildApprovalView(maxRow("a"), maxDraft("a", 500, 40), audit, {
      projectName: "p".repeat(120),
    });
    expect(bytes({ view })).toBeLessThanOrEqual(APPROVAL_RESPONSE_BUDGET_BYTES);
    expect(view.reviewable).toBe(true);
    expect(ApprovalItemViewSchema.safeParse(view).success).toBe(true);
  });

  it("keeps a maximum-size multibyte (CJK) view under the budget in bytes, not in string length, trimming the change and withholding approval", () => {
    const glyph = "\u754c";
    const row = maxRow(glyph);
    const view = buildApprovalView(row, maxDraft(glyph, 500, 40), audit, {
      projectName: glyph.repeat(120),
    });
    const wire = JSON.stringify({ view });
    expect(wire.length).toBeLessThan(Buffer.byteLength(wire, "utf8"));
    expect(Buffer.byteLength(wire, "utf8")).toBeLessThanOrEqual(APPROVAL_RESPONSE_BUDGET_BYTES);
    expect(view.reviewable).toBe(false);
    if (view.change.type === "diff") {
      expect(view.change.lines.length).toBeLessThan(500);
    }
    expect(ApprovalItemViewSchema.safeParse(view).success).toBe(true);
  });
});

describe("buildApprovalView (Test 6: history)", () => {
  it("keeps at most twenty events, oldest first, with fixed codes and times and no detail text", () => {
    const audit: AuditRow[] = Array.from({ length: 25 }, (_, i) => ({
      event: i === 24 ? "reconciled-executed" : "claimed",
      at: `2026-10-06T12:${String(i).padStart(2, "0")}:00.000Z`,
      code: "SECRET-DETAIL-TEXT",
    }));
    const view = buildApprovalView(stored(), draft(), audit, CTX);
    expect(view.history).toHaveLength(20);
    expect(view.history[0]?.at).toBe("2026-10-06T12:05:00.000Z");
    expect(view.history.at(-1)).toEqual({ event: "executed", at: "2026-10-06T12:24:00.000Z" });
    const times = view.history.map((h) => h.at);
    expect([...times].sort()).toEqual(times);
    expect(JSON.stringify(view)).not.toContain("SECRET-DETAIL-TEXT");
  });
});

describe("assembleSnapshot (Test 8: snapshot budget)", () => {
  const summaryFor = (tag: string, n: number, glyph = "a"): ApprovalSummary =>
    summaryOf(
      stored({
        proposalId: `${tag}${String(n).padStart(24, "0")}` as ProposalId,
        requester: { kind: "connector", label: glyph.repeat(64) },
        runId: "r000000000000000000000001",
      }),
      { title: glyph.repeat(120), projectName: glyph.repeat(120) },
    );
  const many = (tag: string, glyph?: string) =>
    Array.from({ length: 50 }, (_, i) => summaryFor(tag, i, glyph));
  const input = (glyph?: string) => ({
    pending: many("p", glyph),
    decided: many("d", glyph),
    expired: many("e", glyph),
    counts: { pending: 50, decided: 120, expired: 80 },
  });

  it("serialises fifty pending, fifty decided and fifty expired maximum-length summaries below the budget by dropping the oldest decided and expired first", () => {
    const given = input();
    expect(bytes(given)).toBeGreaterThan(APPROVAL_RESPONSE_BUDGET_BYTES);
    const out = assembleSnapshot(given);
    expect(bytes(out)).toBeLessThanOrEqual(APPROVAL_RESPONSE_BUDGET_BYTES);
    expect(out.truncated).toBe(true);
    expect(out.ready).toBe(true);
    expect(out.counts).toEqual({ pending: 50, decided: 120, expired: 80 });
    expect(out.pending).toEqual(given.pending);
    expect(out.decided.length).toBeLessThan(50);
    expect(out.expired.length).toBeLessThan(50);
    // what stays is the newest: a prefix of each list
    expect(out.decided).toEqual(given.decided.slice(0, out.decided.length));
    expect(out.expired).toEqual(given.expired.slice(0, out.expired.length));
  });

  it("never drops a pending summary, even for multibyte maximum-length pending text", () => {
    const given = { ...input("\u754c"), decided: [], expired: [] };
    expect(bytes(given)).toBeGreaterThan(APPROVAL_RESPONSE_BUDGET_BYTES);
    const out = assembleSnapshot(given);
    expect(bytes(out)).toBeLessThanOrEqual(APPROVAL_RESPONSE_BUDGET_BYTES);
    expect(out.pending.map((p) => p.proposalId)).toEqual(given.pending.map((p) => p.proposalId));
    expect(out.truncated).toBe(true);
    expect(out.pending.every((p) => p.title.length > 0 && p.state === "pending")).toBe(true);
    for (const item of out.pending)
      expect(ApprovalSummarySchema.safeParse(item).success).toBe(true);
  });

  it("returns a small snapshot untouched and not truncated when the counts match the lists", () => {
    const given = {
      pending: [summaryFor("p", 1)],
      decided: [summaryFor("d", 1)],
      expired: [],
      counts: { pending: 1, decided: 1, expired: 0 },
    };
    const out = assembleSnapshot(given);
    expect(out).toEqual({ ready: true, ...given, truncated: false });
  });

  it("flags truncation when the lists are shorter than the true counts, and honours a smaller budget", () => {
    const given = {
      pending: [summaryFor("p", 1)],
      decided: [summaryFor("d", 1)],
      expired: [],
      counts: { pending: 1, decided: 200, expired: 0 },
    };
    expect(assembleSnapshot(given).truncated).toBe(true);
    const small = assembleSnapshot(input(), 28_000);
    expect(bytes(small)).toBeLessThanOrEqual(28_000);
    expect(small.counts).toEqual({ pending: 50, decided: 120, expired: 80 });
    expect(small.pending).toHaveLength(50);
  });
});
