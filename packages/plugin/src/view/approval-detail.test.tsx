import type { DecideResponse } from "@ccc/domain/approval.js";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalDetailResponse } from "../approvals/api.js";
import { proposalId, summary } from "../test-support/approval-fixtures.js";
import {
  approvalDetail,
  approvalView,
  FIXTURE_HASH,
  FIXTURE_NOW_MS,
  testApprovalView,
} from "../test-support/approval-view-fixtures.js";
import { ApprovalDetail, type ApprovalDetailProps } from "./approval-detail.js";
import { APPROVAL_STATUS } from "./approvals-copy.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup(
  options: {
    readonly detail?: ApprovalDetailResponse;
    readonly props?: Partial<ApprovalDetailProps>;
  } = {},
) {
  const detail = options.detail ?? approvalDetail();
  const get = vi.fn(async () => detail);
  const decide = vi.fn(async (): Promise<DecideResponse> => {
    throw new Error("decide was not expected");
  });
  const announce = vi.fn();
  const notify = vi.fn();
  const props: ApprovalDetailProps = {
    proposalId: proposalId(1),
    now: FIXTURE_NOW_MS,
    connected: true,
    stale: false,
    get,
    decide,
    announce,
    notify,
    ...options.props,
  };
  const utils = render(<ApprovalDetail {...props} />);
  return { ...utils, props, get, decide, announce, notify };
}

async function loaded(): Promise<HTMLElement> {
  return screen.findByRole("heading", { level: 4 });
}

describe("block order (Test 1)", () => {
  it("renders the regions of a destructive pending request in the fixed order with their captions", async () => {
    const { container } = setup();
    await loaded();
    const order = [...container.querySelectorAll("[data-block]")].map((el) =>
      el.getAttribute("data-block"),
    );
    expect(order).toEqual([
      "heading",
      "state",
      "who",
      "happen",
      "target",
      "change",
      "reason",
      "risks",
      "decision",
      "record",
      "history",
    ]);
    const captionOf = (block: string) =>
      container.querySelector(`[data-block="${block}"] [data-caption]`)?.textContent;
    expect(captionOf("happen")).toBe("Computed by the command center");
    expect(captionOf("target")).toBe("Computed by the command center");
    expect(captionOf("change")).toBe("Computed by the command center");
    expect(captionOf("reason")).toBe("Provided by Dashboard: Dashboard");
    expect(captionOf("risks")).toBe("Computed by the command center");
  });

  it("shows every APPR-03 field from the view model", async () => {
    setup();
    const heading = await loaded();
    expect(heading.textContent).toBe("Force-terminate Refactor parser");
    expect(screen.getByText("□")).toBeTruthy();
    expect(screen.getByText("Needs your decision")).toBeTruthy();
    expect(screen.getByText("Dashboard: Dashboard")).toBeTruthy();
    expect(screen.getByText("example-project")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refactor parser" })).toBeTruthy();
    expect(
      screen.getByText("Force-terminate the Claude Code session Refactor parser by ending its process."),
    ).toBeTruthy();
    expect(screen.getByText("claude · PID 4242")).toBeTruthy();
    expect(screen.getByText("The session stopped responding.")).toBeTruthy();
    expect(screen.getByText("Unsaved work in that session is lost.")).toBeTruthy();
    expect(screen.getByText("state: cancelled")).toBeTruthy();
    expect(screen.getByText(/If you don't decide, it's denied automatically\./)).toBeTruthy();
  });

  it("renders requester text only as text and never as markup or a link", async () => {
    const { container } = setup({
      detail: approvalDetail(
        approvalView({
          requester: { kind: "skill", label: "**bold** [x](https://example.invalid)" },
        }),
      ),
    });
    await loaded();
    expect(container.querySelector("a, img, script, b, strong, em")).toBeNull();
    expect(container.querySelector("[href]")).toBeNull();
    expect(container.textContent).toContain("**bold** [x](https://example.invalid)");
  });

  it("marks a requester block as requester-origin and an engine block as engine-origin", async () => {
    const { container } = setup();
    await loaded();
    expect(container.querySelector('[data-block="reason"]')?.getAttribute("data-origin")).toBe(
      "requester",
    );
    expect(container.querySelector('[data-block="happen"]')?.getAttribute("data-origin")).toBe(
      "engine",
    );
  });
});

describe("focus on arrival (Test 2)", () => {
  beforeEach(() => {
    // jsdom has no layout; the pane scrolls its heading with the instant form only.
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  });

  it("focuses Deny with preventScroll for a destructive pending request", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    setup();
    await loaded();
    const deny = screen.getByRole("button", { name: /^Deny:/ });
    await waitFor(() => expect(document.activeElement).toBe(deny));
    const denyCall = focus.mock.calls.find((_call, index) => focus.mock.contexts[index] === deny);
    expect(denyCall?.[0]).toEqual({ preventScroll: true });
    const approve = screen.getByRole("button", { name: /^Approve once:/ });
    expect(approve).not.toBe(document.activeElement);
    expect(focus.mock.contexts).not.toContain(approve);
  });

  it("describes Deny with a hidden summary of the title and the time left", async () => {
    setup();
    await loaded();
    const deny = screen.getByRole("button", { name: /^Deny:/ });
    const ids = (deny.getAttribute("aria-describedby") ?? "").split(" ");
    const text = ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
    expect(text).toContain("Force-terminate Refactor parser. Expires in 14 min.");
  });

  it("focuses the heading for a request that is not destructive", async () => {
    setup({ detail: approvalDetail(testApprovalView()) });
    const heading = await loaded();
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(heading.getAttribute("tabindex")).toBe("-1");
    expect(screen.getByRole("button", { name: /^Approve once:/ })).not.toBe(
      document.activeElement,
    );
  });

  it("does not move focus when the parent has not asked for it", async () => {
    const before = document.activeElement;
    setup({ props: { focusOnLoad: false } });
    await loaded();
    expect(document.activeElement).toBe(before);
  });
});

describe("deciding from the pane", () => {
  it("sends the hash it displayed, then moves focus to the heading with the new state", async () => {
    const decide = vi.fn(
      async (): Promise<DecideResponse> => ({
        outcome: "decided",
        approval: summary(1, "approved", 2),
      }),
    );
    const announce = vi.fn();
    const notify = vi.fn();
    const get = vi
      .fn<() => Promise<ApprovalDetailResponse>>()
      .mockResolvedValueOnce(approvalDetail())
      .mockResolvedValueOnce(approvalDetail(approvalView({ state: "approved", revision: 2 })));
    render(
      <ApprovalDetail
        proposalId={proposalId(1)}
        now={FIXTURE_NOW_MS}
        connected={true}
        stale={false}
        get={get}
        decide={decide}
        announce={announce}
        notify={notify}
      />,
    );
    const heading = await loaded();
    fireEvent.click(await screen.findByRole("button", { name: /^Approve once:/ }));
    await waitFor(() =>
      expect(decide).toHaveBeenCalledWith({
        proposalId: proposalId(1),
        decision: "approve",
        payloadHash: FIXTURE_HASH,
      }),
    );
    await waitFor(() => expect(announce).toHaveBeenCalledWith(APPROVAL_STATUS.approved));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Decision" })).toBeNull());
    expect(within(document.body).getByText("Approved")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });
});
