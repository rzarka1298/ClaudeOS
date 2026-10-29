import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APPROVAL_DECIDE_PATH,
  APPROVAL_GET_PATH,
  APPROVAL_TEST_PATH,
  type ApprovalDetailResponse,
  ApprovalUpsertedPayloadSchema,
  canonicalJson,
  DECIDED_VIA_HEADER,
  DECIDED_VIA_PLUGIN,
  type DecideResponse,
  newProposalId,
} from "@ccc/domain";
import { type OperationalStore, openStore } from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authedRequest,
  collectEvents,
  handshake,
  independentDecisionProof,
  type ProofRowFields,
  readThrowawayInstallSecret,
  setUpServiceEnvironment,
  tearDownServiceEnvironment,
} from "./approval-int-support.js";
import { startServiceForTest } from "./service-harness.js";
import { withTempSocketDir } from "./socket-fixture.js";

/**
 * Approved-row integrity across a real restart (plan 09-17, D-03, R-05, APPR-12, T-09-34, T-09-35).
 * The real, built service runs on a throwaway runtime directory and a throwaway Keychain account. It is
 * stopped, rows are written into its SQLite file by hand (as a same-user process could), and it is
 * started again: recovery must carry out none of them, and the genuinely approved row is left alone.
 *
 * The forged proofs are made here, without the service's key: a copied proof, a well-formed proof with
 * a random MAC, one MAC-signed under another key (computed independently of the service's own proof
 * module), and no proof at all. A same-user process that could read the Keychain secret could make a
 * valid MAC; that residual is why presence-required rows also need the OS-anchored signature (09-18).
 */

let account: string;

beforeEach(() => {
  account = setUpServiceEnvironment();
});

afterEach(() => {
  tearDownServiceEnvironment(account);
});

const PLUGIN_HEADERS = { [DECIDED_VIA_HEADER]: DECIDED_VIA_PLUGIN };
const PROOF_INVALID = "proof-invalid";

interface TestResponse {
  readonly outcome: "proposed" | "already-pending";
  readonly proposalId: string;
}

/** The operational store's database handle, named without importing the SQLite binding. */
type Db = OperationalStore["db"];

type Row = Record<string, unknown>;

/** A well-formed proof with the given MAC (the strict shape the service stores). */
function proofText(mac: string): string {
  return canonicalJson({ v: 1, mac, presence: null });
}

/** The fields a proof covers, read off a hand-made row. */
function coveredFields(row: Row): ProofRowFields {
  return {
    proposalId: row.proposal_id as string,
    operation: row.operation as string,
    payloadHash: row.payload_hash as string,
    approvedAt: row.approved_at as string,
    decidedVia: row.decided_via as string,
  };
}

function insertRow(db: Db, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO proposals (${columns.join(", ")}) VALUES (${columns.map((c) => `@${c}`).join(", ")})`,
  ).run(row);
}

type Kind = "approved" | "executing";

/** A copy of `template` as a hand-made row of `state`, with this proof (null: none). */
function handMade(template: Row, kind: Kind, proof: string | null, label: string): Row {
  const id = newProposalId() as string;
  const now = new Date().toISOString();
  return {
    ...template,
    proposal_id: id,
    dedupe_key: `diagnostic.test:${label}-${id}`,
    state: kind,
    approved_at: now,
    decided_at: now,
    decided_via: "plugin",
    claimed_at: kind === "executing" ? now : null,
    claim_facts_json: kind === "executing" ? "{}" : null,
    finished_at: null,
    attempts: kind === "executing" ? 1 : 0,
    outcome_code: null,
    outcome_note: null,
    revision: 1,
    decision_proof: proof,
  };
}

function rowOf(db: Db, id: string): Row {
  return db.prepare("SELECT * FROM proposals WHERE proposal_id = ?").get(id) as Row;
}

function effectIds(db: Db): string[] {
  return (
    db.prepare("SELECT proposal_id FROM diagnostic_effects ORDER BY proposal_id").all() as {
      proposal_id: string;
    }[]
  ).map((r) => r.proposal_id);
}

/** The result code of every attempt row; the claim writes one when it takes an approved row, so a refused row has one ended `proof-invalid`. */
function attemptResults(db: Db): { proposal_id: string; result_code: string | null }[] {
  return db.prepare("SELECT proposal_id, result_code FROM approval_executions").all() as {
    proposal_id: string;
    result_code: string | null;
  }[];
}

function logLines(dir: string): Record<string, unknown>[] {
  const text = readFileSync(join(dir, "logs", "service.log"), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

describe("hand-written approved and executing rows are not carried out after a restart (09-17 Task 2, Test 5)", () => {
  it("refuses rows with no proof, a copied proof, a wrong MAC and a MAC under another key; leaves the genuine row alone", async () => {
    await withTempSocketDir(async ({ dir, socketPath }) => {
      const dbPath = join(dir, "operational.db");

      // --- First run: one genuine approval through the routes (it carries the service's own proof).
      const first = await startServiceForTest({ socketPath, dbPath });
      let genuineId: string;
      let templateId: string;
      try {
        const token = await handshake(socketPath);
        const stream = collectEvents(socketPath, token);
        try {
          const raised = await authedRequest<TestResponse>(socketPath, token, {
            method: "POST",
            path: APPROVAL_TEST_PATH,
            body: {},
          });
          genuineId = raised.body.proposalId;
          const detail = await authedRequest<ApprovalDetailResponse>(socketPath, token, {
            method: "POST",
            path: APPROVAL_GET_PATH,
            body: { proposalId: genuineId },
          });
          const decided = await authedRequest<DecideResponse>(socketPath, token, {
            method: "POST",
            path: APPROVAL_DECIDE_PATH,
            body: {
              proposalId: genuineId,
              decision: "approve",
              payloadHash: detail.body.payloadHash,
            },
            headers: PLUGIN_HEADERS,
          });
          expect(decided.body.outcome).toBe("decided");
          await stream.waitFor((event) => {
            if (event.type !== "approval.upserted") return false;
            const parsed = ApprovalUpsertedPayloadSchema.safeParse(event.payload);
            return (
              parsed.success &&
              parsed.data.approval.proposalId === genuineId &&
              parsed.data.approval.state === "executed"
            );
          }, 10_000);
          // A second request, left pending: the template the hand-made rows are copied from.
          const second = await authedRequest<TestResponse>(socketPath, token, {
            method: "POST",
            path: APPROVAL_TEST_PATH,
            body: {},
          });
          templateId = second.body.proposalId;
        } finally {
          stream.close();
        }
      } finally {
        await first.stop();
      }

      // --- Between runs: write rows into the SQLite file by hand.
      const forged = {
        approvedNoProof: "",
        executingNoProof: "",
        approvedCopied: "",
        approvedWrongMac: "",
        approvedOtherKey: "",
        executingWrongMac: "",
        updatedForged: "",
        approvedValid: "",
      };
      {
        const handle = openStore(dbPath);
        try {
          const db = handle.db;
          const genuine = rowOf(db, genuineId);
          expect(
            genuine.decision_proof,
            "the genuine approval carries the service's proof",
          ).toEqual(expect.stringMatching(/^\{"mac":"[0-9a-f]{64}","presence":null,"v":1\}$/));
          const template = rowOf(db, templateId);
          expect(template.state).toBe("pending");

          const randomMac = (): string => randomBytes(32).toString("hex");
          const otherKey = randomBytes(32);

          const approvedNoProof = handMade(template, "approved", null, "no-proof");
          const executingNoProof = handMade(template, "executing", null, "exec-no-proof");
          const approvedCopied = handMade(
            template,
            "approved",
            genuine.decision_proof as string,
            "copied",
          );
          const approvedWrongMac = handMade(
            template,
            "approved",
            proofText(randomMac()),
            "wrong-mac",
          );
          const approvedOtherKey = handMade(template, "approved", null, "other-key");
          approvedOtherKey.decision_proof = independentDecisionProof(
            otherKey,
            coveredFields(approvedOtherKey),
          );
          // The positive control: a row carrying the MAC under the REAL secret is carried out. That is
          // the detection floor's residual (a holder of the Keychain secret can make a valid MAC), the
          // reason a presence-required row also needs the OS-anchored signature (09-18).
          const approvedValid = handMade(template, "approved", null, "valid-mac");
          approvedValid.decision_proof = independentDecisionProof(
            readThrowawayInstallSecret(account),
            coveredFields(approvedValid),
          );
          insertRow(db, approvedValid);
          forged.approvedValid = approvedValid.proposal_id as string;
          const executingWrongMac = handMade(
            template,
            "executing",
            proofText(randomMac()),
            "exec-wrong-mac",
          );
          for (const row of [
            approvedNoProof,
            executingNoProof,
            approvedCopied,
            approvedWrongMac,
            approvedOtherKey,
            executingWrongMac,
          ]) {
            insertRow(db, row);
          }
          forged.approvedNoProof = approvedNoProof.proposal_id as string;
          forged.executingNoProof = executingNoProof.proposal_id as string;
          forged.approvedCopied = approvedCopied.proposal_id as string;
          forged.approvedWrongMac = approvedWrongMac.proposal_id as string;
          forged.approvedOtherKey = approvedOtherKey.proposal_id as string;
          forged.executingWrongMac = executingWrongMac.proposal_id as string;

          // The trigger permits a pending row to become approved with a proof set in the same update:
          // a forged proof in that shape must fail the MAC check, not the trigger.
          const now = new Date().toISOString();
          db.prepare(
            `UPDATE proposals SET state = 'approved', approved_at = ?, decided_at = ?, decided_via = 'plugin', decision_proof = ? WHERE proposal_id = ?`,
          ).run(now, now, proofText(randomMac()), templateId);
          forged.updatedForged = templateId;

          expect(effectIds(db)).toEqual([genuineId]);
        } finally {
          handle.close();
        }
      }

      // --- Second run: recovery runs before the socket opens.
      const second = await startServiceForTest({ socketPath, dbPath });
      try {
        const handle = openStore(dbPath);
        try {
          const db = handle.db;
          const approvedKinds = [
            forged.approvedNoProof,
            forged.approvedCopied,
            forged.approvedWrongMac,
            forged.approvedOtherKey,
            forged.updatedForged,
          ];
          const executingKinds = [forged.executingNoProof, forged.executingWrongMac];
          for (const id of approvedKinds) {
            const row = rowOf(db, id);
            expect(row.state, `approved ${id}`).toBe("failed");
            expect(row.outcome_code).toBe(PROOF_INVALID);
          }
          for (const id of executingKinds) {
            const row = rowOf(db, id);
            expect(row.state, `executing ${id}`).toBe("unknown");
            expect(row.outcome_code).toBe(PROOF_INVALID);
          }
          // The control row (a valid MAC under the real secret) is carried out; recovery does not wait
          // for the effect, so poll for it.
          const deadline = Date.now() + 10_000;
          while (rowOf(db, forged.approvedValid).state !== "executed" && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          expect(rowOf(db, forged.approvedValid).state).toBe("executed");
          // Nothing was carried out for any refused row; only the genuine row and the control ran.
          expect(effectIds(db)).toEqual([genuineId, forged.approvedValid].sort());
          for (const attempt of attemptResults(db)) {
            // The claim of a refused row ended as the refusal, not as an effect.
            const ran =
              attempt.proposal_id === genuineId || attempt.proposal_id === forged.approvedValid;
            expect(attempt.result_code, attempt.proposal_id).toBe(ran ? "executed" : PROOF_INVALID);
          }
          expect(rowOf(db, genuineId).state).toBe("executed");

          // A warning per refused row, naming only the id and the fixed code.
          const warnings = logLines(dir).filter((line) => line.code === "approval-proof-invalid");
          const warned = new Set(warnings.map((line) => line.proposalId));
          for (const id of [...approvedKinds, ...executingKinds]) {
            expect(warned.has(id), `a warning names ${id}`).toBe(true);
          }
          expect(warnings.length).toBeGreaterThanOrEqual(7);
        } finally {
          handle.close();
        }
      } finally {
        await second.stop();
      }
    });
  }, 60_000);
});
