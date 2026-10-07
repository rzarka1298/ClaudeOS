import {
  APPROVAL_RESPONSE_BUDGET_BYTES,
  ApprovalDetailResponseSchema,
  ApprovalItemViewSchema,
  type ApprovalSummary,
  ApprovalSummarySchema,
  ApprovalsSnapshotSchema,
  ApprovalUpsertedPayloadSchema,
  HOSTILE_CORPUS,
  type ProposalId,
  type ProposalState,
  type SnapshotResponse,
} from "@ccc/domain";
import {
  adoptApprovalsFromSnapshot,
  applyApprovalServiceEvent,
  applyApprovalSummary,
  approvalsById,
  approvalsCounts,
  approvalsHydrated,
  approvalsReady,
  approvalsTruncated,
  resetApprovalsState,
} from "@ccc/plugin";
import { createExpirySweeper } from "@ccc/service/approval";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  auditPathProblems,
  createRigs,
  FIXTURE_EPOCH,
  insertAuditRows,
  type LoggedLine,
  logViolations,
  type OpenedEngine,
  readAudit,
  restart,
  utf8Bytes,
} from "./approval-fixtures.js";

/**
 * Restart and reload persistence, the expiry race, response size, audit
 * completeness and log hygiene (plan 06-24 task 3; APPR-06, APPR-07, APPR-08,
 * D-21, T-06-05, T-06-07, T-06-09, T-06-30). Real engine, real file-backed
 * SQLite, a fake clock, and the real plugin snapshot adopter.
 */

const MINUTE_MS = 60_000;
const CLIENT_CAP_BYTES = 64 * 1024;
const CJK = String.fromCodePoint(0x754c);
const BEL = String.fromCharCode(7);

const rigs = createRigs();

/** Proposals whose audit trail was fabricated on purpose and must be left out of the legality checks. */
const fabricated = new Set<string>();
const auditProblems: string[] = [];
let auditedProposals = 0;
const loggedLines: LoggedLine[] = [];
const seenLogs = new Set<unknown>();

beforeEach(() => {
  resetApprovalsState();
});

afterEach(() => {
  for (const rig of rigs.engines) {
    if (!seenLogs.has(rig.world.log)) {
      seenLogs.add(rig.world.log);
      loggedLines.push(...rig.world.log.lines);
    }
    if (rig.isClosed) continue;
    const rows = rig.db.prepare("SELECT proposal_id, state FROM proposals").all() as {
      proposal_id: string;
      state: string;
    }[];
    for (const row of rows) {
      if (fabricated.has(row.proposal_id)) continue;
      auditedProposals += 1;
      const trail = readAudit(rig.db, row.proposal_id);
      for (const problem of auditPathProblems(
        trail.map((entry) => entry.event),
        row.state as ProposalState,
      )) {
        auditProblems.push(`${row.proposal_id}: ${problem}`);
      }
      for (const entry of trail) {
        if (entry.event === "approved" || entry.event === "denied") {
          if (entry.decidedVia !== "plugin" && entry.decidedVia !== "other") {
            auditProblems.push(`${row.proposal_id}: ${entry.event} has no decision channel`);
          }
        }
      }
    }
  }
  rigs.dispose();
});

/** True when the text cannot be encoded as well-formed UTF-8 (a lone surrogate). */
function hasLoneSurrogate(text: string): boolean {
  try {
    encodeURIComponent(text);
    return false;
  } catch {
    return true;
  }
}

function wrapped(approvals: unknown): SnapshotResponse {
  return {
    lastEventId: 1,
    state: { serviceStartedAt: FIXTURE_EPOCH, approvals },
  } as unknown as SnapshotResponse;
}

function raise(rig: OpenedEngine, count: number, ttlMs?: number): ProposalId[] {
  return Array.from({ length: count }, () =>
    rig.propose(ttlMs === undefined ? {} : { requestedTtlMs: ttlMs }),
  );
}

describe("Test 1: service restart", () => {
  it("keeps three pending requests with identical fingerprints and expiry, and accepts the pre-restart hash", async () => {
    const rig = rigs.start();
    const ids = [
      rig.propose({ requestedTtlMs: 10 * MINUTE_MS }),
      rig.propose({ requestedTtlMs: 20 * MINUTE_MS }),
      rig.propose({ requestedTtlMs: 30 * MINUTE_MS }),
    ];
    const hashes = ids.map((id) => rig.hashOf(id));
    const before = rig.engine.list("pending");
    const fingerprints = ids.map((id) => {
      const detail = rig.engine.get(id);
      return detail.kind === "found" ? detail.fingerprint : "";
    });

    const next = restart(rigs, rig);
    await next.engine.recover();

    expect(next.engine.list("pending")).toEqual(before);
    expect(before.map((summary) => summary.proposalId)).toEqual(ids);
    const after = ids.map((id) => {
      const detail = next.engine.get(id);
      return detail.kind === "found" ? detail.fingerprint : "";
    });
    expect(after).toEqual(fingerprints);
    expect(fingerprints.every((fingerprint) => fingerprint.length === 12)).toBe(true);
    expect(ids.map((id) => next.hashOf(id))).toEqual(hashes);

    const decided = await next.engine.decide({
      proposalId: ids[0] as string,
      decision: "approve",
      payloadHash: hashes[0] as string,
      via: "plugin",
    });
    expect(decided.outcome).toBe("decided");
    await next.engine.settled();
    expect(next.store.get(ids[0] as ProposalId)?.state).toBe("executed");
    expect(next.world.diagnostic.applications).toBe(1);
  });
});

describe("Tests 2 and 3: plugin reload", () => {
  it("adopts the real engine's snapshot with matching counts, ready flag and expiry order, idempotently", async () => {
    const rig = rigs.start();
    // Raised out of expiry order on purpose; the snapshot lists them soonest first.
    const late = rig.propose({ requestedTtlMs: 30 * MINUTE_MS });
    const soon = rig.propose({ requestedTtlMs: 10 * MINUTE_MS });
    const middle = rig.propose({ requestedTtlMs: 20 * MINUTE_MS });
    const done = rig.propose();
    await rig.decide(done);
    const denied = rig.propose();
    await rig.decide(denied, "deny");
    await rig.engine.settled();

    const snapshot = JSON.parse(JSON.stringify(rig.engine.snapshot())) as unknown;
    const parsed = ApprovalsSnapshotSchema.parse(snapshot);
    expect(parsed.pending.map((summary) => summary.proposalId)).toEqual([soon, middle, late]);

    // A reload starts empty, then asks the service again.
    resetApprovalsState();
    expect(approvalsHydrated.value).toBe(false);
    expect(approvalsCounts.value).toEqual({ pending: 0, decided: 0, expired: 0 });
    adoptApprovalsFromSnapshot(wrapped(snapshot));
    const held = approvalsById.value;
    expect(approvalsHydrated.value).toBe(true);
    expect(approvalsReady.value).toBe(true);
    expect(approvalsTruncated.value).toBe(false);
    expect(approvalsCounts.value).toEqual(parsed.counts);
    expect(approvalsCounts.value).toEqual({ pending: 3, decided: 2, expired: 0 });
    const pending = [...held.values()]
      .filter((summary) => summary.state === "pending")
      .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
    expect(pending.map((summary) => summary.proposalId)).toEqual([soon, middle, late]);
    expect(held.get(done)?.state).toBe("executed");
    expect(held.get(denied)?.state).toBe("denied");

    // Adopting the same snapshot again changes nothing observable.
    adoptApprovalsFromSnapshot(wrapped(snapshot));
    expect([...approvalsById.value.entries()]).toEqual([...held.entries()]);
    expect(approvalsCounts.value).toEqual(parsed.counts);

    // An older service's snapshot has no approvals member and leaves every signal alone.
    adoptApprovalsFromSnapshot(wrapped(undefined));
    expect([...approvalsById.value.entries()]).toEqual([...held.entries()]);
    expect(approvalsCounts.value).toEqual(parsed.counts);
    expect(approvalsReady.value).toBe(true);
  });

  it("does not regress a decided request when a stale upsert arrives after the snapshot", async () => {
    const rig = rigs.start();
    const id = rig.propose();
    const pendingSummary = rig.engine.list("pending")[0] as ApprovalSummary;
    await rig.decide(id);
    await rig.engine.settled();

    adoptApprovalsFromSnapshot(wrapped(JSON.parse(JSON.stringify(rig.engine.snapshot()))));
    expect(approvalsById.value.get(id)?.state).toBe("executed");
    const counts = approvalsCounts.value;

    expect(applyApprovalSummary(pendingSummary)).toBe(false);
    expect(approvalsById.value.get(id)?.state).toBe("executed");
    expect(approvalsCounts.value).toEqual(counts);

    // Every published event, replayed newest first, still lands on the latest state.
    resetApprovalsState();
    expect(rig.published.length).toBeGreaterThanOrEqual(4);
    for (const summary of [...rig.published].reverse()) {
      applyApprovalServiceEvent({
        id: 1,
        type: "approval.upserted",
        payload: ApprovalUpsertedPayloadSchema.parse({ approval: summary }),
      } as never);
    }
    expect(approvalsById.value.get(id)?.state).toBe("executed");
    expect(approvalsCounts.value).toEqual({ pending: 0, decided: 1, expired: 0 });
  });
});

describe("Test 4: a decision racing the expiry sweep (APPR-06, D-09, T-06-05)", () => {
  it("resolves to expired with zero effects at the exact expiry instant, in either order", async () => {
    const rig = rigs.start();
    const sweeper = createExpirySweeper({ engine: rig.engine, log: rig.world.log });
    const decideFirst = rig.propose({ requestedTtlMs: MINUTE_MS });
    const sweepFirst = rig.propose({ requestedTtlMs: 2 * MINUTE_MS });
    const call = (id: ProposalId) =>
      rig.engine.decide({
        proposalId: id,
        decision: "approve",
        payloadHash: rig.hashOf(id),
        via: "plugin",
      });

    // The decision starts first at the instant its request expires: it settles the request itself.
    rig.world.clock.advance(MINUTE_MS);
    expect(rig.world.clock.now()).toBe(rig.store.get(decideFirst)?.expiresAt);
    const [first, sweptA] = await Promise.all([call(decideFirst), sweeper.sweepNow()]);
    expect(first).toEqual({ outcome: "expired" });
    expect(sweptA.expired).toBe(0);

    // The sweep starts first at the instant the other request expires: the decision finds it settled.
    rig.world.clock.advance(MINUTE_MS);
    expect(rig.world.clock.now()).toBe(rig.store.get(sweepFirst)?.expiresAt);
    const [sweptB, second] = await Promise.all([sweeper.sweepNow(), call(sweepFirst)]);
    expect(sweptB.expired).toBe(1);
    expect(second).toEqual({ outcome: "already-decided", state: "expired" });
    await rig.engine.settled();

    for (const id of [decideFirst, sweepFirst]) {
      expect(rig.store.get(id)?.state).toBe("expired");
      expect(readAudit(rig.db, id).map((entry) => entry.event)).toEqual(["requested", "expired"]);
    }
    expect(rig.world.diagnostic.executions).toBe(0);
    expect(rig.world.diagnostic.applications).toBe(0);
  });

  it("lets a decision one millisecond earlier win, and leaves the sweep nothing to expire", async () => {
    const rig = rigs.start();
    const sweeper = createExpirySweeper({ engine: rig.engine, log: rig.world.log });
    const id = rig.propose({ requestedTtlMs: MINUTE_MS });
    const hash = rig.hashOf(id);
    rig.world.clock.advance(MINUTE_MS - 1);

    const [decided, swept] = await Promise.all([
      rig.engine.decide({ proposalId: id, decision: "approve", payloadHash: hash, via: "plugin" }),
      sweeper.sweepNow(),
    ]);
    await rig.engine.settled();
    expect(decided.outcome).toBe("decided");
    expect(swept.expired).toBe(0);
    expect(rig.store.get(id)?.state).toBe("executed");
    expect(rig.world.diagnostic.applications).toBe(1);
  });

  it("answers a decision after the sweep as settled-as-expired and runs nothing", async () => {
    const rig = rigs.start();
    const id = rig.propose({ requestedTtlMs: MINUTE_MS });
    const hash = rig.hashOf(id);
    rig.world.clock.advance(MINUTE_MS + 5000);
    expect(rig.engine.sweepExpired().expired).toBe(1);
    const late = await rig.engine.decide({
      proposalId: id,
      decision: "approve",
      payloadHash: hash,
      via: "plugin",
    });
    // The store reports a repeated decision on a settled request by its state (D-14, D-16).
    expect(late).toEqual({ outcome: "already-decided", state: "expired" });
    expect(rig.world.diagnostic.executions).toBe(0);
    expect(readAudit(rig.db, id).filter((entry) => entry.event === "expired")).toHaveLength(1);
  });
});

describe("Test 5: expiry while the service was down", () => {
  it("expires the requests before any list is served", async () => {
    const rig = rigs.start();
    const ids = raise(rig, 2, MINUTE_MS);
    const keeper = rig.propose({ requestedTtlMs: 60 * MINUTE_MS });
    rig.world.clock.advance(10 * MINUTE_MS);

    const next = restart(rigs, rig);
    const summary = await next.engine.recover();
    expect(summary.expired).toBe(2);
    expect(next.engine.list("pending").map((entry) => entry.proposalId)).toEqual([keeper]);
    expect(
      next.engine
        .list("expired")
        .map((entry) => entry.proposalId)
        .sort(),
    ).toEqual([...ids].sort());
    for (const id of ids) {
      expect(readAudit(next.db, id).map((entry) => entry.event)).toEqual(["requested", "expired"]);
    }
  });
});

describe("Test 6: response size (T-06-30)", () => {
  /** Fifty expired, fifty decided, fifty pending: the worst inbox the caps allow. */
  async function fullInbox(rig: OpenedEngine, text: (n: number) => string) {
    const make = (operation: string, count: number, ttlMs?: number) =>
      Array.from({ length: count }, () =>
        rig.propose({
          operation,
          projectId: "project-1",
          requester: { kind: "automation", label: text(64) },
          reason: text(4000),
          payload: { title: text(120), value: text(200) },
          ...(ttlMs === undefined ? {} : { requestedTtlMs: ttlMs }),
        }),
      );
    // Expired: short lifetime, then time passes.
    make("diagnostic.test", 25, 1000);
    make("session.force-terminate", 25, 1000);
    rig.world.clock.advance(5000);
    rig.engine.sweepExpired();
    // Decided: half approved and carried out, half denied.
    const decided = [...make("diagnostic.test", 25), ...make("session.force-terminate", 25)];
    for (const [index, id] of decided.entries()) {
      await rig.decide(id, index % 2 === 0 ? "approve" : "deny");
    }
    await rig.engine.settled();
    // Pending: the cap, twenty-five per operation.
    return [...make("diagnostic.test", 25), ...make("session.force-terminate", 25)];
  }

  it.each([
    ["multibyte (CJK)", (n: number) => CJK.repeat(n)],
    ["ASCII", (n: number) => "m".repeat(n)],
  ])(
    "keeps the largest snapshot (%s) under the budget and the client cap, never dropping a pending request",
    async (label, text) => {
      const rig = rigs.start({ projectName: () => text(120) });
      const pending = await fullInbox(rig, text);
      expect(pending).toHaveLength(50);

      const snapshot = rig.engine.snapshot();
      const bytes = utf8Bytes(snapshot);
      // Measured, printed for the record.
      console.log(
        `approval snapshot size (${label}): ${bytes} bytes (budget ${APPROVAL_RESPONSE_BUDGET_BYTES}, client cap ${CLIENT_CAP_BYTES})`,
      );
      expect(bytes).toBeLessThanOrEqual(APPROVAL_RESPONSE_BUDGET_BYTES);
      expect(bytes).toBeLessThan(CLIENT_CAP_BYTES);
      ApprovalsSnapshotSchema.parse(snapshot);
      expect(snapshot.pending.map((summary) => summary.proposalId).sort()).toEqual(
        [...pending].sort(),
      );
      expect(snapshot.counts).toEqual({ pending: 50, decided: 50, expired: 50 });
      // The lists are bounded below the counts, and the snapshot says so.
      expect(snapshot.truncated).toBe(true);
      expect(snapshot.decided.length).toBeLessThanOrEqual(50);
      // The whole resync response the plugin receives stays under the cap too.
      expect(utf8Bytes(wrapped(snapshot))).toBeLessThan(CLIENT_CAP_BYTES);
      expect(snapshot.pending.every((summary) => summary.title.length > 0)).toBe(true);
    },
  );

  it("trims decided and expired first under a tighter budget, keeping true counts", async () => {
    const rig = rigs.start();
    const pending = await fullInbox(rig, (n) => "m".repeat(n));
    const tight = 24 * 1024;
    const snapshot = rig.engine.snapshot(tight);
    expect(utf8Bytes(snapshot)).toBeLessThanOrEqual(tight);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.counts).toEqual({ pending: 50, decided: 50, expired: 50 });
    expect(snapshot.pending).toHaveLength(pending.length);
    expect(snapshot.decided.length + snapshot.expired.length).toBeLessThan(100);
  });

  it("keeps the largest detail view under the client cap with reviewable false", async () => {
    const rig = rigs.start({ projectName: () => CJK.repeat(120) });
    const lines = Array.from({ length: 500 }, (_, index) =>
      index === 0 ? BEL.repeat(20_000) : `${CJK.repeat(60)} ${index}`,
    );
    const id = rig.propose({
      projectId: "project-1",
      requester: { kind: "skill", label: CJK.repeat(64) },
      reason: CJK.repeat(5000),
      payload: { title: CJK.repeat(120), value: BEL.repeat(20_000), lines },
    });
    // Twenty-five fabricated events so the history shows its newest twenty.
    fabricated.add(id);
    insertAuditRows(
      rig.db,
      id,
      Array.from({ length: 25 }, () => "outcome-unknown" as const),
      FIXTURE_EPOCH,
    );

    const detail = rig.engine.get(id);
    expect(detail.kind).toBe("found");
    if (detail.kind !== "found") return;
    expect(detail.view).not.toBeNull();
    const response = {
      summary: detail.summary,
      view: detail.view,
      purged: detail.purged,
      payloadHash: rig.hashOf(id),
    };
    const bytes = utf8Bytes(response);
    console.log(
      `approval detail size (largest view): ${bytes} bytes (budget ${APPROVAL_RESPONSE_BUDGET_BYTES}, client cap ${CLIENT_CAP_BYTES})`,
    );
    expect(bytes).toBeLessThan(CLIENT_CAP_BYTES);
    ApprovalDetailResponseSchema.parse(response);
    expect(detail.view?.reviewable).toBe(false);
    expect(detail.view?.history).toHaveLength(20);
    // No raw control character survives into the view.
    expect(JSON.stringify(detail.view)).not.toContain(BEL);
  });
});

describe("Test 7: the audit is complete, legal and immutable (APPR-08, T-06-07)", () => {
  it("records the decision channel on approvals and denials", async () => {
    const rig = rigs.start();
    const [a, b, c] = raise(rig, 3) as [ProposalId, ProposalId, ProposalId];
    await rig.engine.decide({
      proposalId: a,
      decision: "approve",
      payloadHash: rig.hashOf(a),
      via: "plugin",
    });
    await rig.engine.decide({
      proposalId: b,
      decision: "deny",
      payloadHash: rig.hashOf(b),
      via: "other",
    });
    await rig.engine.decide({
      proposalId: c,
      decision: "deny",
      payloadHash: rig.hashOf(c),
      via: "plugin",
    });
    await rig.engine.settled();
    const via = (id: ProposalId, event: string) =>
      readAudit(rig.db, id).find((entry) => entry.event === event)?.decidedVia;
    expect(via(a, "approved")).toBe("plugin");
    expect(via(b, "denied")).toBe("other");
    expect(via(c, "denied")).toBe("plugin");
    expect(rig.store.get(b)?.decidedVia).toBe("other");
  });

  it("refuses to update, delete or replace an audit row through the store handle", async () => {
    const rig = rigs.start();
    const id = rig.propose();
    await rig.decide(id);
    await rig.engine.settled();
    const before = readAudit(rig.db, id);
    expect(before.length).toBeGreaterThanOrEqual(4);
    const first = before[0];
    if (first === undefined) return;
    const attacks = [
      `UPDATE approval_audit SET event = 'denied' WHERE seq = ${first.seq}`,
      "UPDATE approval_audit SET at = '2000-01-01T00:00:00.000Z'",
      `DELETE FROM approval_audit WHERE seq = ${first.seq}`,
      "DELETE FROM approval_audit",
      `INSERT OR REPLACE INTO approval_audit (seq, proposal_id, event, at) VALUES (${first.seq}, '${id}', 'denied', '${FIXTURE_EPOCH}')`,
      `REPLACE INTO approval_audit (seq, proposal_id, event, at) VALUES (${first.seq}, '${id}', 'denied', '${FIXTURE_EPOCH}')`,
    ];
    for (const attack of attacks) {
      expect(() => rig.db.exec(attack), attack).toThrow(/append-only/);
    }
    expect(readAudit(rig.db, id)).toEqual(before);
  });
});

describe("Test 8: a hostile requester end to end", () => {
  it("shows no raw hidden character in the view or summary, and the summary parses for the plugin", async () => {
    const rig = rigs.start();
    let accepted = 0;
    for (const entry of HOSTILE_CORPUS) {
      const outcome = rig.engine.submit({
        operation: "diagnostic.test",
        subject: rig.world.nextSubject(),
        requester: { kind: "skill", label: entry.text },
        projectId: null,
        runId: null,
        reason: entry.text,
        payload: { title: entry.text, value: entry.text, lines: [entry.text] },
      });
      if (outcome.kind === "rejected") {
        // A label with a hidden character never reaches storage (the requester schema refuses it).
        expect(outcome.reason).toBe("invalid-payload");
        const clean = rig.engine.submit({
          operation: "diagnostic.test",
          subject: rig.world.nextSubject(),
          requester: { kind: "skill", label: "Hostile corpus skill" },
          projectId: null,
          runId: null,
          reason: entry.text,
          payload: { title: entry.text, value: entry.text, lines: [entry.text] },
        });
        if (clean.kind === "rejected") {
          // Text that cannot be written as well-formed JSON (a lone surrogate) is refused outright.
          expect(hasLoneSurrogate(entry.text), entry.name).toBe(true);
          expect(clean.reason).toBe("invalid-payload");
          continue;
        }
        checkView(rig, clean.proposalId, entry);
        await rig.decide(clean.proposalId, "deny");
        continue;
      }
      accepted += 1;
      checkView(rig, outcome.proposalId, entry);
      await rig.decide(outcome.proposalId, "deny");
    }
    expect(accepted).toBeGreaterThan(0);
  });

  function checkView(
    rig: OpenedEngine,
    id: ProposalId,
    entry: (typeof HOSTILE_CORPUS)[number],
  ): void {
    const detail = rig.engine.get(id);
    expect(detail.kind, entry.name).toBe("found");
    if (detail.kind !== "found" || detail.view === null) return;
    ApprovalItemViewSchema.parse(detail.view);
    ApprovalSummarySchema.parse(detail.summary);
    // The plugin's own parser takes the published event for it.
    resetApprovalsState();
    applyApprovalServiceEvent({
      id: 1,
      type: "approval.upserted",
      payload: { approval: detail.summary },
    } as never);
    expect(approvalsById.value.get(id)?.proposalId, entry.name).toBe(id);

    const shown = JSON.stringify([
      detail.view.title,
      detail.view.requester.label,
      detail.view.target,
      detail.view.change,
      detail.view.reason,
      detail.summary,
    ]);
    for (const token of entry.tokens) {
      const hex = /^\[U\+([0-9A-F]+)\]$/.exec(token)?.[1];
      if (hex === undefined) continue;
      const raw = String.fromCodePoint(Number.parseInt(hex, 16));
      expect(shown.includes(raw), `${entry.name} leaks ${token}`).toBe(false);
    }
  }
});

describe("Test 7 (aggregate): every request this file created was audited", () => {
  it("has a legal, complete trail for each one", () => {
    expect(auditedProposals).toBeGreaterThan(100);
    expect(auditProblems).toEqual([]);
  });
});

describe("Test 9: the log carried only allow-listed keys and short values", () => {
  it("held across every scenario of this file", () => {
    // The afterEach hook has gathered each rig's lines; the last test's own lines join them now.
    for (const rig of rigs.engines) {
      if (!seenLogs.has(rig.world.log)) {
        seenLogs.add(rig.world.log);
        loggedLines.push(...rig.world.log.lines);
      }
    }
    expect(loggedLines.length).toBeGreaterThan(20);
    expect(logViolations(loggedLines)).toEqual([]);
    const codes = new Set(
      loggedLines.flatMap((line) =>
        typeof line.fields.code === "string" ? [line.fields.code] : [],
      ),
    );
    for (const code of ["submitted", "approved", "denied", "executed", "swept", "recovered"]) {
      expect(codes.has(code), `no ${code} log line was ever recorded`).toBe(true);
    }
  });
});
