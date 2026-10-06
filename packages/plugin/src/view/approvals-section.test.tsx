import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApprovalSummary, ApprovalsSnapshot, DecideResponse } from "@ccc/domain/approval.js";
import type { ApprovalItemView } from "@ccc/domain/approval-view.js";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ApprovalDecideInput,
  type ApprovalDetailResponse,
  type ApprovalsApi,
  configureApprovalsApi,
} from "../approvals/api.js";
import {
  adoptApprovalsSnapshot,
  applyApprovalSummary,
  approvalDetailFocusRequested,
  approvalsById,
  approvalsReady,
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
import { formatApprovalTime } from "./approvals-copy.js";
import { ApprovalsSection, type ApprovalsSectionProps } from "./approvals-section.js";
import {
  approvalChip,
  approvalsMissedSync,
  approvalsSectionVisible,
  approvalsStatus,
  resetApprovalsView,
} from "./approvals-state.js";
import { approvalsHeadingRequested } from "./navigation-request.js";
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
    readonly list?: () => Promise<ApprovalsSnapshot>;
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
    list: options.list ?? (async () => approvalsSnapshot()),
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

function renderSection(now = FIXTURE_NOW_MS, props: Partial<ApprovalsSectionProps> = {}) {
  return render(<ApprovalsSection now={now} {...props} />);
}

/** Changes a signal the way an event would, inside act so the view settles before the next line. */
async function update(change: () => void): Promise<void> {
  await act(async () => {
    change();
  });
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
    install({ list: () => new Promise<ApprovalsSnapshot>(() => {}) });
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
    expect(container.querySelector(".ccc-approval-row-meta")?.textContent).toContain("▣ Approved");
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

// ---------------------------------------------------------------------------
// Task 2

const NOW = FIXTURE_NOW_MS;
const iso = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();

function rowsOf(container: Element): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".ccc-approval-row")];
}

function rowButtons(container: Element): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>(".ccc-approval-row-button")];
}

function statusText(container: Element): string {
  return container.querySelector('[role="status"]')?.textContent ?? "";
}

describe("Test 1 (time phrases): what each row says about time", () => {
  it("counts down, emphasises the last five minutes and reads Expiring… at zero", () => {
    install();
    hydrate([
      summary(1, "pending", 1, { title: "Fourteen", expiresAt: iso(14) }),
      summary(2, "pending", 1, { title: "Four", expiresAt: iso(4) }),
      summary(3, "pending", 1, { title: "Zero", expiresAt: iso(0) }),
    ]);
    const { container } = renderSection();
    const metas = [...container.querySelectorAll(".ccc-approval-row-meta")];
    expect(metas.map((meta) => meta.textContent)).toEqual([
      "□ Needs your decision · Dashboard: Dashboard · No project · Expiring…",
      "□ Needs your decision · Dashboard: Dashboard · No project · Expires in 4 min",
      "□ Needs your decision · Dashboard: Dashboard · No project · Expires in 14 min",
    ]);
    const emphasised = metas.map((meta) =>
      [...meta.querySelectorAll('[data-emphasis="true"]')].map((el) => el.textContent),
    );
    expect(emphasised[0]).toEqual(["□ Needs your decision", "Expiring…"]);
    expect(emphasised[1]).toEqual(["□ Needs your decision", "Expires in 4 min"]);
    expect(emphasised[2]).toEqual(["□ Needs your decision"]);
  });

  it("reads an absolute time beyond 24 hours, from the prop clock", () => {
    install();
    const expiresAt = "2026-10-09T15:20:00.000Z";
    hydrate([summary(1, "pending", 1, { expiresAt })]);
    const { container } = renderSection();
    expect(container.querySelector(".ccc-approval-row-meta")?.textContent).toContain(
      `Expires ${formatApprovalTime(expiresAt, NOW)}`,
    );
  });

  it("reads the decision for Decided rows and Expired for Expired rows", () => {
    install();
    hydrate([], {
      decided: [summary(1, "denied", 2, { decidedAt: iso(-5) })],
      expired: [summary(2, "expired", 2, { expiresAt: iso(-90), decidedAt: null })],
    });
    const { container } = renderSection();
    fireEvent.click(chip(/^Decided/));
    expect(container.querySelector(".ccc-approval-row-meta")?.textContent).toBe(
      "⊘ Denied · Dashboard: Dashboard · No project · Denied 5 minutes ago",
    );
    fireEvent.click(chip(/^Expired/));
    expect(container.querySelector(".ccc-approval-row-meta")?.textContent).toBe(
      "⊡ Expired — denied automatically · Dashboard: Dashboard · No project · Expired 1 hour ago",
    );
  });
});

describe("Test 2 (row content)", () => {
  it("shows the templated title with its full text in title, and the project or No project", () => {
    install();
    const long = "Force-terminate a session with a very long name ".repeat(4).trim();
    hydrate([
      summary(1, "pending", 1, {
        title: long.slice(0, 120),
        projectName: "example-project",
        requesterKind: "skill",
        requesterLabel: "research-brief",
      }),
    ]);
    const { container } = renderSection();
    const button = rowButtons(container)[0];
    expect(button?.getAttribute("title")).toBe(long.slice(0, 120));
    expect(button?.querySelector(".ccc-clamp-2")?.textContent).toBe(long.slice(0, 120));
    expect(container.querySelector(".ccc-approval-row-meta")?.textContent).toContain(
      "Skill: research-brief · example-project ·",
    );
  });

  it("weights the state segment for pending and unknown only", () => {
    install();
    hydrate([summary(1, "pending")], {
      decided: [summary(2, "unknown", 3), summary(3, "executed", 4)],
    });
    const { container } = renderSection();
    expect(container.querySelector('.ccc-approval-row-meta [data-emphasis="true"]')).not.toBeNull();
    fireEvent.click(chip(/^Decided/));
    const metas = [...container.querySelectorAll(".ccc-approval-row-meta")];
    const weighted = metas.map((meta) => meta.querySelector('[data-emphasis="true"]') !== null);
    const labels = metas.map((meta) => meta.textContent?.includes("Outcome unknown"));
    expect(weighted).toEqual(labels);
  });
});

describe("Test 3 (ordering, paging, bound, keys)", () => {
  function decidedRows(count: number): ApprovalSummary[] {
    return Array.from({ length: count }, (_, index) =>
      summary(index + 1, "denied", 2, {
        title: `Request ${index + 1}`,
        decidedAt: iso(-(index + 1)),
      }),
    );
  }

  it("lists Decided newest first, 25 rows, then Show 25 more", async () => {
    install();
    hydrate([], { decided: decidedRows(60) });
    const { container } = renderSection();
    fireEvent.click(chip(/^Decided/));
    expect(rowsOf(container).length).toBe(25);
    expect(rowButtons(container)[0]?.textContent).toBe("Request 1");
    fireEvent.click(screen.getByRole("button", { name: "Show 25 more" }));
    await waitFor(() => expect(rowsOf(container).length).toBe(50));
    await waitFor(() => expect(document.activeElement).toBe(rowButtons(container)[25]));
    expect(statusText(container)).toBe("25 more requests loaded.");
    expect(screen.getByRole("button", { name: "Show 10 more" })).toBeTruthy();
  });

  it("ends a truncated list with the bound note once every loaded row is shown", async () => {
    install();
    adoptApprovalsSnapshot(
      approvalsSnapshot({
        decided: decidedRows(30),
        counts: { pending: 0, decided: 80, expired: 0 },
        truncated: true,
      }),
    );
    const { container } = renderSection();
    fireEvent.click(chip(/^Decided/));
    expect(screen.queryByText(/Showing the 50 most recent/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show 5 more" }));
    await waitFor(() =>
      expect(
        screen.getByText(
          "Showing the 50 most recent. Older decisions are kept in the audit record.",
        ),
      ).toBeTruthy(),
    );
    expect(rowsOf(container).length).toBe(30);
  });

  it("shows no bound note when the list is complete", () => {
    install();
    hydrate([], { decided: decidedRows(3) });
    renderSection();
    fireEvent.click(chip(/^Decided/));
    expect(screen.queryByText(/Showing the 50 most recent/)).toBeNull();
  });

  it("moves focus between row buttons with Down, Up, Home and End", () => {
    install();
    hydrate([
      summary(1, "pending", 1, { expiresAt: iso(10) }),
      summary(2, "pending", 1, { expiresAt: iso(20) }),
      summary(3, "pending", 1, { expiresAt: iso(30) }),
    ]);
    const { container } = renderSection();
    const [first, second, third] = rowButtons(container);
    first?.focus();
    fireEvent.keyDown(first as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second as HTMLElement, { key: "End" });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(third as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(third as HTMLElement, { key: "ArrowUp" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second as HTMLElement, { key: "Home" });
    expect(document.activeElement).toBe(first);
  });
});

describe("Test 4 (zero-expiry refetch)", () => {
  it("asks once per expiring request when the clock passes its expiry, and never decides", async () => {
    const { decide } = install();
    const refreshOne = vi.fn(async (_id: string) => {});
    hydrate([summary(1, "pending", 1, { expiresAt: iso(1) })]);
    const view = renderSection(NOW, { refreshOne });
    expect(refreshOne).not.toHaveBeenCalled();
    view.rerender(<ApprovalsSection now={NOW + 61_000} refreshOne={refreshOne} />);
    await waitFor(() => expect(refreshOne).toHaveBeenCalledTimes(1));
    expect(refreshOne).toHaveBeenCalledWith(proposalIdOf(1));
    view.rerender(<ApprovalsSection now={NOW + 180_000} refreshOne={refreshOne} />);
    view.rerender(<ApprovalsSection now={NOW + 240_000} refreshOne={refreshOne} />);
    await Promise.resolve();
    expect(refreshOne).toHaveBeenCalledTimes(1);
    expect(decide).not.toHaveBeenCalled();
    expect(view.container.querySelector(".ccc-approval-row-meta")?.textContent).toContain(
      "Expiring…",
    );
    expect(approvalsById.value.get(proposalIdOf(1))?.state).toBe("pending");
  });

  it("disables the pane's decisions with the expiry reason", async () => {
    const view = approvalView({ expiresAt: iso(-1) });
    install({ detail: () => approvalDetail(view) });
    hydrate([summary(1, "pending", 1, { title: view.title, expiresAt: iso(-1) })]);
    const { container } = renderSection(NOW, { refreshOne: async () => {} });
    fireEvent.click(rowButtons(container)[0] as HTMLElement);
    const approve = await screen.findByRole("button", { name: /^Approve once/ });
    await waitFor(() => expect(approve.getAttribute("aria-disabled")).toBe("true"));
    expect(screen.getAllByText("This request has expired.").length).toBeGreaterThan(0);
  });
});

function proposalIdOf(n: number): string {
  return summary(n).proposalId;
}

describe("Test 5 (countdown silence)", () => {
  it("updates phrases from the clock without writing to the status line", () => {
    install();
    hydrate([summary(1, "pending", 1, { expiresAt: iso(14) })]);
    const view = renderSection(NOW, { refreshOne: async () => {} });
    expect(view.container.querySelector(".ccc-approval-row-meta")?.textContent).toContain(
      "Expires in 14 min",
    );
    view.rerender(<ApprovalsSection now={NOW + 120_000} refreshOne={async () => {}} />);
    expect(view.container.querySelector(".ccc-approval-row-meta")?.textContent).toContain(
      "Expires in 12 min",
    );
    expect(statusText(view.container)).toBe("");
  });
});

describe("Test 6 (arrival announcement)", () => {
  it("stays silent for the first snapshot, whether it arrives before or after the mount", async () => {
    install({ list: () => new Promise<ApprovalsSnapshot>(() => {}) });
    const { container } = renderSection();
    await update(() => adoptApprovalsSnapshot(approvalsSnapshot({ pending: [summary(1)] })));
    expect(statusText(container)).toBe("");
  });

  it("announces a new pending request once, with no request text", async () => {
    install();
    hydrate([summary(1)]);
    const { container } = renderSection();
    expect(statusText(container)).toBe("");
    await update(() => {
      applyApprovalSummary(summary(2, "pending", 1, { title: "Secret target name" }));
    });
    expect(statusText(container)).toBe("A new request needs your decision.");
    expect(statusText(container)).not.toContain("Secret");
  });

  it("is silent for count changes, expiries and other requests' transitions", async () => {
    install();
    hydrate([summary(1), summary(2)], { decided: [summary(3, "approved", 2)] });
    const { container } = renderSection();
    await update(() => applyApprovalSummary(summary(1, "denied", 2)));
    expect(statusText(container)).toBe("");
    await update(() => applyApprovalSummary(summary(2, "expired", 2)));
    expect(statusText(container)).toBe("");
    await update(() => applyApprovalSummary(summary(3, "executed", 3)));
    expect(statusText(container)).toBe("");
  });

  it("announces the finished outcome of a request decided here, and only of that request", async () => {
    const view = approvalView();
    const decided = decidedView("approved");
    const { notice } = install({
      detail: (_id, call) => approvalDetail(call === 1 ? view : decided),
      decide: async () => ({ outcome: "decided", approval: summaryOf(decided) }),
    });
    hydrate([summaryOf(view), summary(2, "pending", 1, { title: "Other request" })]);
    const { container } = renderSection();
    fireEvent.click(screen.getByRole("button", { name: view.title }));
    const approve = await screen.findByRole("button", { name: /^Approve once/ });
    await waitFor(() => expect(approve.getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(approve);
    await waitFor(() => expect(statusText(container)).toBe("Approved. Carrying out the action…"));
    await update(() => applyApprovalSummary(summary(2, "failed", 4)));
    expect(statusText(container)).toBe("Approved. Carrying out the action…");
    await update(() =>
      applyApprovalSummary(
        summary(1, "executed", 4, { title: view.title, expiresAt: view.expiresAt }),
      ),
    );
    expect(statusText(container)).toBe("Carried out.");
    expect(notice).toHaveBeenCalledWith(`${view.title}: Carried out.`);
  });
});

describe("Test 7 (section states)", () => {
  it("loading: three skeleton lines, aria-busy, hidden label, chips without counts", async () => {
    install({ list: () => new Promise<ApprovalsSnapshot>(() => {}) });
    const { container } = renderSection();
    const root = container.querySelector(".ccc-approvals");
    expect(root?.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelectorAll(".ccc-skeleton-line").length).toBe(3);
    expect(within(root as HTMLElement).getByText("Loading approval requests")).toBeTruthy();
    expect(chip("Pending").getAttribute("aria-pressed")).toBe("true");
    expect(chip("Pending").textContent).toBe("Pending");
  });

  it("empty: each chip has its own fixed copy, and Pending points at the test approval", () => {
    install();
    hydrate([]);
    renderSection();
    expect(screen.getByText("Nothing needs your decision right now.")).toBeTruthy();
    expect(
      screen.getByText(
        "When a skill, automation or the dashboard asks to do something consequential, it appears here first.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "To try it, use Obsidian settings → Claude command center → Approvals → Send a test approval.",
      ),
    ).toBeTruthy();
    fireEvent.click(chip(/^Decided/));
    expect(screen.getByText("No decisions yet.")).toBeTruthy();
    expect(screen.getByText("Requests you approve or deny are listed here.")).toBeTruthy();
    fireEvent.click(chip(/^Expired/));
    expect(screen.getByText("Nothing has expired.")).toBeTruthy();
    expect(
      screen.getByText("A request nobody decides in time is denied automatically and listed here."),
    ).toBeTruthy();
  });

  it("stale: shows the badge, Refresh approvals, withholds Approve once and keeps Deny", async () => {
    const view = approvalView();
    install({ detail: () => approvalDetail(view) });
    hydrate([summaryOf(view)]);
    const { container } = renderSection();
    await update(() => {
      approvalsMissedSync.value = true;
    });
    expect(
      within(container.querySelector("footer") as HTMLElement).getByText("Stale"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh approvals" })).toBeTruthy();
    fireEvent.click(rowButtons(container)[0] as HTMLElement);
    const approve = await screen.findByRole("button", { name: /^Approve once/ });
    expect(
      await screen.findByText("This list may be out of date. Refresh, then decide."),
    ).toBeTruthy();
    expect(approve.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("button", { name: /^Deny/ }).getAttribute("aria-disabled")).toBeNull();
  });

  it("stale: Refresh approvals adopts a fresh snapshot, clears the badge and says so", async () => {
    const list = vi.fn(async () =>
      approvalsSnapshot({ pending: [summary(1)], decided: [summary(5, "denied", 2)] }),
    );
    install({ list });
    hydrate([summary(1)]);
    const { container } = renderSection();
    await update(() => {
      approvalsMissedSync.value = true;
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh approvals" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(statusText(container)).toBe("Approvals refreshed."));
    expect(screen.queryByRole("button", { name: "Refresh approvals" })).toBeNull();
    expect(chip(/^Decided/).textContent).toBe("Decided (1)");
  });

  it("disconnected: dims with the hook, says the requests are kept, disables the pane's controls", async () => {
    const view = approvalView();
    install({ detail: () => approvalDetail(view) });
    hydrate([summaryOf(view)]);
    const { container } = renderSection();
    fireEvent.click(rowButtons(container)[0] as HTMLElement);
    await screen.findByRole("button", { name: /^Open originating run/ });
    await update(() => {
      connectionState.value = { kind: "disconnected", reason: "connect ECONNREFUSED" };
    });
    expect(
      container.querySelector(
        '.ccc-approvals-list [data-dimmed="true"], .ccc-approvals-list[data-dimmed="true"]',
      ),
    ).not.toBeNull();
    expect(
      screen.getByText(
        "Pending requests are kept safely and appear again when the service is back.",
      ),
    ).toBeTruthy();
    for (const name of [/^Approve once/, /^Deny/, /^Open originating run/]) {
      expect(screen.getByRole("button", { name }).getAttribute("aria-disabled")).toBe("true");
    }
    expect(chip(/^Pending/).textContent).toBe("Pending (1)");
  });

  it("error: names the failure and points at the diagnostics when the first load fails", async () => {
    install({
      list: async () => {
        throw new Error("down");
      },
    });
    renderSection();
    expect(await screen.findByText("Couldn't load approval requests.")).toBeTruthy();
    expect(
      screen.getByText("Check the service in Settings → Diagnostics, then refresh."),
    ).toBeTruthy();
  });

  it("engine not ready: says approvals aren't available and that Force-terminate stays disabled", () => {
    install();
    adoptApprovalsSnapshot(approvalsSnapshot({ ready: false }));
    renderSection();
    expect(screen.getByText("Approvals aren't available yet.")).toBeTruthy();
    expect(
      screen.getByText(
        "The companion service doesn't have the approval engine, so Force-terminate stays disabled.",
      ),
    ).toBeTruthy();
  });
});

describe("Test 8 (deep links)", () => {
  it("presses the chip that contains a request selected from outside", async () => {
    install();
    hydrate([summary(1)], {
      decided: [summary(2, "denied", 2)],
      expired: [summary(3, "expired", 2)],
    });
    const { container } = renderSection();
    expect(chip(/^Pending/).getAttribute("aria-pressed")).toBe("true");
    await update(() => {
      selectedProposalId.value = summary(2).proposalId;
    });
    await waitFor(() => expect(chip(/^Decided/).getAttribute("aria-pressed")).toBe("true"));
    await update(() => {
      selectedProposalId.value = summary(3).proposalId;
    });
    await waitFor(() => expect(chip(/^Expired/).getAttribute("aria-pressed")).toBe("true"));
    expect(container.querySelector('[aria-current="true"]')).not.toBeNull();
  });

  it("presses the right chip on mount when the selection was set before the section existed", () => {
    install();
    hydrate([summary(1)], { decided: [summary(2, "denied", 2)] });
    selectedProposalId.value = summary(2).proposalId;
    renderSection();
    expect(chip(/^Decided/).getAttribute("aria-pressed")).toBe("true");
  });

  it("never switches the chip for a request that merely changed state, and shows its relocation line", async () => {
    const view = approvalView();
    install({
      detail: (_id, call) => approvalDetail(call === 1 ? view : decidedView("denied")),
    });
    hydrate([summaryOf(view)]);
    const { container } = renderSection();
    fireEvent.click(rowButtons(container)[0] as HTMLElement);
    await screen.findByRole("heading", { level: 4 });
    await update(() => applyApprovalSummary(summary(1, "denied", 5, { title: view.title })));
    expect(chip(/^Pending/).getAttribute("aria-pressed")).toBe("true");
    expect(selectedProposalId.value).toBe(view.proposalId);
    expect(await screen.findByText("This request is listed under Decided.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show Decided" }));
    expect(approvalChip.value).toBe("decided");
  });

  it("renders the not-found pane for an unknown id, with focus on its heading", async () => {
    install({
      detail: () => {
        throw Object.assign(new Error("not found"), { code: "not-found" });
      },
    });
    hydrate([summary(1)]);
    selectedProposalId.value = "0mfk1a2b3c4d5e6f7a8b9czzz";
    approvalDetailFocusRequested.value = true;
    renderSection();
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 4 }).textContent).toBe(
        "That request isn't in the inbox.",
      ),
    );
    const heading = screen.getByRole("heading", { level: 4 });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(approvalDetailFocusRequested.value).toBe(false);
  });

  it("does not take focus for a leftover selection on a plain mount", async () => {
    const view = testApprovalView();
    install({ detail: () => approvalDetail(view) });
    hydrate([summaryOf(view)]);
    selectedProposalId.value = view.proposalId;
    renderSection();
    const heading = await screen.findByRole("heading", { level: 4 });
    expect(document.activeElement).not.toBe(heading);
  });

  it("takes focus for a selection that arrived with the hand-off request", async () => {
    const view = testApprovalView();
    install({ detail: () => approvalDetail(view) });
    hydrate([summaryOf(view)]);
    selectedProposalId.value = view.proposalId;
    approvalDetailFocusRequested.value = true;
    renderSection();
    const heading = await screen.findByRole("heading", { level: 4 });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(approvalDetailFocusRequested.value).toBe(false);
  });

  it("presses Pending and focuses the Approvals heading for the palette request, selecting nothing", async () => {
    install();
    hydrate([summary(1)], { decided: [summary(2, "denied", 2)] });
    approvalChip.value = "decided";
    approvalsHeadingRequested.value = true;
    renderSection();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Approvals" })),
    );
    expect(chip(/^Pending/).getAttribute("aria-pressed")).toBe("true");
    expect(selectedProposalId.value).toBeNull();
    expect(approvalsHeadingRequested.value).toBe(false);
  });
});

describe("Test 9 (provenance strip)", () => {
  it("shows one Approval inbox source and a Live badge while the stream is healthy", () => {
    install();
    hydrate([summary(1)]);
    const { container } = renderSection();
    const footer = container.querySelector("footer") as HTMLElement;
    expect(within(footer).getByText("Live")).toBeTruthy();
    fireEvent.click(within(footer).getByRole("button", { name: "Source" }));
    expect(within(footer).getByText("Approval inbox — ok")).toBeTruthy();
  });

  it("reads Unavailable when the engine is not ready", () => {
    install();
    adoptApprovalsSnapshot(approvalsSnapshot({ ready: false }));
    const { container } = renderSection();
    expect(
      within(container.querySelector("footer") as HTMLElement).getByText("Unavailable"),
    ).toBeTruthy();
  });

  it("goes stale after the stream drops and returns without a fresh snapshot", async () => {
    install();
    hydrate([summary(1)]);
    const { container } = renderSection();
    await update(() => {
      connectionState.value = { kind: "disconnected", reason: "connect ECONNREFUSED" };
    });
    await update(() => {
      connectionState.value = { kind: "live" };
    });
    expect(
      within(container.querySelector("footer") as HTMLElement).getByText("Stale"),
    ).toBeTruthy();
    await update(() => adoptApprovalsSnapshot(approvalsSnapshot({ pending: [summary(1)] })));
    expect(within(container.querySelector("footer") as HTMLElement).getByText("Live")).toBeTruthy();
  });
});

describe("Test 10 (layout hooks)", () => {
  it("is a size container whose layout carries the master-detail class", () => {
    install();
    hydrate([summary(1)]);
    const { container } = renderSection();
    expect(container.querySelector("section.ccc-approvals")).not.toBeNull();
    expect(container.querySelector(".ccc-approvals-layout")).not.toBeNull();
  });

  it("renders the pane only for a selection, with Back to requests returning focus to the row", async () => {
    const view = testApprovalView();
    install({ detail: () => approvalDetail(view) });
    hydrate([summaryOf(view)]);
    const { container } = renderSection();
    expect(container.querySelector(".ccc-approval-detail")).toBeNull();
    expect(screen.queryByRole("button", { name: "Back to requests" })).toBeNull();
    const button = rowButtons(container)[0] as HTMLButtonElement;
    fireEvent.click(button);
    await screen.findByRole("heading", { level: 4 });
    fireEvent.click(screen.getByRole("button", { name: "Back to requests" }));
    expect(selectedProposalId.value).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(button));
    expect(container.querySelector(".ccc-approval-detail")).toBeNull();
  });

  it("returns focus to the row on Escape from inside the pane", async () => {
    const view = testApprovalView();
    install({ detail: () => approvalDetail(view) });
    hydrate([summaryOf(view)]);
    const { container } = renderSection();
    const button = rowButtons(container)[0] as HTMLButtonElement;
    fireEvent.click(button);
    const heading = await screen.findByRole("heading", { level: 4 });
    fireEvent.keyDown(heading, { key: "Escape" });
    expect(selectedProposalId.value).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it("falls back to the section heading when the originating row left the list", async () => {
    const view = approvalView();
    install({ detail: () => approvalDetail(view) });
    hydrate([summaryOf(view)]);
    const { container } = renderSection();
    fireEvent.click(rowButtons(container)[0] as HTMLElement);
    await screen.findByRole("heading", { level: 4 });
    await update(() => applyApprovalSummary(summary(1, "denied", 5, { title: view.title })));
    fireEvent.click(screen.getByRole("button", { name: "Back to requests" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Approvals" })),
    );
  });

  it("states the pending count in the header, omitted at zero", async () => {
    install();
    hydrate([summary(1), summary(2)]);
    const view = renderSection();
    expect(view.container.querySelector(".ccc-approvals-summary")?.textContent).toBe(
      "2 requests need your decision",
    );
    await update(() => adoptApprovalsSnapshot(approvalsSnapshot({ pending: [summary(1)] })));
    expect(view.container.querySelector(".ccc-approvals-summary")?.textContent).toBe(
      "1 request needs your decision",
    );
    await update(() => adoptApprovalsSnapshot(approvalsSnapshot()));
    expect(view.container.querySelector(".ccc-approvals-summary")).toBeNull();
  });
});

describe("no test here reads the machine clock", () => {
  it("passes every time as a prop and never constructs a Date from the wall clock", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "approvals-section.test.tsx"), "utf8");
    expect(source).not.toMatch(/Date\.now\s*\(/);
    expect(source).not.toMatch(/new\s+Date\s*\(\s*\)/);
    expect(approvalsStatus.value).toBeDefined();
    expect(approvalsReady.value).toBeDefined();
  });
});
