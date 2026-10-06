import {
  type ApprovalSummary,
  ApprovalSummarySchema,
  HOSTILE_CORPUS,
  type NoteId,
  type ProposalId,
  type StoredProposal,
} from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { summaryOf } from "./view.js";

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
