import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApprovalSummary, DecideResponse } from "@ccc/domain/approval.js";
import type { ApprovalItemView } from "@ccc/domain/approval-view.js";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ApprovalDecideInput,
  type ApprovalDetailResponse,
  type ApprovalsApi,
  configureApprovalsApi,
} from "../approvals/api.js";
import {
  adoptApprovalsSnapshot,
  approvalsById,
  resetApprovalsState,
  selectedProposalId,
} from "../approvals/signals.js";
import { connectionState } from "../connection-state.js";
import { approvalsSnapshot, summary } from "../test-support/approval-fixtures.js";
import {
  approvalDetail,
  approvalView,
  decidedView,
  FIXTURE_HASH,
  FIXTURE_NOW_MS,
  testApprovalView,
} from "../test-support/approval-view-fixtures.js";
import { ApprovalsSection } from "./approvals-section.js";
import { approvalsSectionVisible, resetApprovalsView } from "./approvals-state.js";
import { configureNotify } from "./notify-port.js";

afterEach(() => {
  cleanup();
  configureApprovalsApi(null);
  configureNotify(null);
  resetApprovalsState();
  resetApprovalsView();
  connectionState.value = { kind: "connecting" };
});

beforeEach(() => {
  resetApprovalsState();
  resetApprovalsView();
  connectionState.value = { kind: "live" };
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** The summary of a view, as the list would know it. */
function summaryOf(view: ApprovalItemView, n = 1): ApprovalSummary {
  return summary(n, view.state, view.revision, {
    title: view.title,
    expiresAt: view.expiresAt,
    projectName: view.project,
    requesterLabel: view.requester.label,
    requesterKind: view.requester.kind,
    runId: view.run?.runId ?? null,
  });
}

interface Harness {
  readonly get: ReturnType<typeof vi.fn<(id: string) => Promise<ApprovalDetailResponse>>>;
  readonly decide: ReturnType<
    typeof vi.fn<(input: ApprovalDecideInput) => Promise<DecideResponse>>
  >;
  readonly notice: ReturnType<typeof vi.fn<(text: string) => void>>;
}

function install(
  options: {
    readonly detail?: (id: string, call: number) => ApprovalDetailResponse;
    readonly decide?: (input: ApprovalDecideInput) => Promise<DecideResponse>;
  } = {},
): Harness {
  let call = 0;
  const get = vi.fn(async (id: string) => {
    call += 1;
    return (options.detail ?? (() => approvalDetail()))(id, call);
  });
  const decide = vi.fn(
    options.decide ??
      (async (): Promise<DecideResponse> => {
        throw new Error("decide was not expected");
      }),
  );
  const notice = vi.fn<(text: string) => void>();
  const api: ApprovalsApi = {
    list: async () => approvalsSnapshot(),
    get,
    decide,
    test: async () => {
      throw new Error("test was not expected");
    },
  };
  configureApprovalsApi(api);
  configureNotify(notice);
  return { get, decide, notice };
}

function hydrate(
  pending: readonly ApprovalSummary[],
  rest: { decided?: readonly ApprovalSummary[]; expired?: readonly ApprovalSummary[] } = {},
): void {
  adoptApprovalsSnapshot(approvalsSnapshot({ pending, ...rest }));
}

function renderSection(now = FIXTURE_NOW_MS) {
  return render(<ApprovalsSection now={now} />);
}

function chip(name: RegExp | string): HTMLElement {
  return screen.getByRole("button", { name });
}

describe("Test 1 (chips): the filter group and its counts", () => {
  it("renders a group named Approval filter with three chips, exactly one pressed, Pending by default", () => {
    install();
    hydrate([summary(1, "pending"), summary(2, "pending")], {
      decided: [1, 2, 3, 4, 5, 6, 7].map((n) => summary(n + 10, "denied", 2)),
      expired: [summary(30, "expired", 2)],
    });
    renderSection();
    const group = screen.getByRole("group", { name: "Approval filter" });
    const chips = within(group).getAllByRole("button");
    expect(chips.map((el) => el.textContent)).toEqual([
      "Pending (2)",
      "Decided (7)",
      "Expired (1)",
    ]);
    expect(chips.map((el) => el.getAttribute("aria-label"))).toEqual([
      "Pending, 2 requests",
      "Decided, 7 requests",
      "Expired, 1 request",
    ]);
    expect(chips.map((el) => el.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
    expect(chips.every((el) => el.tabIndex === 0 || !el.hasAttribute("tabindex"))).toBe(true);
  });

  it("presses the chip that was activated and lists its requests", () => {
    install();
    hydrate([summary(1, "pending")], { decided: [summary(2, "denied", 2)] });
    renderSection();
    fireEvent.click(chip(/^Decided/));
    expect(chip(/^Decided/).getAttribute("aria-pressed")).toBe("true");
    expect(chip(/^Pending/).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Test approval 2")).toBeTruthy();
    expect(screen.queryByText("Test approval 1")).toBeNull();
  });

  it("renders the labels without numbers while the counts are unknown", () => {
    install();
    renderSection();
    expect(chip("Pending").textContent).toBe("Pending");
    expect(chip("Decided").textContent).toBe("Decided");
    expect(chip("Expired").textContent).toBe("Expired");
  });
});

describe("Test 2 (list and selection)", () => {
  it("lists pending requests soonest expiry first as buttons inside list items", () => {
    install();
    hydrate([
      summary(1, "pending", 1, { title: "Later request", expiresAt: "2026-10-06T14:00:00.000Z" }),
      summary(2, "pending", 1, { title: "Sooner request", expiresAt: "2026-10-06T12:10:00.000Z" }),
    ]);
    const { container } = renderSection();
    const items = container.querySelectorAll("ul.ccc-approval-list > li");
    expect(items.length).toBe(2);
    const titles = [...items].map((li) => li.querySelector("button")?.textContent);
    expect(titles).toEqual(["Sooner request", "Later request"]);
  });

  it("selecting a row sets the selection, marks it current, loads the detail once and shows the pane", async () => {
    const view = approvalView();
    const { get } = install({ detail: () => approvalDetail(view) });
    hydrate([summaryOf(view)]);
    const { container } = renderSection();
    fireEvent.click(screen.getByRole("button", { name: view.title }));
    expect(selectedProposalId.value).toBe(view.proposalId);
    const row = container.querySelector(".ccc-approval-row");
    expect(row?.querySelector("button")?.getAttribute("aria-current")).toBe("true");
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 4 }).textContent).toBe(view.title),
    );
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(view.proposalId);
  });

  it("moves focus to Deny for a destructive pending request", async () => {
    const view = approvalView();
    install({ detail: () => approvalDetail(view) });
    hydrate([summaryOf(view)]);
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: view.title }));
    await waitFor(() => expect(document.activeElement?.getAttribute("data-decision")).toBe("deny"));
  });

  it("moves focus to the pane heading for any other request", async () => {
    const view = testApprovalView();
    install({ detail: () => approvalDetail(view) });
    hydrate([summaryOf(view)]);
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: view.title }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 4 })).toBe(document.activeElement),
    );
  });
});

describe("Test 3 (decide)", () => {
  it("sends the displayed hash, announces the outcome and moves the row through the signals", async () => {
    const view = approvalView();
    const gate = deferred<DecideResponse>();
    const decided = decidedView("approved");
    const { decide } = install({
      detail: (_id, call) => approvalDetail(call === 1 ? view : decided),
      decide: () => gate.promise,
    });
    hydrate([summaryOf(view)]);
    const { container } = renderSection();
    fireEvent.click(screen.getByRole("button", { name: view.title }));
    const approve = await screen.findByRole("button", { name: /^Approve once/ });
    await waitFor(() => expect(approve.getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(approve);
    expect(decide).toHaveBeenCalledWith({
      proposalId: view.proposalId,
      decision: "approve",
      payloadHash: FIXTURE_HASH,
    });
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toBe("Sending your decision…");
    gate.resolve({ outcome: "decided", approval: summaryOf(decided) });
    await waitFor(() => expect(status?.textContent).toBe("Approved. Carrying out the action…"));
    expect(approvalsById.value.get(view.proposalId)?.state).toBe("approved");
    expect(container.querySelectorAll(".ccc-approval-list > li").length).toBe(0);
    fireEvent.click(chip(/^Decided/));
    expect(
      within(container.querySelector(".ccc-approval-list") as HTMLElement).getByText(/Approved/),
    ).toBeTruthy();
  });
});

describe("Test 4 (status line)", () => {
  it("has exactly one polite status element, present before it changes, and the pane adds none", async () => {
    const view = approvalView();
    install({ detail: () => approvalDetail(view) });
    hydrate([summaryOf(view)]);
    const { container } = renderSection();
    const before = container.querySelectorAll('[role="status"]');
    expect(before.length).toBe(1);
    expect(before[0]?.getAttribute("aria-live")).toBe("polite");
    expect(before[0]?.textContent).toBe("");
    fireEvent.click(screen.getByRole("button", { name: view.title }));
    await screen.findByRole("heading", { level: 4 });
    expect(container.querySelectorAll('[role="status"]').length).toBe(1);
    expect(container.querySelector('[role="status"]')).toBe(before[0]);
  });
});

describe("Test 5 (visibility)", () => {
  it("is true while the section is mounted and false once it unmounts", () => {
    install();
    expect(approvalsSectionVisible.value).toBe(false);
    const { unmount } = renderSection();
    expect(approvalsSectionVisible.value).toBe(true);
    unmount();
    expect(approvalsSectionVisible.value).toBe(false);
  });
});

describe("the section's own imports", () => {
  it("imports no obsidian module and no service client", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "approvals-section.tsx"), "utf8");
    const imports = source
      .split("\n")
      .filter((line) => /^\s*(import|export)\b.*\bfrom\b/.test(line));
    for (const line of imports) {
      expect(line).not.toMatch(/from\s+["']obsidian["']/);
      expect(line).not.toMatch(/service-api-client/);
    }
    expect(imports.length).toBeGreaterThan(5);
  });
});
