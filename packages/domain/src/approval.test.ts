// The proposal vocabulary, the canonical-JSON hash contract, the route and
// event contracts (D-12, D-14, D-16, D-28; research Pattern 6). The RFC 8785
// vectors below are permanent unit tests, not comments: they are the published
// outputs a canonicaliser must reproduce byte for byte.
import { describe, expect, it } from "vitest";
import { API_BASE } from "./api.js";
import {
  APPROVAL_AUDIT_EVENTS,
  APPROVAL_CHIP_BOUND,
  APPROVAL_DECIDE_OUTCOMES,
  APPROVAL_DECIDE_PATH,
  APPROVAL_ERROR_CODES,
  APPROVAL_GET_PATH,
  APPROVAL_LIST_PATH,
  APPROVAL_PENDING_CAP_PER_OPERATION,
  APPROVAL_PENDING_CAP_TOTAL,
  APPROVAL_RESPONSE_BUDGET_BYTES,
  APPROVAL_TEST_PATH,
  ApprovalErrorBodySchema,
  ApprovalGetRequestSchema,
  type ApprovalSummary,
  ApprovalSummarySchema,
  type ApprovalsSnapshot,
  ApprovalsSnapshotSchema,
  ApprovalTestRequestSchema,
  ApprovalUpsertedPayloadSchema,
  buildEnvelope,
  canonicalJson,
  canTransition,
  DECIDED_VIA,
  DECIDED_VIA_HEADER,
  DECIDED_VIA_PLUGIN,
  DecideRequestSchema,
  DecideResponseSchema,
  dedupeKeyOf,
  fitApprovalsSnapshotToBudget,
  normaliseDecidedVia,
  PAYLOAD_HASH_PATTERN,
  PROPOSAL_ID_PATTERN,
  PROPOSAL_STATES,
  PROPOSAL_TRANSITIONS,
  type ProposalId,
  type ProposalState,
  payloadFingerprint,
  REQUESTER_KINDS,
  RESTING_PROPOSAL_STATES,
  RequesterSchema,
  TERMINAL_PROPOSAL_STATES,
} from "./approval.js";
import type { RunId } from "./ids.js";

const ID = "0mfk1a2b3c4d5e6f7a8b9c0d1" as ProposalId;
const HASH = "a".repeat(64);
const RUN = "0mfk1a2b3c4d5e6f7a8b9c0d2" as RunId;

describe("proposal states and transitions (Test 1)", () => {
  it("has exactly the ten states, lapsed included", () => {
    expect([...PROPOSAL_STATES].sort()).toEqual(
      [
        "approved",
        "denied",
        "executed",
        "executing",
        "expired",
        "failed",
        "lapsed",
        "pending",
        "unknown",
        "withdrawn",
      ].sort(),
    );
    expect(PROPOSAL_STATES).toHaveLength(10);
  });

  it("allows exactly the documented transitions and nothing else", () => {
    const expected: Record<ProposalState, readonly ProposalState[]> = {
      pending: ["approved", "denied", "expired", "withdrawn"],
      approved: ["executing", "lapsed"],
      executing: ["executed", "failed", "unknown"],
      executed: [],
      failed: [],
      unknown: [],
      denied: [],
      expired: [],
      withdrawn: [],
      lapsed: [],
    };
    for (const state of PROPOSAL_STATES) {
      expect([...PROPOSAL_TRANSITIONS[state]].sort(), state).toEqual([...expected[state]].sort());
    }
  });

  it("agrees with canTransition over every ordered pair", () => {
    for (const from of PROPOSAL_STATES) {
      for (const to of PROPOSAL_STATES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(
          PROPOSAL_TRANSITIONS[from].includes(to),
        );
      }
    }
  });

  it("has no outgoing transition from a state that is not a listed source", () => {
    const sources = new Set<ProposalState>(["pending", "approved", "executing"]);
    for (const state of PROPOSAL_STATES) {
      if (!sources.has(state)) expect(PROPOSAL_TRANSITIONS[state], state).toEqual([]);
    }
  });

  it("splits the states into terminal and resting, covering every state once", () => {
    expect([...RESTING_PROPOSAL_STATES].sort()).toEqual(["approved", "executing", "pending"]);
    const union = [...TERMINAL_PROPOSAL_STATES, ...RESTING_PROPOSAL_STATES].sort();
    expect(union).toEqual([...PROPOSAL_STATES].sort());
    for (const state of TERMINAL_PROPOSAL_STATES) {
      expect(PROPOSAL_TRANSITIONS[state], state).toEqual([]);
    }
  });

  it("never lets a proposal return to pending or revive after a terminal state", () => {
    for (const from of PROPOSAL_STATES) {
      expect(canTransition(from, "pending"), from).toBe(false);
    }
    expect(canTransition("unknown", "executing")).toBe(false);
    expect(canTransition("failed", "executing")).toBe(false);
    expect(canTransition("lapsed", "approved")).toBe(false);
  });
});

/** Decode the RFC's own hexadecimal sample bytes, so the expected string is the published one. */
function fromHex(hex: string): string {
  return Buffer.from(hex.replace(/\s+/g, ""), "hex").toString("utf8");
}

describe("canonicalJson (Test 2)", () => {
  it("reproduces the RFC 8785 section 3.2.2 / 3.2.4 sample byte for byte", () => {
    const parsed = JSON.parse(
      String.raw`{
        "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
        "string": "€$\u000F\u000aA'B"\\\\"\/",
        "literals": [null, true, false]
      }`,
    );
    const expected = fromHex(`
      7b 22 6c 69 74 65 72 61 6c 73 22 3a 5b 6e 75 6c 6c 2c 74 72
      75 65 2c 66 61 6c 73 65 5d 2c 22 6e 75 6d 62 65 72 73 22 3a
      5b 33 33 33 33 33 33 33 33 33 2e 33 33 33 33 33 33 33 2c 31
      65 2b 33 30 2c 34 2e 35 2c 30 2e 30 30 32 2c 31 65 2d 32 37
      5d 2c 22 73 74 72 69 6e 67 22 3a 22 e2 82 ac 24 5c 75 30 30
      30 66 5c 6e 41 27 42 5c 22 5c 5c 5c 5c 5c 22 2f 22 7d`);
    expect(canonicalJson(parsed)).toBe(expected);
    // The published text form too (a backslash sequence is spelled out, not decoded).
    expect(expected).toBe(
      String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`,
    );
  });

  it("reproduces the RFC 8785 section 3.2.3 key-order sample", () => {
    const parsed = JSON.parse(
      String.raw`{
        "€": "Euro Sign",
        "\r": "Carriage Return",
        "דּ": "Hebrew Letter Dalet With Dagesh",
        "1": "One",
        "😀": "Emoji: Grinning Face",
        "\u0080": "Control",
        "ö": "Latin Small Letter O With Diaeresis"
      }`,
    );
    const expected =
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}';
    expect(canonicalJson(parsed)).toBe(expected);
  });

  it("reproduces the RFC 8785 appendix B number samples", () => {
    const fromBits = (hex: string): number => {
      const view = new DataView(new ArrayBuffer(8));
      view.setBigUint64(0, BigInt(`0x${hex}`));
      return view.getFloat64(0);
    };
    const table: Array<[string, string]> = [
      ["0000000000000000", "0"],
      ["8000000000000000", "0"],
      ["0000000000000001", "5e-324"],
      ["8000000000000001", "-5e-324"],
      ["7fefffffffffffff", "1.7976931348623157e+308"],
      ["ffefffffffffffff", "-1.7976931348623157e+308"],
      ["4340000000000000", "9007199254740992"],
      ["c340000000000000", "-9007199254740992"],
      ["4430000000000000", "295147905179352830000"],
      ["44b52d02c7e14af5", "9.999999999999997e+22"],
      ["44b52d02c7e14af6", "1e+23"],
      ["44b52d02c7e14af7", "1.0000000000000001e+23"],
      ["444b1ae4d6e2ef4e", "999999999999999700000"],
      ["444b1ae4d6e2ef4f", "999999999999999900000"],
      ["444b1ae4d6e2ef50", "1e+21"],
      ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
      ["3eb0c6f7a0b5ed8d", "0.000001"],
      ["41b3de4355555553", "333333333.3333332"],
      ["41b3de4355555554", "333333333.33333325"],
      ["41b3de4355555555", "333333333.3333333"],
      ["41b3de4355555556", "333333333.3333334"],
      ["41b3de4355555557", "333333333.33333343"],
      ["becbf647612f3696", "-0.0000033333333333333333"],
      ["43143ff3c1cb0959", "1424953923781206.2"],
    ];
    for (const [bits, text] of table) {
      expect(canonicalJson(fromBits(bits)), bits).toBe(text);
    }
  });

  it("is independent of key insertion order, at every depth", () => {
    const first = { a: 1, b: { y: [1, { q: 1, p: 2 }], x: null }, c: "z" };
    const second = { c: "z", b: { x: null, y: [1, { p: 2, q: 1 }] }, a: 1 };
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(canonicalJson(first)).toBe('{"a":1,"b":{"x":null,"y":[1,{"p":2,"q":1}]},"c":"z"}');
  });

  it("keeps array order and accepts null-prototype objects and shared (non-cyclic) references", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    const bare = Object.create(null) as Record<string, unknown>;
    bare.k = 1;
    expect(canonicalJson(bare)).toBe('{"k":1}');
    const shared = { v: 1 };
    expect(canonicalJson({ a: shared, b: shared, c: [shared, shared] })).toBe(
      '{"a":{"v":1},"b":{"v":1},"c":[{"v":1},{"v":1}]}',
    );
  });

  it("serialises minus zero as 0", () => {
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson({ n: -0 })).toBe('{"n":0}');
  });

  it("serialises the literals and the empty containers", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
    expect(canonicalJson([])).toBe("[]");
    expect(canonicalJson({})).toBe("{}");
    expect(canonicalJson("")).toBe('""');
  });

  it("rejects undefined members, in objects and in arrays, with a TypeError naming the cause", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(TypeError);
    expect(() => canonicalJson({ a: undefined })).toThrow(/undefined member a/);
    expect(() => canonicalJson([1, undefined])).toThrow(TypeError);
    const sparse: unknown[] = new Array(3);
    sparse[0] = 1;
    sparse[2] = 3;
    expect(() => canonicalJson(sparse)).toThrow(TypeError);
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
  });

  it("rejects NaN and the infinities", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => canonicalJson(value)).toThrow(TypeError);
      expect(() => canonicalJson({ v: value })).toThrow(/non-finite/);
    }
  });

  it("rejects a cycle", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => canonicalJson(loop)).toThrow(TypeError);
    expect(() => canonicalJson(loop)).toThrow(/cycle/);
    const list: unknown[] = [];
    list.push(list);
    expect(() => canonicalJson(list)).toThrow(/cycle/);
  });

  it("rejects a lone surrogate, in a value and in a key", () => {
    expect(() => canonicalJson("\ud800")).toThrow(TypeError);
    expect(() => canonicalJson("a\udc00b")).toThrow(/lone surrogate/);
    expect(() => canonicalJson({ "\ud800": 1 })).toThrow(/lone surrogate/);
    expect(() => canonicalJson({ k: "😀" })).not.toThrow();
  });

  it("rejects Dates, Maps, Sets, class instances, functions, symbols and bigints", () => {
    class Box {
      readonly v = 1;
    }
    const hostile: unknown[] = [
      new Date(0),
      new Map(),
      new Set(),
      new Box(),
      () => 1,
      Symbol("s"),
      10n,
      /x/,
    ];
    for (const value of hostile) {
      expect(() => canonicalJson(value)).toThrow(TypeError);
      expect(() => canonicalJson({ nested: value })).toThrow(TypeError);
    }
  });

  it("rejects a structure nested deeper than the bound instead of overflowing the stack", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 1000; i += 1) deep = [deep];
    expect(() => canonicalJson(deep)).toThrow(/too deep/);
  });

  it("gives NFC and NFD forms of the same text different strings (the safe direction)", () => {
    const nfc = "é";
    const nfd = "é";
    expect(nfc.normalize("NFD")).toBe(nfd);
    expect(canonicalJson(nfc)).not.toBe(canonicalJson(nfd));
  });
});

describe("envelope and fingerprint (Test 3)", () => {
  const input = {
    operation: "diagnostic.test",
    subject: "subject-1",
    requester: { kind: "dashboard", label: "Dashboard" },
    projectId: "p1",
    runId: RUN,
    reason: "Because.",
    payload: { note: "hello", n: 1 },
  } as const;

  it("covers operation, subject, requester, project id, run id, reason and payload", () => {
    const envelope = buildEnvelope(input);
    expect(Object.keys(envelope).sort()).toEqual([
      "operation",
      "payload",
      "projectId",
      "reason",
      "requester",
      "runId",
      "subject",
    ]);
    expect(envelope.requester).toEqual({ kind: "dashboard", label: "Dashboard" });
  });

  it("changes the canonical form when any single covered member changes", () => {
    const base = canonicalJson(buildEnvelope(input));
    const variants = [
      { ...input, operation: "session.force-terminate" },
      { ...input, subject: "subject-2" },
      { ...input, requester: { kind: "skill", label: "Dashboard" } },
      { ...input, requester: { kind: "dashboard", label: "Other" } },
      { ...input, projectId: "p2" },
      { ...input, projectId: null },
      { ...input, runId: null },
      { ...input, reason: "Because!" },
      { ...input, payload: { note: "hello", n: 2 } },
    ];
    for (const variant of variants) {
      expect(canonicalJson(buildEnvelope(variant))).not.toBe(base);
    }
  });

  it("is independent of the member order of the input and copies it", () => {
    const reordered = {
      payload: { n: 1, note: "hello" },
      reason: "Because.",
      runId: RUN,
      projectId: "p1",
      requester: { label: "Dashboard", kind: "dashboard" },
      subject: "subject-1",
      operation: "diagnostic.test",
    } as const;
    expect(canonicalJson(buildEnvelope(reordered))).toBe(canonicalJson(buildEnvelope(input)));
    const mutable = { ...input, payload: { note: "x" } };
    const envelope = buildEnvelope(mutable);
    mutable.payload.note = "changed";
    expect((envelope.payload as { note: string }).note).toBe("x");
  });

  it("returns the first twelve characters of a 64-hex hash", () => {
    expect(payloadFingerprint("0123456789abcdef".repeat(4))).toBe("0123456789ab");
    expect(PAYLOAD_HASH_PATTERN.test("0123456789abcdef".repeat(4))).toBe(true);
  });

  it("throws on any other length or alphabet", () => {
    for (const bad of ["", "abc", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64)]) {
      expect(() => payloadFingerprint(bad), bad).toThrow();
    }
  });
});

describe("dedupe key (Test 4)", () => {
  it("is stable for the same operation and subject", () => {
    expect(dedupeKeyOf("diagnostic.test", "s")).toBe(dedupeKeyOf("diagnostic.test", "s"));
  });

  it("distinguishes operation and subject, with no ambiguity at the boundary", () => {
    const keys = new Set([
      dedupeKeyOf("a", "bc"),
      dedupeKeyOf("ab", "c"),
      dedupeKeyOf("a", "b"),
      dedupeKeyOf("b", "a"),
      dedupeKeyOf("diagnostic.test", "s"),
      dedupeKeyOf("session.force-terminate", "s"),
    ]);
    expect(keys.size).toBe(6);
  });
});

describe("requester (Test 5)", () => {
  it("has the closed kind set", () => {
    expect([...REQUESTER_KINDS]).toEqual(["dashboard", "skill", "automation", "connector"]);
    for (const kind of REQUESTER_KINDS) {
      expect(RequesterSchema.safeParse({ kind, label: "x" }).success).toBe(true);
    }
    expect(RequesterSchema.safeParse({ kind: "system", label: "x" }).success).toBe(false);
  });

  it("rejects a label longer than 64 characters or containing a control character", () => {
    expect(RequesterSchema.safeParse({ kind: "skill", label: "a".repeat(64) }).success).toBe(true);
    expect(RequesterSchema.safeParse({ kind: "skill", label: "a".repeat(65) }).success).toBe(false);
    for (const control of ["\u0000", "\u0007", "\n", "\r", "\t", "\u007f", "\u0085"]) {
      expect(
        RequesterSchema.safeParse({ kind: "skill", label: `a${control}b` }).success,
        control,
      ).toBe(false);
    }
    expect(RequesterSchema.safeParse({ kind: "skill", label: "" }).success).toBe(false);
  });

  it("is strict: an extra key fails", () => {
    expect(RequesterSchema.safeParse({ kind: "skill", label: "x", extra: 1 }).success).toBe(false);
  });
});

describe("routes and schemas (Test 6)", () => {
  it("uses fixed paths under API_BASE with no parameter segment", () => {
    for (const path of [
      APPROVAL_LIST_PATH,
      APPROVAL_GET_PATH,
      APPROVAL_DECIDE_PATH,
      APPROVAL_TEST_PATH,
    ]) {
      expect(path.startsWith(`${API_BASE}/approvals`)).toBe(true);
      expect(path).not.toMatch(/[:{}*?]/);
    }
    expect(
      new Set([APPROVAL_LIST_PATH, APPROVAL_GET_PATH, APPROVAL_DECIDE_PATH, APPROVAL_TEST_PATH])
        .size,
    ).toBe(4);
  });

  it("has no generic submit route", () => {
    const exported = [
      APPROVAL_LIST_PATH,
      APPROVAL_GET_PATH,
      APPROVAL_DECIDE_PATH,
      APPROVAL_TEST_PATH,
    ];
    for (const path of exported) {
      expect(path).not.toMatch(/submit|create|propose/);
    }
  });

  const decide = { proposalId: ID, decision: "approve", payloadHash: HASH } as const;

  it("requires a proposal id, a decision and the full hash", () => {
    expect(DecideRequestSchema.safeParse(decide).success).toBe(true);
    expect(DecideRequestSchema.safeParse({ ...decide, decision: "deny" }).success).toBe(true);
    for (const bad of [
      { ...decide, proposalId: "short" },
      { ...decide, proposalId: "A".repeat(25) },
      { ...decide, decision: "allow" },
      { ...decide, decision: "approve-always" },
      { ...decide, payloadHash: "a".repeat(12) },
      { ...decide, payloadHash: "A".repeat(64) },
      { ...decide, payloadHash: "a".repeat(65) },
    ]) {
      expect(DecideRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    for (const missing of ["proposalId", "decision", "payloadHash"] as const) {
      const partial: Record<string, unknown> = { ...decide };
      delete partial[missing];
      expect(DecideRequestSchema.safeParse(partial).success, missing).toBe(false);
    }
  });

  it("rejects any extra key, including any always-allow-shaped key", () => {
    for (const key of [
      "extra",
      "always",
      "alwaysAllow",
      "remember",
      "persist",
      "scope",
      "forSession",
      "ttlMs",
      "operation",
      "payload",
    ]) {
      expect(DecideRequestSchema.safeParse({ ...decide, [key]: true }).success, key).toBe(false);
    }
  });

  it("has the other request schemas strict too", () => {
    expect(ApprovalGetRequestSchema.safeParse({ proposalId: ID }).success).toBe(true);
    expect(ApprovalGetRequestSchema.safeParse({ proposalId: ID, extra: 1 }).success).toBe(false);
    expect(ApprovalGetRequestSchema.safeParse({}).success).toBe(false);
    expect(ApprovalTestRequestSchema.safeParse({}).success).toBe(true);
    expect(ApprovalTestRequestSchema.safeParse({ ttlMs: 60_000 }).success).toBe(true);
    expect(ApprovalTestRequestSchema.safeParse({ ttlMs: 0 }).success).toBe(false);
    expect(ApprovalTestRequestSchema.safeParse({ ttlMs: -1 }).success).toBe(false);
    expect(ApprovalTestRequestSchema.safeParse({ ttlMs: 1.5 }).success).toBe(false);
    expect(ApprovalTestRequestSchema.safeParse({ ttlMs: Number.POSITIVE_INFINITY }).success).toBe(
      false,
    );
    expect(
      ApprovalTestRequestSchema.safeParse({ operation: "session.force-terminate" }).success,
    ).toBe(false);
  });

  const summary: ApprovalSummary = {
    proposalId: ID,
    state: "approved",
    revision: 2,
    title: "Force-terminate Refactor parser",
    operationLabel: "Force-terminate a session",
    requesterKind: "dashboard",
    requesterLabel: "Dashboard",
    projectName: "alpha",
    runId: RUN,
    createdAt: "2026-10-04T15:00:00.000Z",
    expiresAt: "2026-10-04T15:15:00.000Z",
    decidedAt: "2026-10-04T15:01:00.000Z",
    outcomeCode: null,
  };

  it("makes the decide response a discriminated union over the closed outcome vocabulary", () => {
    expect([...APPROVAL_DECIDE_OUTCOMES].sort()).toEqual(
      [
        "already-decided",
        "decided",
        "expired",
        "hash-mismatch",
        "not-found",
        "operation-reserved",
      ].sort(),
    );
    const good: unknown[] = [
      { outcome: "decided", approval: summary },
      { outcome: "hash-mismatch" },
      { outcome: "expired" },
      { outcome: "already-decided", state: "denied" },
      { outcome: "not-found" },
      { outcome: "operation-reserved" },
    ];
    for (const body of good) {
      expect(DecideResponseSchema.safeParse(body).success, JSON.stringify(body)).toBe(true);
    }
    for (const body of [
      { outcome: "approved" },
      { outcome: "decided" },
      { outcome: "already-decided", state: "nope" },
      { outcome: "hash-mismatch", detail: "x" },
      {},
    ]) {
      expect(DecideResponseSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it("makes the error body a closed code enum plus the existing generic error body", () => {
    for (const code of APPROVAL_ERROR_CODES) {
      expect(ApprovalErrorBodySchema.safeParse({ error: code }).success, code).toBe(true);
    }
    expect(ApprovalErrorBodySchema.safeParse({ error: "invalid request" }).success).toBe(true);
    expect(ApprovalErrorBodySchema.safeParse({ error: "something internal broke" }).success).toBe(
      true,
    );
    expect(ApprovalErrorBodySchema.safeParse({ error: "x", message: "y" }).success).toBe(true);
    expect(ApprovalErrorBodySchema.safeParse({ code: "approval-unavailable" }).success).toBe(false);
    expect(ApprovalErrorBodySchema.safeParse({ error: 3 }).success).toBe(false);
    expect([...APPROVAL_ERROR_CODES]).toEqual(
      expect.arrayContaining([
        "approval-unavailable",
        "operation-reserved",
        "too-many-pending",
        "not-found",
      ]),
    );
  });

  it("closes the audit vocabulary", () => {
    expect([...APPROVAL_AUDIT_EVENTS].sort()).toEqual(
      [
        "requested",
        "approved",
        "denied",
        "expired",
        "withdrawn",
        "claimed",
        "executed",
        "failed",
        "outcome-unknown",
        "retried-after-restart",
        "reconciled-executed",
        "lapsed",
      ].sort(),
    );
  });
});

describe("summary and snapshot (Test 7)", () => {
  const summary = (index: number, over: Partial<ApprovalSummary> = {}): ApprovalSummary => ({
    proposalId: `0mfk1a2b3c4d5e6f7a8b${String(index).padStart(5, "0")}` as ProposalId,
    state: "pending",
    revision: 1,
    title: "Force-terminate Refactor parser",
    operationLabel: "Force-terminate a session",
    requesterKind: "dashboard",
    requesterLabel: "Dashboard",
    projectName: "alpha",
    runId: RUN,
    createdAt: "2026-10-04T15:00:00.000Z",
    expiresAt: "2026-10-04T15:15:00.000Z",
    decidedAt: null,
    outcomeCode: null,
    ...over,
  });

  const snapshot: ApprovalsSnapshot = {
    ready: true,
    pending: [summary(1), summary(2)],
    decided: [
      summary(3, {
        state: "executed",
        decidedAt: "2026-10-04T15:01:00.000Z",
        outcomeCode: "executed",
      }),
    ],
    expired: [summary(4, { state: "expired" })],
    counts: { pending: 2, decided: 9, expired: 1 },
    truncated: false,
  };

  it("parses a full summary and a full snapshot", () => {
    expect(ApprovalSummarySchema.safeParse(summary(1)).success).toBe(true);
    expect(ApprovalsSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("carries true totals in counts, independent of how many summaries are listed", () => {
    const parsed = ApprovalsSnapshotSchema.parse(snapshot);
    expect(parsed.counts.decided).toBe(9);
    expect(parsed.decided).toHaveLength(1);
    expect(parsed.truncated).toBe(false);
  });

  it("strips unknown keys instead of failing, so a newer service still parses", () => {
    const parsed = ApprovalsSnapshotSchema.parse({ ...snapshot, futureField: 1 });
    expect("futureField" in parsed).toBe(false);
    const withExtraSummary = ApprovalSummarySchema.parse({ ...summary(1), later: true });
    expect("later" in withExtraSummary).toBe(false);
  });

  it("rejects a summary whose text exceeds its cap or whose state is unknown", () => {
    expect(ApprovalSummarySchema.safeParse(summary(1, { title: "t".repeat(121) })).success).toBe(
      false,
    );
    expect(
      ApprovalSummarySchema.safeParse(summary(1, { requesterLabel: "r".repeat(65) })).success,
    ).toBe(false);
    expect(ApprovalSummarySchema.safeParse({ ...summary(1), state: "paused" }).success).toBe(false);
    expect(ApprovalSummarySchema.safeParse(summary(1, { createdAt: "yesterday" })).success).toBe(
      false,
    );
  });

  it("exports the bounds: chip 50, pending 25 per operation and 50 total, budget 56 KiB under the 64 KiB client cap", () => {
    expect(APPROVAL_CHIP_BOUND).toBe(50);
    expect(APPROVAL_PENDING_CAP_PER_OPERATION).toBe(25);
    expect(APPROVAL_PENDING_CAP_TOTAL).toBe(50);
    expect(APPROVAL_RESPONSE_BUDGET_BYTES).toBe(56 * 1024);
    expect(APPROVAL_RESPONSE_BUDGET_BYTES).toBeLessThan(64 * 1024);
  });

  const widest = (index: number, state: ApprovalSummary["state"] = "pending"): ApprovalSummary =>
    summary(index, {
      state,
      title: "t".repeat(120),
      operationLabel: "o".repeat(80),
      requesterLabel: "r".repeat(64),
      projectName: "p".repeat(120),
      outcomeCode: "c".repeat(64),
      decidedAt: "2026-10-04T15:01:00.000Z",
    });

  it("fits the worst-case pending list (every pending cap reached, every text at its cap) in the budget", () => {
    const pending = Array.from({ length: APPROVAL_PENDING_CAP_TOTAL }, (_, i) => widest(i));
    const body = JSON.stringify({
      ready: true,
      pending,
      decided: [],
      expired: [],
      counts: { pending: 50, decided: 0, expired: 0 },
      truncated: false,
    });
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(
      APPROVAL_RESPONSE_BUDGET_BYTES,
    );
  });

  it("trims decided and expired summaries first when a snapshot exceeds the budget, and says so", () => {
    const big: ApprovalsSnapshot = {
      ready: true,
      pending: Array.from({ length: 20 }, (_, i) => widest(i)),
      decided: Array.from({ length: APPROVAL_CHIP_BOUND }, (_, i) => widest(100 + i, "executed")),
      expired: Array.from({ length: APPROVAL_CHIP_BOUND }, (_, i) => widest(200 + i, "expired")),
      counts: { pending: 20, decided: 80, expired: 70 },
      truncated: false,
    };
    const fitted = fitApprovalsSnapshotToBudget(big);
    const size = new TextEncoder().encode(JSON.stringify(fitted)).length;
    expect(size).toBeLessThanOrEqual(APPROVAL_RESPONSE_BUDGET_BYTES);
    expect(fitted.truncated).toBe(true);
    expect(fitted.pending).toHaveLength(20);
    expect(fitted.decided.length + fitted.expired.length).toBeLessThan(100);
    expect(fitted.counts).toEqual({ pending: 20, decided: 80, expired: 70 });
  });

  it("returns a snapshot that already fits unchanged, and never mutates its input", () => {
    expect(fitApprovalsSnapshotToBudget(snapshot)).toEqual(snapshot);
    const before = JSON.stringify(snapshot);
    fitApprovalsSnapshotToBudget(snapshot, 10);
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it("drops pending summaries last, and only when the budget leaves no other choice", () => {
    const tiny = fitApprovalsSnapshotToBudget(snapshot, 400);
    expect(tiny.truncated).toBe(true);
    expect(tiny.decided).toHaveLength(0);
    expect(tiny.expired).toHaveLength(0);
    expect(new TextEncoder().encode(JSON.stringify(tiny)).length).toBeLessThanOrEqual(400);
    expect(tiny.counts).toEqual(snapshot.counts);
  });

  it("parses the upserted payload", () => {
    expect(ApprovalUpsertedPayloadSchema.safeParse({ approval: summary(1) }).success).toBe(true);
    expect(
      ApprovalUpsertedPayloadSchema.safeParse({ approval: summary(1), extra: 1 }).success,
    ).toBe(false);
    expect(ApprovalUpsertedPayloadSchema.safeParse({}).success).toBe(false);
  });

  it("matches the proposal id pattern used by both the schema and the minter", () => {
    expect(PROPOSAL_ID_PATTERN.test(ID)).toBe(true);
    expect(PROPOSAL_ID_PATTERN.test("0MFK1A2B3C4D5E6F7A8B9C0D1")).toBe(false);
    expect(PROPOSAL_ID_PATTERN.test(`${ID}0`)).toBe(false);
  });
});

describe("decided via (Test 9)", () => {
  it("has the closed vocabulary plugin or other, and the header constant", () => {
    expect([...DECIDED_VIA]).toEqual(["plugin", "other"]);
    expect(DECIDED_VIA_PLUGIN).toBe("plugin");
    expect(DECIDED_VIA_HEADER).toMatch(/^X-[A-Za-z-]+$/);
  });

  it("normalises anything that is not the plugin value to other", () => {
    expect(normaliseDecidedVia("plugin")).toBe("plugin");
    for (const value of [undefined, "", "Plugin", "other", "curl", "plugin ", "a".repeat(500)]) {
      expect(normaliseDecidedVia(value), String(value)).toBe("other");
    }
  });
});
