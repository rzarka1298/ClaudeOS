import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunId, SessionView } from "@ccc/domain";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ApprovalsApi, configureApprovalsApi } from "../approvals/api.js";
import {
  adoptApprovalsSnapshot,
  resetApprovalsState,
  selectedProposalId,
} from "../approvals/signals.js";
import { connectionState } from "../connection-state.js";
import { approvalsSnapshot, summary } from "../test-support/approval-fixtures.js";
import {
  approvalDetail,
  approvalView,
  FIXTURE_NOW_MS,
  RUN_ID,
} from "../test-support/approval-view-fixtures.js";
import { sessionsById } from "../widgets/session-signals.js";
import { AgentRuns } from "./agent-runs.js";
import { selectedRunId } from "./agent-runs-state.js";
import { resetApprovalsView } from "./approvals-state.js";

/**
 * The accessibility floors that apply to the Approvals section (UI-SPEC
 * "Accessibility additions", Non-Negotiables 3, 5, 7; APPR-05, T-06-13).
 *
 * The phrase scan covers only the approval view files this phase created, never
 * `agent-runs*.tsx`: the Phase 5 summary-line segment and the session-detail
 * Run state legitimately say the phrase the inbox must never use (checker FLAG 1).
 * The exemption is the list below, not a pattern that could swallow a new file.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** Every approval view file from plan 06-11 and this plan. A new one is added here. */
const APPROVAL_FILES = [
  "approvals-copy.ts",
  "approval-detail.tsx",
  "approval-decision.tsx",
  "approval-diff.tsx",
  "approval-text.tsx",
  "approvals-section.tsx",
  "approvals-state.ts",
] as const;

const SOURCES = APPROVAL_FILES.map(
  (file) => [file, readFileSync(join(HERE, file), "utf8")] as const,
);

const STANDING_CHOICE: readonly RegExp[] = [
  /always[\s_-]*(allow|approve|permit|accept)/i,
  /\bremember(s|ed|ing)?\b/i,
  /don'?t\s+ask\s+again/i,
  /\bstop\s+asking\b/i,
  /\bnever\s+ask\b/i,
  /for\s+this\s+session/i,
  /\bpermanent(ly)?\b/i,
  /\bstanding\s+(approval|permission|choice)\b/i,
];

describe("the disambiguation scan covers the approval view files and exempts the Phase 5 files", () => {
  it.each(SOURCES)("%s never uses the Run state's phrase for an inbox request", (file, source) => {
    expect(source.match(/waiting\s+for\s+approval/i)?.[0], file).toBeUndefined();
  });

  it.each(SOURCES)("%s never says Proposal", (file, source) => {
    expect(source.match(/\bproposals?\b/i)?.[0], file).toBeUndefined();
  });

  it("scans no Phase 5 file, and the Phase 5 summary segment still carries its phrase untouched", () => {
    expect(APPROVAL_FILES.some((file) => file.startsWith("agent-runs"))).toBe(false);
    const agentRuns = readFileSync(join(HERE, "agent-runs.tsx"), "utf8");
    expect(agentRuns).toContain("waiting for approval");
  });
});

describe("APPR-05: nothing in the Agent runs destination offers, stores or implies an always-allow", () => {
  it.each(SOURCES)("%s offers no standing choice of any kind", (file, source) => {
    for (const pattern of STANDING_CHOICE) {
      expect(source.match(pattern)?.[0], `${file} matches ${pattern}`).toBeUndefined();
    }
  });

  it.each(SOURCES)(
    "%s keeps nothing in browser storage or the plugin's saved data",
    (file, source) => {
      expect(source, file).not.toMatch(
        /localStorage|sessionStorage|indexedDB|\bsaveData\b|\bloadData\b/,
      );
    },
  );

  it.each(SOURCES)("%s reads no ambient clock and sets no inline style", (file, source) => {
    expect(source, file).not.toMatch(/Date\.now\s*\(/);
    expect(source, file).not.toMatch(/new\s+Date\s*\(\s*\)/);
    expect(source, file).not.toMatch(/performance\.now/);
    expect(source, file).not.toMatch(/\bstyle\s*=/);
    expect(source, file).not.toMatch(/\.style\b/);
  });
});

function runIdOf(n: number): RunId {
  return `0mfk1a2b3c4d5e6f7a8b9c0d${(n % 36).toString(36)}` as RunId;
}

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    runId: RUN_ID as RunId,
    revision: 1,
    claudeSessionId: "claude-session-1",
    state: "running",
    activity: "working",
    projectId: "proj-alpha",
    projectName: "example-project",
    name: "Refactor parser",
    model: null,
    effort: null,
    launchSource: "terminal",
    permissionMode: null,
    claudeVersion: null,
    startedAt: "2026-10-06T11:00:00.000Z",
    endedAt: null,
    lastActivityAt: "2026-10-06T11:59:30.000Z",
    subagents: { active: 0, lastType: null },
    lastError: null,
    linkKind: null,
    linkedFromRunId: null,
    cwdBasename: null,
    worktreeBasename: null,
    hasTranscript: false,
    terminateRequested: false,
    hasConversation: true,
    ...overrides,
  };
}

function setup(): { readonly container: Element } {
  const view = approvalView();
  const api: ApprovalsApi = {
    list: async () => approvalsSnapshot(),
    get: async () => approvalDetail(view),
    decide: async () => {
      throw new Error("decide was not expected");
    },
    test: async () => {
      throw new Error("test was not expected");
    },
  };
  configureApprovalsApi(api);
  sessionsById.value = new Map([
    [RUN_ID, session()],
    [runIdOf(2), session({ runId: runIdOf(2), name: "Other run" })],
  ]);
  connectionState.value = { kind: "live" };
  adoptApprovalsSnapshot(
    approvalsSnapshot({
      pending: [
        summary(1, "pending", 1, {
          title: view.title,
          expiresAt: view.expiresAt,
          runId: RUN_ID,
          projectName: "example-project",
        }),
        summary(2, "pending", 1, { expiresAt: "2026-10-06T13:00:00.000Z" }),
      ],
      decided: [summary(3, "denied", 2, { decidedAt: "2026-10-06T11:50:00.000Z" })],
    }),
  );
  return render(<AgentRuns now={FIXTURE_NOW_MS} />);
}

beforeEach(() => {
  resetApprovalsState();
  resetApprovalsView();
  sessionsById.value = new Map();
  selectedRunId.value = null;
});

afterEach(() => {
  cleanup();
  configureApprovalsApi(null);
  resetApprovalsState();
  resetApprovalsView();
  sessionsById.value = new Map();
  selectedRunId.value = null;
  connectionState.value = { kind: "connecting" };
});

async function openPane(container: Element): Promise<HTMLElement> {
  const section = container.querySelector("section.ccc-approvals") as HTMLElement;
  fireEvent.click(section.querySelector(".ccc-approval-row-button") as HTMLElement);
  await screen.findByRole("button", { name: /^Open originating run/ });
  return section;
}

describe("the rendered section meets the floors", () => {
  it("has exactly one polite status region, with the pane open", async () => {
    const { container } = setup();
    const section = await openPane(container);
    const statuses = section.querySelectorAll('[role="status"]');
    expect(statuses.length).toBe(1);
    expect(statuses[0]?.getAttribute("aria-live")).toBe("polite");
  });

  it("uses no native disabled attribute on any control", async () => {
    const { container } = setup();
    const section = await openPane(container);
    expect(section.querySelectorAll("[disabled]").length).toBe(0);
    for (const button of section.querySelectorAll("button")) {
      expect(button.hasAttribute("disabled")).toBe(false);
    }
  });

  it("keeps every control in the natural tab order: no positive tabindex, chips, rows, then the pane in order", async () => {
    const { container } = setup();
    const section = await openPane(container);
    for (const element of section.querySelectorAll("[tabindex]")) {
      expect(Number(element.getAttribute("tabindex"))).toBeLessThanOrEqual(0);
    }
    const chips = [...section.querySelectorAll(".ccc-filter-chip")];
    expect(chips.length).toBe(3);
    for (const chip of chips) expect((chip as HTMLElement).tabIndex).toBe(0);
    const order = [...section.querySelectorAll("button")].map((button) => {
      if (button.classList.contains("ccc-filter-chip")) return "chip";
      if (button.classList.contains("ccc-approval-row-button")) return "row";
      if (button.classList.contains("ccc-approvals-back")) return "back";
      if (button.getAttribute("data-decision") === "deny") return "deny";
      if (button.getAttribute("data-decision") === "approve") return "approve";
      if (button.getAttribute("data-action") === "open-run") return "open-run";
      return "other";
    });
    const compact = order.filter((kind) => kind !== "other");
    expect(compact.slice(0, 3)).toEqual(["chip", "chip", "chip"]);
    const firstPane = compact.indexOf("back");
    expect(firstPane).toBeGreaterThan(compact.lastIndexOf("row") - 3);
    const pane = compact.slice(firstPane);
    expect(pane.indexOf("deny")).toBeLessThan(pane.indexOf("approve"));
    expect(pane.indexOf("approve")).toBeLessThan(pane.indexOf("open-run"));
  });

  it("names the decision group and gives every control an accessible name", async () => {
    const { container } = setup();
    const section = await openPane(container);
    expect(screen.getByRole("group", { name: "Decision" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Approval filter" })).toBeTruthy();
    for (const button of section.querySelectorAll("button")) {
      const name = (button.getAttribute("aria-label") ?? button.textContent ?? "").trim();
      expect(name.length, button.outerHTML).toBeGreaterThan(0);
    }
  });

  it("gives every control a hit area through the class the stylesheet sizes", async () => {
    const { container } = setup();
    const section = await openPane(container);
    const css = readFileSync(join(HERE, "..", "styles.css"), "utf8");
    function sized(className: string): boolean {
      const blocks = css.match(/[^{}]+\{[^{}]*\}/g) ?? [];
      return blocks.some((block) => {
        const [selector = "", body = ""] = block.split("{");
        return (
          new RegExp(`\\.${className}(?![\\w-])`).test(selector) &&
          /min-height\s*:\s*var\(--ccc-space-(lg|xl)\)/.test(body)
        );
      });
    }
    const classes = new Set<string>();
    for (const button of section.querySelectorAll("button:not(.ccc-source-button)")) {
      const primary = [...button.classList][0];
      expect(primary, button.outerHTML).toBeDefined();
      if (primary !== undefined) classes.add(primary);
    }
    expect(classes.size).toBeGreaterThan(3);
    for (const className of classes) {
      expect(sized(className), `${className} has no min-height rule`).toBe(true);
    }
  });

  it("carries no colour-only state: every row names its state in text beside a hidden glyph", async () => {
    const { container } = setup();
    const section = await openPane(container);
    for (const meta of section.querySelectorAll(".ccc-approval-row-meta")) {
      expect(meta.querySelector('[aria-hidden="true"]')).not.toBeNull();
      expect(meta.textContent).toMatch(/Needs your decision|Approved|Denied|Expired/);
    }
  });

  it("offers no always-allow wording anywhere in the rendered destination", async () => {
    const { container } = setup();
    await openPane(container);
    const text = container.textContent ?? "";
    for (const pattern of STANDING_CHOICE) {
      expect(text.match(pattern)?.[0], `${pattern}`).toBeUndefined();
    }
  });

  it("keeps the pane's focus on Deny for a destructive request, never on Approve once", async () => {
    const { container } = setup();
    await openPane(container);
    await waitFor(() => expect(document.activeElement?.getAttribute("data-decision")).toBe("deny"));
    expect(selectedProposalId.value).not.toBeNull();
    expect(container.querySelector("[autofocus]")).toBeNull();
  });
});
