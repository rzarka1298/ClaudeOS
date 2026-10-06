import { APPROVAL_AUDIT_EVENTS, PROPOSAL_STATES } from "@ccc/domain/approval.js";
import { APPROVAL_STATE_DISPLAY } from "@ccc/domain/approval-view.js";
import { describe, expect, it } from "vitest";
import {
  APPROVAL_STATUS,
  APPROVALS_HEADING,
  APPROVE_LABEL,
  COMPUTED_CAPTION,
  DECIDED_THROUGH,
  DECISION_GROUP_LABEL,
  DENY_LABEL,
  DISABLED_REASONS,
  denyName,
  destructiveSublabel,
  expiryParts,
  FAILED_REASON_LABELS,
  failedReason,
  HISTORY_LABEL,
  OPEN_RUN_LABEL,
  providedByCaption,
  REQUESTER_KIND_LABEL,
  stateExplanation,
} from "./approvals-copy.js";

const NOW = Date.parse("2026-10-06T12:00:00.000Z");

describe("the locked strings (UI-SPEC Copywriting Contract, Test 8)", () => {
  it("states the section heading and the three decision controls verbatim", () => {
    expect(APPROVALS_HEADING).toBe("Approvals");
    expect(DENY_LABEL).toBe("Deny");
    expect(APPROVE_LABEL).toBe("Approve once");
    expect(OPEN_RUN_LABEL).toBe("Open originating run");
    expect(DECISION_GROUP_LABEL).toBe("Decision");
  });

  it("takes the state labels from the single display map, verbatim", () => {
    expect(APPROVAL_STATE_DISPLAY.pending.label).toBe("Needs your decision");
    expect(APPROVAL_STATE_DISPLAY.executed.label).toBe("Carried out");
    expect(APPROVAL_STATE_DISPLAY.executing.label).toBe("Carrying out");
    expect(APPROVAL_STATE_DISPLAY.unknown.label).toBe("Outcome unknown");
    expect(APPROVAL_STATE_DISPLAY.expired.label).toBe("Expired — denied automatically");
  });

  it("builds the provenance captions from the engine-assigned kind", () => {
    expect(COMPUTED_CAPTION).toBe("Computed by the command center");
    expect(providedByCaption("skill", "research-brief")).toBe("Provided by Skill: research-brief");
    expect(providedByCaption("dashboard", "System")).toBe("Provided by Dashboard: System");
    expect(Object.keys(REQUESTER_KIND_LABEL).sort()).toEqual([
      "automation",
      "connector",
      "dashboard",
      "skill",
    ]);
  });

  it("builds the accessible names and the destructive sub-label", () => {
    expect(denyName("Force-terminate Refactor parser")).toBe("Deny: Force-terminate Refactor parser");
    expect(destructiveSublabel("force-terminate Refactor parser")).toBe(
      "This will force-terminate Refactor parser.",
    );
  });

  it("states every disabled reason verbatim", () => {
    expect(DISABLED_REASONS.disconnected).toBe("The companion service isn't running.");
    expect(DISABLED_REASONS.loading).toBe("Loading the full request…");
    expect(DISABLED_REASONS.stale).toBe("This list may be out of date. Refresh, then decide.");
    expect(DISABLED_REASONS.expired).toBe("This request has expired.");
    expect(DISABLED_REASONS.tooLarge).toBe(
      "This change is too large to review here, so it can't be approved from here.",
    );
    expect(DISABLED_REASONS.noRun).toBe("This request didn't come from a run.");
    expect(DISABLED_REASONS.runNotLoaded).toBe("That run isn't in the loaded history.");
  });

  it("states every status line verbatim", () => {
    expect(APPROVAL_STATUS.sending).toBe("Sending your decision…");
    expect(APPROVAL_STATUS.approved).toBe("Approved. Carrying out the action…");
    expect(APPROVAL_STATUS.denied).toBe("Denied. Nothing was changed.");
    expect(APPROVAL_STATUS.hashMismatch).toBe(
      "This request changed after you opened it. Review the updated details before deciding.",
    );
    expect(APPROVAL_STATUS.expiredDuringDecide).toBe(
      "This request expired and was denied automatically. Nothing was changed.",
    );
    expect(APPROVAL_STATUS.alreadyDecided).toBe("This request was already decided.");
    expect(APPROVAL_STATUS.notFound).toBe("That request isn't in the inbox.");
    expect(APPROVAL_STATUS.transport).toBe(
      "Couldn't send your decision: the companion service didn't respond within 5 seconds. Checking whether it went through…",
    );
    expect(APPROVAL_STATUS.notThrough).toBe("It did not go through. You can decide again.");
    expect(APPROVAL_STATUS.confirmFailed).toBe(
      "Couldn't confirm whether your decision went through. Refresh the list before deciding again.",
    );
  });

  it("names who made a decision in a fixed vocabulary", () => {
    expect(DECIDED_THROUGH.plugin).toBe("The command center");
    expect(DECIDED_THROUGH.other).toBe("Another local client");
  });

  it("labels every audit event, and only from the fixed history vocabulary", () => {
    expect(Object.keys(HISTORY_LABEL).sort()).toEqual([...APPROVAL_AUDIT_EVENTS].sort());
    expect(new Set(Object.values(HISTORY_LABEL))).toEqual(
      new Set([
        "Requested",
        "Approved",
        "Denied",
        "Expired",
        "Withdrawn",
        "Started carrying out",
        "Carried out",
        "Failed",
        "Outcome unknown",
        "Retried after a restart",
        "Lapsed",
      ]),
    );
  });
});

describe("failed reasons (fixed vocabulary, never a path or an error message)", () => {
  it("maps the retry-style codes to their fixed phrases", () => {
    expect(failedReason("process-ended").text).toBe("the session's process had already ended");
    expect(failedReason("run-not-found").text).toBe("that session is no longer listed");
    expect(failedReason("identity-mismatch").text).toBe(
      "the process no longer matches the one you approved",
    );
  });

  it("sends every other code, and an absent one, to the last phrase with the diagnostics hint", () => {
    for (const code of [
      "execution-failed",
      "capability-refused",
      "payload-invalid",
      "executor-threw",
      "reconcile-threw",
      "token-expired",
      "integrity-check-failed",
      null,
      "something-new",
    ]) {
      const reason = failedReason(code);
      expect(reason.text).toBe("the command center couldn't run it");
      expect(reason.diagnostics).toBe(true);
    }
    expect(FAILED_REASON_LABELS).toHaveLength(4);
  });
});

describe("state explanations (UI-SPEC State rendering)", () => {
  const base = {
    nowMs: NOW,
    expiresAt: "2026-10-06T12:14:00.000Z",
    requestedAt: "2026-10-06T11:59:00.000Z",
    decidedAt: "2026-10-06T11:59:30.000Z",
    executedAt: "2026-10-06T11:59:40.000Z",
    outcomeCode: null,
    checkHint: "Check it.",
    awaitingExit: false,
  } as const;

  it("covers all ten states with non-empty text", () => {
    for (const state of PROPOSAL_STATES) {
      const lines = stateExplanation({ ...base, state });
      expect(lines.join(" ").length, state).toBeGreaterThan(0);
    }
  });

  it("never says Failed outside the failed state, whatever the outcome code", () => {
    for (const state of PROPOSAL_STATES.filter((s) => s !== "failed")) {
      const text = stateExplanation({ ...base, state, outcomeCode: "process-ended" }).join(" ");
      expect(text, state).not.toMatch(/\bfailed\b/i);
    }
  });

  it("adds the one fixed sentence for a carried-out request whose process is still shutting down", () => {
    const withNote = stateExplanation({ ...base, state: "executed", awaitingExit: true });
    expect(withNote).toContain("Carried out. The session is still shutting down.");
    const without = stateExplanation({ ...base, state: "executed", awaitingExit: false });
    expect(without.join(" ")).not.toContain("still shutting down");
  });

  it("phrases the countdown with the shared duration formatter and flags the last five minutes", () => {
    const soon = expiryParts(NOW, "2026-10-06T12:04:00.000Z");
    expect(soon.kind).toBe("counting");
    if (soon.kind === "counting") {
      expect(soon.phrase).toBe("Expires in 4 min");
      expect(soon.urgent).toBe(true);
    }
    const later = expiryParts(NOW, "2026-10-06T12:14:00.000Z");
    if (later.kind === "counting") expect(later.urgent).toBe(false);
    expect(expiryParts(NOW, "2026-10-06T12:00:00.000Z").kind).toBe("expiring");
    expect(expiryParts(NOW, "2026-10-06T11:59:00.000Z").kind).toBe("expiring");
  });
});
