import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DecideInput,
  dedupeKeyOf,
  type NewProposal,
  newNoteId,
  newProposalId,
  type PendingCaps,
  type ProposalState,
} from "@ccc/domain";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApprovalStore } from "./approval-store.js";
import { applyMigrations } from "./migrate.js";
import {
  columnNames,
  openMigratedFileDb,
  openMigratedMemoryDb,
  openSecondConnection,
  REAL_MIGRATIONS_DIR,
  triggerNames,
} from "./test-support/migration-helper.js";

// ---------------------------------------------------------------------------
// Shared fixtures

const T0 = "2026-10-06T10:00:00.000Z";
const HOUR = 3_600_000;
const CAPS: PendingCaps = { perOperation: 25, total: 50 };

function at(offsetMs: number, base: string = T0): string {
  return new Date(Date.parse(base) + offsetMs).toISOString();
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function makeProposal(overrides: Partial<NewProposal> = {}): NewProposal {
  const operation = overrides.operation ?? "session.force-terminate";
  const subject = overrides.subject ?? `subject-${Math.random().toString(36).slice(2)}`;
  const payloadJson = overrides.payloadJson ?? JSON.stringify({ runId: "run-1" });
  return {
    proposalId: newProposalId(),
    operation,
    subject,
    dedupeKey: dedupeKeyOf(operation, subject),
    requester: { kind: "dashboard", label: "Test requester" },
    projectId: null,
    runId: null,
    reason: "test reason",
    payloadJson,
    payloadHash: sha256(payloadJson),
    createdAt: T0,
    expiresAt: at(HOUR),
    mirrorNoteId: newNoteId(),
    supersedes: null,
    ...overrides,
  };
}

function decideInput(proposal: NewProposal, overrides: Partial<DecideInput> = {}): DecideInput {
  return {
    proposalId: proposal.proposalId,
    decision: "approve",
    expectedHash: proposal.payloadHash,
    now: at(60_000),
    via: "plugin",
    ...overrides,
  };
}

interface AuditDbRow {
  seq: number;
  proposal_id: string;
  event: string;
  at: string;
  decided_via: string | null;
  payload_hash: string | null;
  detail: string | null;
}

let dir: string;
let dbPath: string;
let db: Database.Database;
let store: ReturnType<typeof createApprovalStore>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-approval-store-"));
  dbPath = join(dir, "operational.db");
  db = openMigratedFileDb(dbPath);
  store = createApprovalStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function auditRows(proposalId?: string): AuditDbRow[] {
  return (
    proposalId === undefined
      ? db.prepare("SELECT * FROM approval_audit ORDER BY seq").all()
      : db
          .prepare("SELECT * FROM approval_audit WHERE proposal_id = ? ORDER BY seq")
          .all(proposalId)
  ) as AuditDbRow[];
}

function auditEvents(proposalId: string): string[] {
  return auditRows(proposalId).map((row) => row.event);
}

function rowOf(proposalId: string): Record<string, unknown> {
  return db.prepare("SELECT * FROM proposals WHERE proposal_id = ?").get(proposalId) as Record<
    string,
    unknown
  >;
}

/** Moves a row through legal transitions with raw SQL, so a test can reach a later state without Task 2 methods. */
function forceState(proposalId: string, path: readonly ProposalState[]): void {
  for (const state of path) {
    db.prepare("UPDATE proposals SET state = ?, revision = revision + 1 WHERE proposal_id = ?").run(
      state,
      proposalId,
    );
  }
}

function submitPending(overrides: Partial<NewProposal> = {}): NewProposal {
  const proposal = makeProposal(overrides);
  const result = store.submit(proposal, CAPS);
  expect(result.kind).toBe("created");
  return proposal;
}

// ---------------------------------------------------------------------------
// Task 1

describe("migration (Test 1)", () => {
  it("creates the four tables with their indexes on a fresh file-backed database", () => {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((row) => row.name);
    for (const table of [
      "proposals",
      "approval_audit",
      "approval_executions",
      "diagnostic_effects",
    ]) {
      expect(tables).toContain(table);
    }
    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
    ).map((row) => row.name);
    expect(indexes).toContain("proposals_pending_dedupe");
    expect(indexes).toContain("proposals_state_expires_idx");
    expect(indexes).toContain("approval_audit_proposal_idx");
  });

  it("applying twice is a no-op", () => {
    const before = triggerNames(db);
    expect(() => applyMigrations(db, REAL_MIGRATIONS_DIR)).not.toThrow();
    expect(triggerNames(db)).toEqual(before);
    const version = db.prepare("SELECT version FROM schema_version").get() as { version: number };
    expect(version.version).toBe(
      readdirSync(REAL_MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).length,
    );
  });

  it("a database recorded at the previous version upgrades by exactly the approvals file", () => {
    const files = readdirSync(REAL_MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const approvalsIndex = files.findIndex((name) => name.endsWith("_approvals.sql"));
    expect(approvalsIndex).toBeGreaterThan(0);
    const previousDir = mkdtempSync(join(tmpdir(), "ccc-approval-prev-"));
    const upgradeDb = new Database(join(dir, "upgrade.db"));
    try {
      for (const name of files.slice(0, approvalsIndex)) {
        copyFileSync(join(REAL_MIGRATIONS_DIR, name), join(previousDir, name));
      }
      applyMigrations(upgradeDb, previousDir);
      const before = upgradeDb.prepare("SELECT version FROM schema_version").get() as {
        version: number;
      };
      expect(before.version).toBe(approvalsIndex);
      expect(
        upgradeDb.prepare("SELECT name FROM sqlite_master WHERE name = 'proposals'").get(),
      ).toBeUndefined();

      // The existing rows of an earlier table survive the upgrade untouched.
      upgradeDb
        .prepare(
          "INSERT INTO projects (project_id, path, display_name, registered_at) VALUES (?, ?, ?, ?)",
        )
        .run("0000000000123456789abcdef", "/Users/USERNAME/code/example", "example", "t");

      applyMigrations(upgradeDb, join(REAL_MIGRATIONS_DIR));
      const after = upgradeDb.prepare("SELECT version FROM schema_version").get() as {
        version: number;
      };
      expect(after.version).toBe(files.length);
      expect(
        upgradeDb.prepare("SELECT name FROM sqlite_master WHERE name = 'proposals'").get(),
      ).toBeDefined();
      expect(
        (upgradeDb.prepare("SELECT display_name FROM projects").get() as { display_name: string })
          .display_name,
      ).toBe("example");
    } finally {
      upgradeDb.close();
      rmSync(previousDir, { recursive: true, force: true });
    }
  });

  it("every CREATE in the approvals migration carries IF NOT EXISTS and the header names the rebuild hazard", async () => {
    const { readFileSync } = await import("node:fs");
    const file = readdirSync(REAL_MIGRATIONS_DIR).find((name) => name.endsWith("_approvals.sql"));
    expect(file).toBeDefined();
    const sql = readFileSync(join(REAL_MIGRATIONS_DIR, file as string), "utf8");
    const statements = sql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    const creates =
      statements.match(/CREATE\s+(UNIQUE\s+)?(TABLE|INDEX|TRIGGER)\s+(IF NOT EXISTS\s+)?/g) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    for (const create of creates) {
      expect(create).toContain("IF NOT EXISTS");
    }
    expect(sql).toMatch(/rebuild/i);
    expect(sql).toMatch(/drop/i);
  });
});

describe("submit (Test 2)", () => {
  it("stores a new pending row at revision 1 and attempts 0 with exactly one requested audit row", () => {
    const proposal = makeProposal();
    const result = store.submit(proposal, CAPS);
    expect(result.kind).toBe("created");
    if (result.kind !== "created") return;
    expect(result.proposal.proposalId).toBe(proposal.proposalId);
    expect(result.proposal.state).toBe("pending");
    expect(result.proposal.revision).toBe(1);
    expect(result.proposal.attempts).toBe(0);
    expect(result.proposal.payloadJson).toBe(proposal.payloadJson);
    expect(result.proposal.payloadHash).toBe(proposal.payloadHash);
    expect(result.proposal.requester).toEqual(proposal.requester);
    expect(result.proposal.mirrorNoteId).toBe(proposal.mirrorNoteId);
    expect(result.proposal.approvedAt).toBeNull();
    expect(result.proposal.claimFacts).toBeNull();
    expect(store.get(proposal.proposalId)).toEqual(result.proposal);

    const rows = auditRows(proposal.proposalId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event).toBe("requested");
    expect(rows[0]?.at).toBe(proposal.createdAt);
    expect(rows[0]?.payload_hash).toBe(proposal.payloadHash);
    expect(rows[0]?.decided_via).toBeNull();
  });

  it("rolls the row back when the audit insert fails", () => {
    db.exec(
      "CREATE TEMP TRIGGER fail_requested BEFORE INSERT ON approval_audit WHEN NEW.event = 'requested' BEGIN SELECT RAISE(ABORT, 'audit down'); END;",
    );
    const proposal = makeProposal();
    expect(() => store.submit(proposal, CAPS)).toThrow();
    expect(store.get(proposal.proposalId)).toBeNull();
    expect(auditRows()).toHaveLength(0);
  });

  it("refuses malformed input before touching the database", () => {
    expect(() => store.submit(makeProposal({ payloadHash: "not-a-hash" }), CAPS)).toThrow();
    expect(() => store.submit(makeProposal({ createdAt: "yesterday" }), CAPS)).toThrow();
    expect(() => store.submit(makeProposal({ expiresAt: "2026-10-06 11:00:00" }), CAPS)).toThrow();
    expect(() => store.submit(makeProposal({ expiresAt: at(-1) }), CAPS)).toThrow();
    expect(() =>
      store.submit(makeProposal({ requester: { kind: "root" as never, label: "x" } }), CAPS),
    ).toThrow();
    expect(db.prepare("SELECT count(*) AS n FROM proposals").get()).toEqual({ n: 0 });
    expect(auditRows()).toHaveLength(0);
  });
});

describe("decide, approve (Test 3)", () => {
  it("moves the row to approved, records decided_via and the time, bumps the revision and audits it", () => {
    const proposal = submitPending();
    const result = store.decide(decideInput(proposal, { via: "plugin" }));
    expect(result.kind).toBe("approved");
    if (result.kind !== "approved") return;
    expect(result.proposal.state).toBe("approved");
    expect(result.proposal.approvedAt).toBe(at(60_000));
    expect(result.proposal.decidedAt).toBe(at(60_000));
    expect(result.proposal.decidedVia).toBe("plugin");
    expect(result.proposal.revision).toBe(2);

    const rows = auditRows(proposal.proposalId);
    expect(rows.map((row) => row.event)).toEqual(["requested", "approved"]);
    expect(rows[1]?.decided_via).toBe("plugin");
    expect(rows[1]?.payload_hash).toBe(proposal.payloadHash);
    expect(rows[1]?.at).toBe(at(60_000));
  });

  it("records a decision made from outside the plugin as other", () => {
    const proposal = submitPending();
    const result = store.decide(decideInput(proposal, { via: "other" }));
    expect(result.kind).toBe("approved");
    expect(auditRows(proposal.proposalId)[1]?.decided_via).toBe("other");
  });
});

describe("decide, deny (Test 4)", () => {
  it("moves pending to denied with a denied audit row and no approved_at", () => {
    const proposal = submitPending();
    const result = store.decide(decideInput(proposal, { decision: "deny" }));
    expect(result.kind).toBe("denied");
    if (result.kind !== "denied") return;
    expect(result.proposal.state).toBe("denied");
    expect(result.proposal.approvedAt).toBeNull();
    expect(result.proposal.decidedAt).toBe(at(60_000));
    expect(result.proposal.decidedVia).toBe("plugin");
    expect(auditEvents(proposal.proposalId)).toEqual(["requested", "denied"]);
  });
});

describe("decide, refusals (Test 5)", () => {
  it("a wrong hash changes nothing and writes no audit row", () => {
    const proposal = submitPending();
    const before = rowOf(proposal.proposalId);
    const result = store.decide(decideInput(proposal, { expectedHash: sha256("something else") }));
    expect(result).toEqual({ kind: "hash-mismatch" });
    expect(rowOf(proposal.proposalId)).toEqual(before);
    expect(auditEvents(proposal.proposalId)).toEqual(["requested"]);
  });

  it("a second decide cannot succeed and reports the current state", () => {
    const proposal = submitPending();
    expect(store.decide(decideInput(proposal)).kind).toBe("approved");
    expect(store.decide(decideInput(proposal))).toEqual({
      kind: "already-decided",
      state: "approved",
    });
    expect(store.decide(decideInput(proposal, { decision: "deny" }))).toEqual({
      kind: "already-decided",
      state: "approved",
    });
    expect(auditEvents(proposal.proposalId)).toEqual(["requested", "approved"]);
  });

  it("an unknown id returns not-found", () => {
    expect(
      store.decide({
        proposalId: newProposalId(),
        decision: "approve",
        expectedHash: sha256("x"),
        now: T0,
        via: "plugin",
      }),
    ).toEqual({ kind: "not-found" });
  });

  it("treats the exact expiry instant and one millisecond after as expired, and one millisecond before as live", () => {
    const expiresAt = at(HOUR);
    const early = submitPending({ expiresAt });
    expect(store.decide(decideInput(early, { now: at(HOUR - 1) })).kind).toBe("approved");

    const exact = submitPending({ expiresAt });
    const exactResult = store.decide(decideInput(exact, { now: expiresAt }));
    expect(exactResult.kind).toBe("expired");
    if (exactResult.kind === "expired") expect(exactResult.proposal.state).toBe("expired");
    expect(auditEvents(exact.proposalId)).toEqual(["requested", "expired"]);
    expect(rowOf(exact.proposalId).state).toBe("expired");

    const late = submitPending({ expiresAt });
    expect(store.decide(decideInput(late, { now: at(HOUR + 1) })).kind).toBe("expired");
    expect(auditEvents(late.proposalId)).toEqual(["requested", "expired"]);
  });

  it("an expiry noticed at decide time is not a decision by the owner", () => {
    const proposal = submitPending();
    store.decide(decideInput(proposal, { now: at(2 * HOUR), via: "plugin" }));
    const expired = auditRows(proposal.proposalId)[1];
    expect(expired?.event).toBe("expired");
    expect(expired?.decided_via).toBeNull();
  });

  it("an expired proposal is refused before its hash is compared", () => {
    const proposal = submitPending();
    const result = store.decide(
      decideInput(proposal, { now: at(2 * HOUR), expectedHash: sha256("wrong") }),
    );
    expect(result.kind).toBe("expired");
  });

  it("refuses a malformed now rather than comparing it as a string", () => {
    const proposal = submitPending();
    for (const now of ["", "0", "2026-10-06", "9999", "2026-10-06T10:00:00Z"]) {
      expect(() => store.decide(decideInput(proposal, { now }))).toThrow();
    }
    expect(rowOf(proposal.proposalId).state).toBe("pending");
  });
});

describe("decide, repeat after the deadline (Test 5b)", () => {
  const AFTER_DEADLINE = at(5 * HOUR);

  function repeatOnState(setup: (proposal: NewProposal) => ProposalState): void {
    const proposal = submitPending();
    const expectedState = setup(proposal);
    const auditBefore = auditRows();
    const rowBefore = rowOf(proposal.proposalId);
    for (const decision of ["approve", "deny"] as const) {
      const result = store.decide(decideInput(proposal, { decision, now: AFTER_DEADLINE }));
      expect(result).toEqual({ kind: "already-decided", state: expectedState });
    }
    expect(rowOf(proposal.proposalId)).toEqual(rowBefore);
    expect(auditRows()).toEqual(auditBefore);
  }

  it("denied", () => {
    repeatOnState((proposal) => {
      store.decide(decideInput(proposal, { decision: "deny" }));
      return "denied";
    });
  });

  it("approved", () => {
    repeatOnState((proposal) => {
      store.decide(decideInput(proposal));
      return "approved";
    });
  });

  it("executed", () => {
    repeatOnState((proposal) => {
      store.decide(decideInput(proposal));
      forceState(proposal.proposalId, ["executing", "executed"]);
      return "executed";
    });
  });

  it("already expired", () => {
    repeatOnState((proposal) => {
      store.decide(decideInput(proposal, { now: at(2 * HOUR) }));
      return "expired";
    });
  });
});

describe("decide, atomicity (Test 6)", () => {
  it("a failing audit insert rolls the state change back", () => {
    const proposal = submitPending();
    db.exec(
      "CREATE TEMP TRIGGER fail_approved BEFORE INSERT ON approval_audit WHEN NEW.event = 'approved' BEGIN SELECT RAISE(ABORT, 'audit down'); END;",
    );
    expect(() => store.decide(decideInput(proposal))).toThrow();
    const row = store.get(proposal.proposalId);
    expect(row?.state).toBe("pending");
    expect(row?.revision).toBe(1);
    expect(row?.approvedAt).toBeNull();
    expect(auditEvents(proposal.proposalId)).toEqual(["requested"]);
  });

  it("a failing audit insert also rolls back an expiry noticed at decide time", () => {
    const proposal = submitPending();
    db.exec(
      "CREATE TEMP TRIGGER fail_expired BEFORE INSERT ON approval_audit WHEN NEW.event = 'expired' BEGIN SELECT RAISE(ABORT, 'audit down'); END;",
    );
    expect(() => store.decide(decideInput(proposal, { now: at(2 * HOUR) }))).toThrow();
    expect(store.get(proposal.proposalId)?.state).toBe("pending");
  });
});

describe("decide, reserved and unknown operations (Test 7)", () => {
  it("refuses a hand-inserted reserved operation with a reserved outcome and changes nothing", () => {
    const proposal = submitPending({ operation: "vault.delete", subject: "note-1" });
    const before = rowOf(proposal.proposalId);
    for (const decision of ["approve", "deny"] as const) {
      expect(store.decide(decideInput(proposal, { decision }))).toEqual({
        kind: "operation-reserved",
      });
    }
    expect(rowOf(proposal.proposalId)).toEqual(before);
    expect(auditEvents(proposal.proposalId)).toEqual(["requested"]);
  });

  it("refuses an unknown operation and a non-approval operation the same way", () => {
    const unknown = submitPending({ operation: "invented.operation" });
    const noApproval = submitPending({ operation: "vault.write-note" });
    expect(store.decide(decideInput(unknown)).kind).toBe("operation-reserved");
    expect(store.decide(decideInput(noApproval)).kind).toBe("operation-reserved");
  });

  it("still approves an enabled operation", () => {
    const proposal = submitPending({ operation: "diagnostic.test" });
    expect(store.decide(decideInput(proposal)).kind).toBe("approved");
  });
});

describe("the stored row is an untrusted boundary", () => {
  it("rejects a state outside the ten at the database", () => {
    const proposal = submitPending();
    expect(() =>
      db
        .prepare("UPDATE proposals SET state = 'bogus' WHERE proposal_id = ?")
        .run(proposal.proposalId),
    ).toThrow();
  });

  it("throws, never guesses, when a stored enum was corrupted behind the store's back", () => {
    const proposal = submitPending();
    db.prepare("UPDATE proposals SET requester_kind = 'root' WHERE proposal_id = ?").run(
      proposal.proposalId,
    );
    expect(() => store.get(proposal.proposalId)).toThrow();
  });

  it("holds no payload, token or always-allow column in the audit table", () => {
    const columns = columnNames(db, "approval_audit");
    expect(columns).toEqual([
      "seq",
      "proposal_id",
      "event",
      "at",
      "decided_via",
      "payload_hash",
      "detail",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Task 2

/** An ISO time `ms` after T0, used for the lifecycle after approval. */
const APPROVED_AT = at(60_000);
const CLAIMED_AT = at(61_000);
const FINISHED_AT = at(62_000);

function approve(proposal: NewProposal): void {
  expect(store.decide(decideInput(proposal, { now: APPROVED_AT })).kind).toBe("approved");
}

function submitApproved(overrides: Partial<NewProposal> = {}): NewProposal {
  const proposal = submitPending(overrides);
  approve(proposal);
  return proposal;
}

function submitExecuting(overrides: Partial<NewProposal> = {}): NewProposal {
  const proposal = submitApproved(overrides);
  expect(store.claim(proposal.proposalId, { pid: 4242, startedAt: "t" }, CLAIMED_AT).kind).toBe(
    "claimed",
  );
  return proposal;
}

interface ExecutionRow {
  proposal_id: string;
  attempt: number;
  started_at: string;
  finished_at: string | null;
  result_code: string | null;
}

function executionRows(proposalId: string): ExecutionRow[] {
  return db
    .prepare("SELECT * FROM approval_executions WHERE proposal_id = ? ORDER BY attempt")
    .all(proposalId) as ExecutionRow[];
}

describe("claim (Test 1)", () => {
  it("moves approved to executing with the claim facts, attempt 1, a ledger row and a claimed audit row", () => {
    const proposal = submitApproved();
    const result = store.claim(
      proposal.proposalId,
      { pid: 4242, processStartedAt: "Tue Oct  6 10:00:00 2026", alive: true, note: null },
      CLAIMED_AT,
    );
    expect(result.kind).toBe("claimed");
    if (result.kind !== "claimed") return;
    expect(result.proposal.state).toBe("executing");
    expect(result.proposal.attempts).toBe(1);
    expect(result.proposal.revision).toBe(3);
    expect(result.proposal.claimFacts).toEqual({
      pid: 4242,
      processStartedAt: "Tue Oct  6 10:00:00 2026",
      alive: true,
      note: null,
    });
    expect(rowOf(proposal.proposalId).claimed_at).toBe(CLAIMED_AT);
    expect(executionRows(proposal.proposalId)).toEqual([
      {
        proposal_id: proposal.proposalId,
        attempt: 1,
        started_at: CLAIMED_AT,
        finished_at: null,
        result_code: null,
      },
    ]);
    const claimed = auditRows(proposal.proposalId).at(-1);
    expect(claimed?.event).toBe("claimed");
    expect(claimed?.at).toBe(CLAIMED_AT);
    expect(claimed?.payload_hash).toBe(proposal.payloadHash);
  });

  it("a second claim on the same row is lost and writes nothing", () => {
    const proposal = submitApproved();
    expect(store.claim(proposal.proposalId, { pid: 1 }, CLAIMED_AT).kind).toBe("claimed");
    const auditBefore = auditRows();
    const rowBefore = rowOf(proposal.proposalId);
    expect(store.claim(proposal.proposalId, { pid: 1 }, at(63_000))).toEqual({ kind: "lost" });
    expect(auditRows()).toEqual(auditBefore);
    expect(rowOf(proposal.proposalId)).toEqual(rowBefore);
    expect(executionRows(proposal.proposalId)).toHaveLength(1);
  });

  it("is lost for a pending row, an unknown id and every settled state", () => {
    const pending = submitPending();
    expect(store.claim(pending.proposalId, {}, CLAIMED_AT)).toEqual({ kind: "lost" });
    expect(store.claim(newProposalId(), {}, CLAIMED_AT)).toEqual({ kind: "lost" });
    const denied = submitPending();
    store.decide(decideInput(denied, { decision: "deny" }));
    expect(store.claim(denied.proposalId, {}, CLAIMED_AT)).toEqual({ kind: "lost" });
    expect(auditEvents(pending.proposalId)).toEqual(["requested"]);
    expect(executionRows(pending.proposalId)).toHaveLength(0);
  });

  it("refuses claim facts that are not flat JSON scalars", () => {
    const proposal = submitApproved();
    for (const facts of [
      { nested: { a: 1 } },
      { list: [1] },
      { bad: Number.NaN },
      { bad: Number.POSITIVE_INFINITY },
      { big: "x".repeat(5000) },
    ] as unknown as Record<string, never>[]) {
      expect(() => store.claim(proposal.proposalId, facts, CLAIMED_AT)).toThrow();
    }
    expect(rowOf(proposal.proposalId).state).toBe("approved");
  });

  it("reads a corrupted claim_facts_json as an invalid row rather than guessing", () => {
    const proposal = submitExecuting();
    db.prepare("UPDATE proposals SET claim_facts_json = ? WHERE proposal_id = ?").run(
      '{"nested":{"a":1}}',
      proposal.proposalId,
    );
    expect(() => store.get(proposal.proposalId)).toThrow();
    db.prepare("UPDATE proposals SET claim_facts_json = ? WHERE proposal_id = ?").run(
      "not json",
      proposal.proposalId,
    );
    expect(() => store.get(proposal.proposalId)).toThrow();
  });
});

describe("two connections racing (Test 2)", () => {
  let other: Database.Database;
  let otherStore: ReturnType<typeof createApprovalStore>;

  beforeEach(() => {
    other = openSecondConnection(dbPath);
    otherStore = createApprovalStore(other);
  });

  afterEach(() => {
    other.close();
  });

  it("exactly one connection wins decide and exactly one wins claim", () => {
    const proposal = submitPending();
    const winner = store.decide(decideInput(proposal, { now: APPROVED_AT }));
    const loser = otherStore.decide(decideInput(proposal, { now: at(60_500), via: "other" }));
    expect(winner.kind).toBe("approved");
    expect(loser).toEqual({ kind: "already-decided", state: "approved" });

    const claimWinner = otherStore.claim(proposal.proposalId, { pid: 1 }, CLAIMED_AT);
    const claimLoser = store.claim(proposal.proposalId, { pid: 1 }, at(61_500));
    expect(claimWinner.kind).toBe("claimed");
    expect(claimLoser).toEqual({ kind: "lost" });

    expect(auditEvents(proposal.proposalId)).toEqual(["requested", "approved", "claimed"]);
    expect(executionRows(proposal.proposalId)).toHaveLength(1);
    // The decision that won is the one recorded: the loser's channel never appears.
    expect(auditRows(proposal.proposalId)[1]?.decided_via).toBe("plugin");
  });

  it("a connection that read the row before the other committed cannot decide it again", () => {
    const proposal = submitPending();
    // The second connection has the row in its page cache before the first decides.
    expect(otherStore.get(proposal.proposalId)?.state).toBe("pending");
    expect(store.decide(decideInput(proposal, { decision: "deny", now: APPROVED_AT })).kind).toBe(
      "denied",
    );
    expect(otherStore.decide(decideInput(proposal, { now: at(60_500) }))).toEqual({
      kind: "already-decided",
      state: "denied",
    });
    expect(auditEvents(proposal.proposalId)).toEqual(["requested", "denied"]);
  });

  it("two connections submitting the same pending request produce one row", () => {
    const first = makeProposal({ subject: "same-subject" });
    const second = makeProposal({ subject: "same-subject" });
    expect(store.submit(first, CAPS).kind).toBe("created");
    const result = otherStore.submit(second, CAPS);
    expect(result.kind).toBe("deduped");
    if (result.kind === "deduped") expect(result.proposal.proposalId).toBe(first.proposalId);
    expect(db.prepare("SELECT count(*) AS n FROM proposals").get()).toEqual({ n: 1 });
  });
});

describe("finish (Test 3)", () => {
  it("records executed with the outcome, stamps finished_at, finishes the ledger row and audits executed", () => {
    const proposal = submitExecuting();
    const result = store.finish({
      proposalId: proposal.proposalId,
      state: "executed",
      code: "executed",
      note: "awaiting-exit",
      evidence: null,
      reconciled: false,
      now: FINISHED_AT,
    });
    expect(result?.state).toBe("executed");
    expect(result?.outcomeCode).toBe("executed");
    expect(result?.outcomeNote).toBe("awaiting-exit");
    expect(result?.revision).toBe(4);
    expect(rowOf(proposal.proposalId).finished_at).toBe(FINISHED_AT);
    expect(executionRows(proposal.proposalId)[0]).toMatchObject({
      finished_at: FINISHED_AT,
      result_code: "executed",
    });
    const last = auditRows(proposal.proposalId).at(-1);
    expect(last?.event).toBe("executed");
    expect(last?.at).toBe(FINISHED_AT);
  });

  it.each([
    ["failed", "execution-failed", false, "failed"],
    ["unknown", "outcome-not-confirmed", false, "outcome-unknown"],
    ["executed", "run-cancelled-same-process", true, "reconciled-executed"],
  ] as const)(
    "records %s (%s, reconciled %s) with the audit event %s",
    (state, code, reconciled, event) => {
      const proposal = submitExecuting();
      const result = store.finish({
        proposalId: proposal.proposalId,
        state,
        code,
        note: null,
        evidence: reconciled ? code : null,
        reconciled,
        now: FINISHED_AT,
      });
      expect(result?.state).toBe(state);
      expect(result?.outcomeNote).toBeNull();
      const last = auditRows(proposal.proposalId).at(-1);
      expect(last?.event).toBe(event);
      expect(last?.detail).toBe(code);
    },
  );

  it("returns null for a row that is not executing and writes nothing", () => {
    const pending = submitPending();
    const approved = submitApproved();
    const finished = submitExecuting();
    const input = (proposalId: ProposalIdLike) => ({
      proposalId,
      state: "executed" as const,
      code: "executed",
      note: null,
      evidence: null,
      reconciled: false,
      now: FINISHED_AT,
    });
    expect(store.finish(input(finished.proposalId))).not.toBeNull();
    const auditBefore = auditRows();
    for (const target of [pending, approved, finished]) {
      expect(store.finish(input(target.proposalId))).toBeNull();
    }
    expect(store.finish(input(newProposalId()))).toBeNull();
    expect(auditRows()).toEqual(auditBefore);
  });

  it("finishes the ledger row of the attempt that was running", () => {
    const proposal = submitExecuting();
    expect(store.beginRetry(proposal.proposalId, at(70_000)).kind).toBe("retrying");
    store.finish({
      proposalId: proposal.proposalId,
      state: "unknown",
      code: "outcome-not-confirmed",
      note: null,
      evidence: null,
      reconciled: false,
      now: at(71_000),
    });
    const ledger = executionRows(proposal.proposalId);
    expect(ledger.map((row) => row.finished_at)).toEqual([null, at(71_000)]);
  });

  it("refuses an outcome code or note that is free text", () => {
    const proposal = submitExecuting();
    const base = {
      proposalId: proposal.proposalId,
      state: "failed" as const,
      code: "execution-failed",
      note: null,
      evidence: null,
      reconciled: false,
      now: FINISHED_AT,
    };
    expect(() => store.finish({ ...base, code: "it went wrong, sorry" })).toThrow();
    expect(() => store.finish({ ...base, code: "" })).toThrow();
    expect(() => store.finish({ ...base, note: "line one\nline two" })).toThrow();
    expect(() => store.finish({ ...base, evidence: "x".repeat(200) })).toThrow();
    expect(() => store.finish({ ...base, state: "denied" as never })).toThrow();
    expect(rowOf(proposal.proposalId).state).toBe("executing");
  });
});

type ProposalIdLike = ReturnType<typeof newProposalId>;

describe("beginRetry (Test 4)", () => {
  it("increments attempts to 2, adds ledger attempt 2 and audits retried-after-restart", () => {
    const proposal = submitExecuting();
    const result = store.beginRetry(proposal.proposalId, at(70_000));
    expect(result.kind).toBe("retrying");
    if (result.kind !== "retrying") return;
    expect(result.proposal.attempts).toBe(2);
    expect(result.proposal.state).toBe("executing");
    expect(executionRows(proposal.proposalId).map((row) => [row.attempt, row.started_at])).toEqual([
      [1, CLAIMED_AT],
      [2, at(70_000)],
    ]);
    const last = auditRows(proposal.proposalId).at(-1);
    expect(last?.event).toBe("retried-after-restart");
    expect(last?.at).toBe(at(70_000));
  });

  it("a third attempt returns exhausted and writes nothing", () => {
    const proposal = submitExecuting();
    store.beginRetry(proposal.proposalId, at(70_000));
    const auditBefore = auditRows();
    expect(store.beginRetry(proposal.proposalId, at(71_000))).toEqual({ kind: "exhausted" });
    expect(auditRows()).toEqual(auditBefore);
    expect(executionRows(proposal.proposalId)).toHaveLength(2);
    expect(store.get(proposal.proposalId)?.attempts).toBe(2);
  });

  it("returns not-executing for a row in any other state or an unknown id", () => {
    const approved = submitApproved();
    const pending = submitPending();
    expect(store.beginRetry(approved.proposalId, at(70_000))).toEqual({ kind: "not-executing" });
    expect(store.beginRetry(pending.proposalId, at(70_000))).toEqual({ kind: "not-executing" });
    expect(store.beginRetry(newProposalId(), at(70_000))).toEqual({ kind: "not-executing" });
    expect(auditEvents(approved.proposalId)).toEqual(["requested", "approved"]);
  });
});

describe("withdraw (Test 5)", () => {
  it("moves a pending row to withdrawn with an audit row", () => {
    const proposal = submitPending();
    const result = store.withdraw(proposal.proposalId, at(5_000));
    expect(result?.state).toBe("withdrawn");
    expect(result?.decidedAt).toBe(at(5_000));
    expect(result?.revision).toBe(2);
    const last = auditRows(proposal.proposalId).at(-1);
    expect(last?.event).toBe("withdrawn");
    expect(last?.at).toBe(at(5_000));
  });

  it("refuses every other state and an unknown id", () => {
    const approved = submitApproved();
    const denied = submitPending();
    store.decide(decideInput(denied, { decision: "deny" }));
    const executing = submitExecuting();
    for (const target of [approved, denied, executing]) {
      expect(store.withdraw(target.proposalId, at(5_000))).toBeNull();
    }
    expect(store.withdraw(newProposalId(), at(5_000))).toBeNull();
    expect(auditEvents(approved.proposalId)).toEqual(["requested", "approved"]);
    expect(auditEvents(denied.proposalId)).toEqual(["requested", "denied"]);
  });
});

// ---------------------------------------------------------------------------
// Triggers (Tests 6, 7 and 8). The attack suites are plain functions over a
// database handle, so Test 8 runs the very same assertions against a database
// built from every real migration.

const APPEND_ONLY = /append-only/;

function snapshotTable(handle: Database.Database, table: string): unknown[] {
  return handle.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
}

function expectAborts(
  handle: Database.Database,
  table: string,
  sql: string,
  message: RegExp,
): void {
  const before = snapshotTable(handle, table);
  expect(() => handle.exec(sql), sql).toThrow(message);
  expect(snapshotTable(handle, table), `${table} unchanged after: ${sql}`).toEqual(before);
}

function runAuditAttacks(
  handle: Database.Database,
  handleStore: ReturnType<typeof createApprovalStore>,
): void {
  const proposal = makeProposal();
  expect(handleStore.submit(proposal, CAPS).kind).toBe("created");
  const seq = (handle.prepare("SELECT seq FROM approval_audit").get() as { seq: number }).seq;
  const insertColumns = "(seq, proposal_id, event, at, decided_via, payload_hash, detail)";
  const insertValues = `(${seq}, 'forged', 'approved', '${T0}', NULL, NULL, NULL)`;

  expectAborts(handle, "approval_audit", "UPDATE approval_audit SET event = 'denied'", APPEND_ONLY);
  expectAborts(
    handle,
    "approval_audit",
    `UPDATE approval_audit SET detail = 'x' WHERE seq = ${seq}`,
    APPEND_ONLY,
  );
  expectAborts(handle, "approval_audit", "DELETE FROM approval_audit", APPEND_ONLY);
  expectAborts(
    handle,
    "approval_audit",
    `INSERT OR REPLACE INTO approval_audit ${insertColumns} VALUES ${insertValues}`,
    APPEND_ONLY,
  );
  expectAborts(
    handle,
    "approval_audit",
    `REPLACE INTO approval_audit ${insertColumns} VALUES ${insertValues}`,
    APPEND_ONLY,
  );
  expectAborts(
    handle,
    "approval_audit",
    `INSERT INTO approval_audit ${insertColumns} VALUES ${insertValues} ON CONFLICT(seq) DO UPDATE SET event = 'denied'`,
    APPEND_ONLY,
  );
  // An ordinary append still works: the guard is not a blanket refusal.
  handle.exec(
    `INSERT INTO approval_audit (proposal_id, event, at) VALUES ('${proposal.proposalId}', 'withdrawn', '${T0}')`,
  );
  expect(handle.prepare("SELECT count(*) AS n FROM approval_audit").get()).toEqual({ n: 2 });
}

describe("audit triggers (Test 6)", () => {
  it("UPDATE, DELETE, INSERT OR REPLACE, REPLACE and upsert-update each abort and leave the table unchanged", () => {
    runAuditAttacks(db, store);
  });
});

const IDENTITY_COLUMNS = [
  "proposal_id",
  "operation",
  "subject",
  "payload_hash",
  "dedupe_key",
  "expires_at",
  "created_at",
  "requester_kind",
  "requester_label",
  "project_id",
  "run_id",
  "reason",
  "mirror_note_id",
  "supersedes",
] as const;

function runProposalAttacks(
  handle: Database.Database,
  handleStore: ReturnType<typeof createApprovalStore>,
): void {
  const make = (state: "pending" | "approved" | "executing" | "denied" | "executed") => {
    const proposal = makeProposal({ operation: "session.force-terminate" });
    expect(handleStore.submit(proposal, CAPS).kind).toBe("created");
    const id = proposal.proposalId;
    const step = (to: string) =>
      handle.prepare("UPDATE proposals SET state = ? WHERE proposal_id = ?").run(to, id);
    if (state === "denied") step("denied");
    if (state === "approved" || state === "executing" || state === "executed") step("approved");
    if (state === "executing" || state === "executed") step("executing");
    if (state === "executed") step("executed");
    return { proposal, id };
  };

  const pending = make("pending");
  const approved = make("approved");
  const executing = make("executing");
  const denied = make("denied");
  const executed = make("executed");
  const ILLEGAL = /illegal proposal state transition/;

  // Transition guard: skipping a step, going backwards and leaving a terminal state all abort.
  expectAborts(
    handle,
    "proposals",
    `UPDATE proposals SET state = 'executed' WHERE proposal_id = '${pending.id}'`,
    ILLEGAL,
  );
  expectAborts(
    handle,
    "proposals",
    `UPDATE proposals SET state = 'executing' WHERE proposal_id = '${pending.id}'`,
    ILLEGAL,
  );
  expectAborts(
    handle,
    "proposals",
    `UPDATE proposals SET state = 'pending' WHERE proposal_id = '${approved.id}'`,
    ILLEGAL,
  );
  expectAborts(
    handle,
    "proposals",
    `UPDATE proposals SET state = 'executed' WHERE proposal_id = '${approved.id}'`,
    ILLEGAL,
  );
  expectAborts(
    handle,
    "proposals",
    `UPDATE proposals SET state = 'approved' WHERE proposal_id = '${denied.id}'`,
    ILLEGAL,
  );
  expectAborts(
    handle,
    "proposals",
    `UPDATE proposals SET state = 'executing' WHERE proposal_id = '${executed.id}'`,
    ILLEGAL,
  );
  expectAborts(
    handle,
    "proposals",
    `UPDATE proposals SET state = 'pending' WHERE proposal_id = '${executing.id}'`,
    ILLEGAL,
  );
  expectAborts(
    handle,
    "proposals",
    `UPDATE proposals SET state = 'approved' WHERE proposal_id = '${executing.id}'`,
    ILLEGAL,
  );

  // Identity columns are immutable in every state.
  for (const column of IDENTITY_COLUMNS) {
    for (const target of [pending, approved, executing, denied, executed]) {
      expectAborts(
        handle,
        "proposals",
        `UPDATE proposals SET ${column} = 'changed-value' WHERE proposal_id = '${target.id}'`,
        /immutable/,
      );
    }
  }

  // The payload text cannot change while the request is live, nor be rewritten after a purge.
  const PURGE = /payload may only be purged/;
  for (const target of [pending, approved, executing]) {
    expectAborts(
      handle,
      "proposals",
      `UPDATE proposals SET payload_json = '{"x":1}' WHERE proposal_id = '${target.id}'`,
      PURGE,
    );
    expectAborts(
      handle,
      "proposals",
      `UPDATE proposals SET payload_json = NULL WHERE proposal_id = '${target.id}'`,
      PURGE,
    );
  }
  expectAborts(
    handle,
    "proposals",
    `UPDATE proposals SET payload_json = '{"x":1}' WHERE proposal_id = '${denied.id}'`,
    PURGE,
  );
  handle.exec(`UPDATE proposals SET payload_json = NULL WHERE proposal_id = '${denied.id}'`);
  expect(
    handle.prepare("SELECT payload_json FROM proposals WHERE proposal_id = ?").get(denied.id),
  ).toEqual({ payload_json: null });
  expectAborts(
    handle,
    "proposals",
    `UPDATE proposals SET payload_json = '{"forged":true}' WHERE proposal_id = '${denied.id}'`,
    PURGE,
  );
  handle.exec(`UPDATE proposals SET payload_json = NULL WHERE proposal_id = '${executed.id}'`);

  // Replacing a row, by any spelling, and deleting a row abort.
  const base = handle
    .prepare("SELECT * FROM proposals WHERE proposal_id = ?")
    .get(pending.id) as Record<string, unknown>;
  const columns = Object.keys(base);
  const asValues = (overrides: Record<string, string>) =>
    columns
      .map((column) => {
        const value = overrides[column] ?? base[column];
        return value === null || value === undefined
          ? "NULL"
          : typeof value === "number"
            ? String(value)
            : `'${String(value).replaceAll("'", "''")}'`;
      })
      .join(", ");
  const columnList = columns.join(", ");
  expectAborts(
    handle,
    "proposals",
    `INSERT OR REPLACE INTO proposals (${columnList}) VALUES (${asValues({ payload_hash: "f".repeat(64) })})`,
    /replace|exists|pending/,
  );
  expectAborts(
    handle,
    "proposals",
    `REPLACE INTO proposals (${columnList}) VALUES (${asValues({})})`,
    /replace|exists|pending/,
  );
  expectAborts(
    handle,
    "proposals",
    `INSERT INTO proposals (${columnList}) VALUES (${asValues({})}) ON CONFLICT(proposal_id) DO UPDATE SET state = 'executed'`,
    /replace|exists|pending/,
  );
  // REPLACE through the pending-dedupe unique index: a NEW id that collides on the key would delete the pending row.
  expectAborts(
    handle,
    "proposals",
    `INSERT OR REPLACE INTO proposals (${columnList}) VALUES (${asValues({ proposal_id: "zzzzzzzzzzzzzzzzzzzzzzzzz" })})`,
    /replace|exists|pending/,
  );
  expectAborts(handle, "proposals", "DELETE FROM proposals", /cannot be deleted/);
  expectAborts(
    handle,
    "proposals",
    `DELETE FROM proposals WHERE proposal_id = '${executed.id}'`,
    /cannot be deleted/,
  );
}

describe("proposals triggers (Test 7)", () => {
  it("abort skipped transitions, terminal exits, identity rewrites, early payload changes, replaces and deletes", () => {
    runProposalAttacks(db, store);
  });

  it("the store's own statements pass through every guard", () => {
    const proposal = submitPending();
    approve(proposal);
    store.claim(proposal.proposalId, { pid: 1 }, CLAIMED_AT);
    store.beginRetry(proposal.proposalId, at(70_000));
    store.finish({
      proposalId: proposal.proposalId,
      state: "executed",
      code: "executed",
      note: null,
      evidence: null,
      reconciled: false,
      now: FINISHED_AT,
    });
    expect(store.get(proposal.proposalId)?.state).toBe("executed");
  });
});

const EXPECTED_TRIGGERS = [
  "approval_audit_no_delete",
  "approval_audit_no_replace",
  "approval_audit_no_update",
  "proposals_identity_immutable",
  "proposals_no_delete",
  "proposals_no_replace",
  "proposals_payload_purge_only",
  "proposals_transition_guard",
];

function missingTriggers(handle: Database.Database): string[] {
  const present = triggerNames(handle);
  return EXPECTED_TRIGGERS.filter((name) => !present.includes(name));
}

describe("survival (Test 8, permanent)", () => {
  it("lists exactly the eight trigger names on a database built from every real migration", () => {
    const fresh = openMigratedMemoryDb();
    try {
      expect(triggerNames(fresh)).toEqual(EXPECTED_TRIGGERS);
      expect(missingTriggers(fresh)).toEqual([]);
    } finally {
      fresh.close();
    }
  });

  it("every audit and proposals attack still aborts against that fresh database", () => {
    const fresh = openMigratedMemoryDb();
    try {
      const freshStore = createApprovalStore(fresh);
      runAuditAttacks(fresh, freshStore);
      runProposalAttacks(fresh, freshStore);
    } finally {
      fresh.close();
    }
  });

  it("is not vacuous: a later migration that rebuilds a table and drops its triggers is caught", () => {
    const rebuildDir = mkdtempSync(join(tmpdir(), "ccc-approval-rebuild-"));
    const rebuilt = new Database(":memory:");
    try {
      for (const name of readdirSync(REAL_MIGRATIONS_DIR).filter((file) => file.endsWith(".sql"))) {
        copyFileSync(join(REAL_MIGRATIONS_DIR, name), join(rebuildDir, name));
      }
      // The classic drizzle-kit rebuild: new table, copy, DROP, RENAME. The DROP deletes the triggers.
      writeFileSync(
        join(rebuildDir, "9999_rebuild_proposals.sql"),
        [
          "CREATE TABLE `__new_proposals` AS SELECT * FROM `proposals`;",
          "DROP TABLE `proposals`;",
          "ALTER TABLE `__new_proposals` RENAME TO `proposals`;",
        ].join("\n"),
      );
      applyMigrations(rebuilt, rebuildDir);
      expect(missingTriggers(rebuilt)).toEqual([
        "proposals_identity_immutable",
        "proposals_no_delete",
        "proposals_no_replace",
        "proposals_payload_purge_only",
        "proposals_transition_guard",
      ]);
    } finally {
      rebuilt.close();
      rmSync(rebuildDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// APPR-05 and the compare-and-set statements (Tests 9 and 10)

describe("no always-allow column (Test 9, APPR-05)", () => {
  const FORBIDDEN =
    /always|remember|persist|preference|allow|blanket|auto.?approve|token|secret|credential/i;
  const TABLES = ["proposals", "approval_audit", "approval_executions", "diagnostic_effects"];

  it.each(TABLES)(
    "%s has no column named for an always-allow, remember or token concept",
    (table) => {
      const columns = columnNames(db, table);
      expect(columns.length).toBeGreaterThan(0);
      for (const column of columns) {
        expect(column, `${table}.${column}`).not.toMatch(FORBIDDEN);
      }
    },
  );

  it("the pattern would catch a bad column (the scan is not vacuous)", () => {
    for (const bad of [
      "always_allow",
      "remember_choice",
      "persist_ok",
      "preference",
      "allow_all",
      "blanket",
      "auto_approve",
      "api_token",
    ]) {
      expect(bad).toMatch(FORBIDDEN);
    }
  });

  it("approval_audit holds no payload body column", () => {
    for (const column of columnNames(db, "approval_audit")) {
      expect(column).not.toMatch(/payload_json|body|content|text|prompt|message|transcript/i);
    }
  });
});

describe("compare-and-set statements (Test 10)", () => {
  /** Makes every state UPDATE silently change zero rows, as if another writer had won, without raising. */
  function loseEveryRace(): void {
    db.exec(
      "CREATE TEMP TRIGGER lose_race BEFORE UPDATE OF state ON proposals BEGIN SELECT RAISE(IGNORE); END;",
    );
  }

  it("decide reports a lost compare-and-set as already-decided and writes no audit row", () => {
    const proposal = submitPending();
    loseEveryRace();
    expect(store.decide(decideInput(proposal))).toEqual({
      kind: "already-decided",
      state: "pending",
    });
    expect(store.decide(decideInput(proposal, { now: at(2 * HOUR) }))).toEqual({
      kind: "already-decided",
      state: "pending",
    });
    expect(auditEvents(proposal.proposalId)).toEqual(["requested"]);
  });

  it("claim, finish, beginRetry and withdraw report a lost compare-and-set and write nothing", () => {
    const approved = submitApproved();
    const executing = submitExecuting();
    const pending = submitPending();
    const auditBefore = auditRows();
    const ledgerBefore = db.prepare("SELECT * FROM approval_executions ORDER BY rowid").all();
    loseEveryRace();
    expect(store.claim(approved.proposalId, { pid: 1 }, CLAIMED_AT)).toEqual({ kind: "lost" });
    expect(
      store.finish({
        proposalId: executing.proposalId,
        state: "executed",
        code: "executed",
        note: null,
        evidence: null,
        reconciled: false,
        now: FINISHED_AT,
      }),
    ).toBeNull();
    expect(store.withdraw(pending.proposalId, at(5_000))).toBeNull();
    expect(auditRows()).toEqual(auditBefore);
    expect(db.prepare("SELECT * FROM approval_executions ORDER BY rowid").all()).toEqual(
      ledgerBefore,
    );
  });

  it("beginRetry reports a lost compare-and-set on the attempt count", () => {
    const executing = submitExecuting();
    db.exec(
      "CREATE TEMP TRIGGER lose_retry BEFORE UPDATE OF attempts ON proposals BEGIN SELECT RAISE(IGNORE); END;",
    );
    const auditBefore = auditRows();
    expect(store.beginRetry(executing.proposalId, at(70_000))).toEqual({ kind: "lost" });
    expect(auditRows()).toEqual(auditBefore);
    expect(executionRows(executing.proposalId)).toHaveLength(1);
  });

  it("every state-changing statement in the store is a compare-and-set on its source state", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(join(import.meta.dirname, "approval-store.ts"), "utf8");
    const updates = source.match(/UPDATE proposals[\s\S]*?(?:`|")/g) ?? [];
    const stateUpdates = updates.filter((statement) => /SET[\s\S]*\bstate\s*=/.test(statement));
    expect(stateUpdates.length).toBeGreaterThanOrEqual(6);
    for (const statement of stateUpdates) {
      expect(statement).toMatch(/WHERE[\s\S]*\bstate\s*=\s*'(pending|approved|executing)'/);
    }
  });
});
