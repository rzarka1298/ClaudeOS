import type { DecideResponse } from "@ccc/domain/approval.js";
import { HOSTILE_CORPUS } from "@ccc/domain/approval-corpus.js";
import { capDiffLines, neutraliseUntrustedText } from "@ccc/domain/approval-view.js";
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
  await waitFor(() => expect(screen.queryByText("Loading approval request")).toBeNull());
  return screen.getByRole("heading", { level: 4 });
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
      screen.getByText(
        "Force-terminate the Claude Code session Refactor parser by ending its process.",
      ),
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
    expect(screen.getByRole("button", { name: /^Approve once:/ })).not.toBe(document.activeElement);
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

/** The text a sighted reader sees: the hidden prefixes removed. */
function visibleText(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  for (const hidden of clone.querySelectorAll(".ccc-visually-hidden")) hidden.remove();
  return clone.textContent ?? "";
}

describe("hostile requester text (Task 2, Test 1)", () => {
  it.each(HOSTILE_CORPUS.map((entry) => [entry.name, entry] as const))(
    "renders %s as literal text and nothing else",
    async (_name, entry) => {
      const label = neutraliseUntrustedText(entry.text, { max: 64 }).text;
      const title = neutraliseUntrustedText(entry.text, { max: 120 }).text || "Request";
      const reasonFull = neutraliseUntrustedText(entry.text, {
        max: 4000,
        multiline: true,
        maxOutput: 8000,
      }).text;
      const reasonShown = neutraliseUntrustedText(entry.text, {
        max: 1000,
        multiline: true,
        maxOutput: 2000,
      }).text;
      const change = capDiffLines([{ kind: "added", text: entry.text }], "requester").change;
      const { container } = setup({
        detail: approvalDetail(
          approvalView({
            title,
            requester: { kind: "skill", label },
            reason: {
              origin: "requester",
              shown: reasonShown,
              full: reasonFull,
              shortened: false,
            },
            change,
            project: label,
          }),
        ),
      });
      await loaded();

      // No element was made from the text: no link, image, script, markup or form control.
      expect(
        container.querySelector(
          "a, img, script, b, i, em, strong, code, iframe, svg, style, object, embed, link, form, input, textarea, select",
        ),
      ).toBeNull();
      for (const element of container.querySelectorAll("*")) {
        for (const attribute of element.getAttributeNames()) {
          expect(attribute.startsWith("on"), attribute).toBe(false);
          expect(["href", "src", "style", "srcdoc"]).not.toContain(attribute);
        }
        if (label.length > 3) {
          expect(element.getAttribute("id") ?? "").not.toContain(label);
          expect(element.getAttribute("class") ?? "").not.toContain(label);
        }
      }

      // The text is all there, as the characters the requester sent (already neutralised).
      const seen = visibleText(container);
      expect(seen).toContain(label);
      const reason = container.querySelector(".ccc-approval-reason") as Element;
      expect(visibleText(reason)).toBe(reasonShown);
      const diffLine = container.querySelector(".ccc-diff-text") as Element;
      expect(visibleText(diffLine)).toBe(change.lines[0]?.text);

      // Every visible control token is announced as a control character first.
      const tokens = [...container.querySelectorAll(".ccc-control-token")];
      for (const expected of entry.tokens) {
        expect(seen).toContain(expected);
      }
      if (entry.tokens.length > 0) expect(tokens.length).toBeGreaterThan(0);
      for (const token of tokens) {
        expect(token.firstElementChild?.className).toContain("ccc-visually-hidden");
        expect(token.firstElementChild?.textContent).toMatch(/^control character/);
        expect(token.textContent).toMatch(/\[U\+[0-9A-F]{4,6}\]$/);
      }
    },
  );

  it("shows Markdown emphasis and link text as the literal characters", async () => {
    const text = "**bold** and [click here](https://example.invalid/path)";
    const { container } = setup({
      detail: approvalDetail(approvalView({ requester: { kind: "skill", label: text } })),
    });
    await loaded();
    expect(visibleText(container)).toContain(text);
    expect(container.querySelector("[href]")).toBeNull();
  });
});

describe("provenance captions (Task 2, Test 2)", () => {
  it("captions a requester block from the engine-assigned kind and marks it for the dashed border", async () => {
    const { container } = setup({
      detail: approvalDetail(
        approvalView({
          requester: { kind: "skill", label: "research-brief" },
          change: {
            type: "payload",
            origin: "requester",
            fields: [{ label: "title", value: "Weekly review" }],
          },
        }),
      ),
    });
    await loaded();
    for (const block of ["change", "reason"]) {
      const element = container.querySelector(`[data-block="${block}"]`) as Element;
      expect(element.getAttribute("data-origin")).toBe("requester");
      expect(element.querySelector("[data-caption]")?.textContent).toBe(
        "Provided by Skill: research-brief",
      );
    }
    const engine = container.querySelector('[data-block="happen"]') as Element;
    expect(engine.getAttribute("data-origin")).toBe("engine");
    expect(engine.querySelector("[data-caption]")?.textContent).toBe(
      "Computed by the command center",
    );
  });

  it("cannot be made to look engine-computed by a label of System", async () => {
    const { container } = setup({
      detail: approvalDetail(approvalView({ requester: { kind: "automation", label: "System" } })),
    });
    await loaded();
    const reason = container.querySelector('[data-block="reason"]') as Element;
    expect(reason.getAttribute("data-origin")).toBe("requester");
    expect(reason.querySelector("[data-caption]")?.textContent).toBe(
      "Provided by Automation: System",
    );
    expect(reason.textContent).not.toContain("Computed by the command center");
  });
});

describe("the reason block (Task 2, Test 6)", () => {
  const long = {
    origin: "requester",
    shown: "A".repeat(20),
    full: `${"A".repeat(20)}${"B".repeat(20)}`,
    shortened: false,
  };

  it("shows the shortened text, says so, and reveals the full text on request", async () => {
    const { container } = setup({ detail: approvalDetail(approvalView({ reason: long })) });
    await loaded();
    const reason = container.querySelector('[data-block="reason"]') as Element;
    expect(visibleText(reason.querySelector(".ccc-approval-reason") as Element)).toBe(long.shown);
    expect(within(reason as HTMLElement).getByText("Text shortened for display.")).toBeTruthy();
    fireEvent.click(within(reason as HTMLElement).getByRole("button", { name: "Show full text" }));
    expect(visibleText(reason.querySelector(".ccc-approval-reason") as Element)).toBe(long.full);
    expect(within(reason as HTMLElement).queryByText("Text shortened for display.")).toBeNull();
    const toggle = within(reason as HTMLElement).getByRole("button", { name: "Show shorter text" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps saying the text was shortened when even the full text was cut", async () => {
    const { container } = setup({
      detail: approvalDetail(approvalView({ reason: { ...long, shortened: true } })),
    });
    await loaded();
    const reason = container.querySelector('[data-block="reason"]') as HTMLElement;
    fireEvent.click(within(reason).getByRole("button", { name: "Show full text" }));
    expect(within(reason).getByText("Text shortened for display.")).toBeTruthy();
  });

  it("offers neither the line nor the button for a short reason", async () => {
    const { container } = setup();
    await loaded();
    const reason = container.querySelector('[data-block="reason"]') as HTMLElement;
    expect(within(reason).queryByText("Text shortened for display.")).toBeNull();
    expect(within(reason).queryByRole("button")).toBeNull();
  });

  it("preserves line breaks with a wrapping rule and collapses none", async () => {
    const text = "first line\nsecond line\n\nfourth line";
    const { container } = setup({
      detail: approvalDetail(
        approvalView({
          reason: { origin: "requester", shown: text, full: text, shortened: false },
        }),
      ),
    });
    await loaded();
    const reason = container.querySelector(".ccc-approval-reason") as Element;
    expect(reason.textContent).toBe(text);
    expect(reason.className).toContain("ccc-approval-reason");
  });
});

describe("a change that was not fully shown cannot be approved (Task 2, Test 7)", () => {
  it("says so in the change block, withholds Approve once and leaves Deny enabled", async () => {
    const { container } = setup({
      detail: approvalDetail(approvalView({ reviewable: false })),
    });
    await loaded();
    const change = container.querySelector('[data-block="change"]') as HTMLElement;
    expect(within(change).getByText("This change is too large to review here.")).toBeTruthy();
    const approve = screen.getByRole("button", { name: /^Approve once:/ });
    expect(approve.getAttribute("aria-disabled")).toBe("true");
    expect(
      document.getElementById(approve.getAttribute("aria-describedby")?.split(" ").pop() ?? "")
        ?.textContent,
    ).toBe("This change is too large to review here, so it can't be approved from here.");
    const deny = screen.getByRole("button", { name: /^Deny:/ });
    expect(deny.getAttribute("aria-disabled")).toBeNull();
  });

  it("treats a diff past its display cap as too large even if the service did not say so", async () => {
    const lines = Array.from({ length: 501 }, (_, index) => ({
      kind: "context" as const,
      text: `line ${index}`,
      count: null,
    }));
    const { container } = setup({
      detail: approvalDetail(
        approvalView({ change: { type: "diff", origin: "engine", lines }, reviewable: true }),
      ),
    });
    await loaded();
    expect(
      within(container.querySelector('[data-block="change"]') as HTMLElement).getByText(
        "This change is too large to review here.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /^Approve once:/ }).getAttribute("aria-disabled"),
    ).toBe("true");
  });
});

describe("long values (Task 2, Test 8)", () => {
  it("keeps the full text of a target value and the requester label in a title, with an overflow hook", async () => {
    const value = "v".repeat(200);
    const label = "L".repeat(64);
    const { container } = setup({
      detail: approvalDetail(
        approvalView({
          requester: { kind: "skill", label },
          target: [{ label: "Path", value, mono: true }],
        }),
      ),
    });
    await loaded();
    const target = container.querySelector('[data-block="target"] dd') as Element;
    expect(target.getAttribute("title")).toBe(value);
    expect(target.className).toContain("ccc-approval-value");
    const requestedBy = container.querySelector('[data-block="who"] dd') as Element;
    expect(requestedBy.getAttribute("title")).toBe(`Skill: ${label}`);
    expect(requestedBy.className).toContain("ccc-approval-value");
  });
});
