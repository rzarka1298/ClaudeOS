import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ApprovalAuditEvent,
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
    const creates =
      sql.match(/CREATE\s+(UNIQUE\s+)?(TABLE|INDEX|TRIGGER)\s+(IF NOT EXISTS\s+)?/g) ?? [];
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
