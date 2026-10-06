import type { DecideResponse } from "@ccc/domain/approval.js";
import { HOSTILE_CORPUS } from "@ccc/domain/approval-corpus.js";
import {
  APPROVAL_STATE_DISPLAY,
  capDiffLines,
  neutraliseUntrustedText,
} from "@ccc/domain/approval-view.js";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalDetailResponse } from "../approvals/api.js";
import { proposalId, summary } from "../test-support/approval-fixtures.js";
import {
  approvalDetail,
  approvalView,
  decidedView,
  FIXTURE_HASH,
  FIXTURE_NOW_MS,
  OTHER_HASH,
  testApprovalView,
} from "../test-support/approval-view-fixtures.js";
import { ApprovalDetail, type ApprovalDetailProps } from "./approval-detail.js";
import { APPROVAL_STATUS, DISABLED_REASONS, formatApprovalTime } from "./approvals-copy.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

// ---------------------------------------------------------------------------
// Task 3: the ten states, the edge states and the disconnected pane

const SENTENCES: Readonly<Record<string, RegExp>> = {
  pending: /Expires in 14 min .*If you don't decide, it's denied automatically\./,
  approved: /Approved .*\. Waiting to start\./,
  executing: /Approved .*\. The action is being carried out\. This updates when it finishes\./,
  executed: /Approved .* and carried out .*\./,
  failed: /Approved .*, but it failed: .*\./,
  unknown:
    /The app stopped while this was being carried out, so the result couldn't be confirmed\. .*Nothing is retried automatically\. Ask for a new request if you still need it\./,
  denied: /You denied this request .*\. Nothing was changed\./,
  withdrawn: /The requester withdrew this request\. Nothing was changed\./,
  lapsed:
    /This was approved but not carried out in time, so it was dropped\. Nothing was changed\. Ask for a new request if you still need it\./,
  expired:
    /No decision arrived before .*, so it was denied automatically\. Nothing was changed\. The requester can raise a new request against the current state\./,
};

describe("the ten states (Task 3, Test 1)", () => {
  it.each(Object.keys(SENTENCES))(
    "renders %s with its glyph, label and explanation",
    async (state) => {
      const proposal = state as Parameters<typeof decidedView>[0];
      const view =
        state === "pending"
          ? approvalView()
          : decidedView(
              proposal,
              {},
              state === "executed"
                ? {
                    history: [
                      { event: "requested", at: "2026-10-06T11:59:00.000Z" },
                      { event: "executed", at: "2026-10-06T11:59:40.000Z" },
                    ],
                  }
                : {},
            );
      const { container } = setup({ detail: approvalDetail(view) });
      await loaded();
      const display = APPROVAL_STATE_DISPLAY[proposal];
      const block = container.querySelector('[data-block="state"]') as HTMLElement;
      expect(block.getAttribute("data-state")).toBe(state);
      expect(block.querySelector(".ccc-approval-glyph")?.textContent).toBe(display.glyph);
      expect(block.querySelector(".ccc-approval-glyph")?.getAttribute("aria-hidden")).toBe("true");
      expect(block.querySelector(".ccc-approval-state-label")?.textContent).toBe(display.label);
      expect(block.textContent).toMatch(SENTENCES[state] as RegExp);
    },
  );

  it("offers the decision group only for a pending request, and Open originating run for the rest", async () => {
    for (const state of [
      "approved",
      "executed",
      "failed",
      "unknown",
      "denied",
      "withdrawn",
      "lapsed",
      "expired",
    ] as const) {
      const { container } = setup({ detail: approvalDetail(decidedView(state)) });
      await loaded();
      expect(screen.queryByRole("group", { name: "Decision" }), state).toBeNull();
      expect(screen.queryByRole("button", { name: /^Deny/ }), state).toBeNull();
      expect(screen.queryByRole("button", { name: /^Approve once/ }), state).toBeNull();
      expect(screen.getByRole("button", { name: /^Open originating run/ }), state).toBeTruthy();
      expect(container.querySelector('[data-block="actions"]'), state).toBeTruthy();
      cleanup();
    }
  });

  it("removes both decision buttons for an executing request and shows static text with no spinner", async () => {
    const { container } = setup({ detail: approvalDetail(decidedView("executing")) });
    await loaded();
    expect(screen.queryByRole("button", { name: /Deny|Approve once/ })).toBeNull();
    expect(screen.getByText("Carrying out")).toBeTruthy();
    expect(container.querySelector("progress, svg, [role='progressbar'], .ccc-spinner")).toBeNull();
  });

  it("uses the absolute times the request carries", async () => {
    setup({ detail: approvalDetail(decidedView("executed")) });
    await loaded();
    expect(
      screen.getAllByText(
        new RegExp(formatApprovalTime("2026-10-06T11:59:30.000Z", FIXTURE_NOW_MS)),
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe("failed and unknown (Task 3, Test 2)", () => {
  it.each([
    ["process-ended", "the session's process had already ended"],
    ["run-not-found", "that session is no longer listed"],
    ["identity-mismatch", "the process no longer matches the one you approved"],
    [
      "execution-failed",
      "the command center couldn't run it. Check the service in Settings \u2192 Diagnostics.",
    ],
    [
      "payload-invalid",
      "the command center couldn't run it. Check the service in Settings \u2192 Diagnostics.",
    ],
  ])("explains a failed request with code %s", async (code, phrase) => {
    const { container } = setup({
      detail: approvalDetail(decidedView("failed", { outcomeCode: code })),
    });
    await loaded();
    const text = (container.querySelector('[data-block="state"]') as Element).textContent ?? "";
    expect(text).toContain(`, but it failed: ${phrase}`);
    expect(text).toContain(
      "Check whether the session's process is still running before asking again.",
    );
  });

  it("explains an unknown outcome with the check hint and no failure", async () => {
    const { container } = setup({
      detail: approvalDetail(decidedView("unknown", { outcomeCode: "process-ended" })),
    });
    await loaded();
    const text = (container.querySelector('[data-block="state"]') as Element).textContent ?? "";
    expect(text).toContain(
      "Check whether the session's process is still running before asking again.",
    );
    expect(text).toContain("Nothing is retried automatically.");
  });

  it.each(["unknown", "executed"] as const)(
    "never renders a retry refusal on a %s request as Failed",
    async (state) => {
      const { container } = setup({
        detail: approvalDetail(decidedView(state, { outcomeCode: "run-not-found" })),
      });
      await loaded();
      expect(container.textContent ?? "").not.toMatch(/\bfailed\b/i);
    },
  );
});

describe("a carried-out request whose process is still shutting down (Task 3, Test 3)", () => {
  it("adds the fixed sentence only for the awaiting-exit note", async () => {
    setup({ detail: approvalDetail(decidedView("executed", { outcomeNote: "awaiting-exit" })) });
    await loaded();
    expect(screen.getByText("Carried out. The session is still shutting down.")).toBeTruthy();
    cleanup();
    setup({ detail: approvalDetail(decidedView("executed")) });
    await loaded();
    expect(screen.queryByText("Carried out. The session is still shutting down.")).toBeNull();
  });
});

describe("expiry (Task 3, Test 4)", () => {
  it("reads Expiring\u2026 at the expiry instant and disables both decisions with the reason", async () => {
    setup({
      props: { now: Date.parse("2026-10-06T12:14:00.000Z") },
      detail: approvalDetail(),
    });
    await loaded();
    expect(screen.getByText("Expiring\u2026")).toBeTruthy();
    for (const name of [/^Deny:/, /^Approve once:/]) {
      const button = screen.getByRole("button", { name });
      expect(button.getAttribute("aria-disabled")).toBe("true");
      const reason = document.getElementById(
        (button.getAttribute("aria-describedby") ?? "").split(" ").pop() ?? "",
      );
      expect(reason?.textContent).toBe(DISABLED_REASONS.expired);
    }
  });

  it("marks the time phrase with an emphasis hook in the last five minutes only", async () => {
    const { container } = setup({ props: { now: Date.parse("2026-10-06T12:10:00.000Z") } });
    await loaded();
    expect(container.querySelector('[data-urgent="true"]')?.textContent).toBe("Expires in 4 min");
    cleanup();
    const later = setup();
    await loaded();
    expect(later.container.querySelector('[data-urgent="true"]')).toBeNull();
  });
});

describe("a hash mismatch (Task 3, Test 5)", () => {
  function changedDetail() {
    return approvalDetail(
      approvalView({
        revision: 2,
        record: {
          requestedAt: "2026-10-06T11:59:00.000Z",
          payloadHash: OTHER_HASH,
          fingerprint: OTHER_HASH.slice(0, 12),
          decidedAt: null,
          decidedVia: null,
          outcomeCode: null,
          outcomeNote: null,
        },
      }),
    );
  }

  function mismatchSetup(second: ApprovalDetailResponse) {
    const decide = vi.fn(
      async (_input: Parameters<ApprovalDetailProps["decide"]>[0]): Promise<DecideResponse> => ({
        outcome: "hash-mismatch",
      }),
    );
    const get = vi
      .fn<() => Promise<ApprovalDetailResponse>>()
      .mockResolvedValueOnce(approvalDetail())
      .mockResolvedValue(second);
    const announce = vi.fn();
    const notify = vi.fn();
    const utils = render(
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
    return { ...utils, decide, get, announce, notify };
  }

  it("re-fetches once, shows the changed line until closed, focuses the heading and enables Approve once on the new details", async () => {
    const { decide, get, announce, container } = mismatchSetup(changedDetail());
    const heading = await loaded();
    fireEvent.click(await screen.findByRole("button", { name: /^Approve once:/ }));
    await waitFor(() =>
      expect(
        screen.getByText("The details changed since you first opened this request."),
      ).toBeTruthy(),
    );
    expect(announce).toHaveBeenCalledWith(APPROVAL_STATUS.hashMismatch);
    expect(get).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-block="record"]')?.textContent).toContain(
      OTHER_HASH.slice(0, 12),
    );
    await waitFor(() => expect(document.activeElement).toBe(heading));
    const approve = screen.getByRole("button", { name: /^Approve once:/ });
    expect(approve.getAttribute("aria-disabled")).toBeNull();
    decide.mockResolvedValueOnce({ outcome: "hash-mismatch" });
    fireEvent.click(approve);
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(2));
    expect(decide.mock.calls[1]?.[0]).toMatchObject({ payloadHash: OTHER_HASH });
  });

  it("keeps Approve once disabled while the re-fetched details carry the same fingerprint", async () => {
    mismatchSetup(approvalDetail());
    await loaded();
    fireEvent.click(await screen.findByRole("button", { name: /^Approve once:/ }));
    await waitFor(() =>
      expect(
        screen.getByText("The details changed since you first opened this request."),
      ).toBeTruthy(),
    );
    expect(
      screen.getByRole("button", { name: /^Approve once:/ }).getAttribute("aria-disabled"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: /^Deny:/ }).getAttribute("aria-disabled")).toBeNull();
  });

  it("drops the changed line when the pane closes onto another request", async () => {
    const { rerender, get, decide, announce, notify } = mismatchSetup(changedDetail());
    await loaded();
    fireEvent.click(await screen.findByRole("button", { name: /^Approve once:/ }));
    await waitFor(() =>
      expect(
        screen.getByText("The details changed since you first opened this request."),
      ).toBeTruthy(),
    );
    rerender(
      <ApprovalDetail
        proposalId={proposalId(2)}
        now={FIXTURE_NOW_MS}
        connected={true}
        stale={false}
        get={get}
        decide={decide}
        announce={announce}
        notify={notify}
      />,
    );
    await waitFor(() =>
      expect(
        screen.queryByText("The details changed since you first opened this request."),
      ).toBeNull(),
    );
  });
});

describe("other decision outcomes in the pane (Task 3, Test 6)", () => {
  function outcomeSetup(response: DecideResponse, after: ApprovalDetailResponse) {
    const decide = vi.fn(async (): Promise<DecideResponse> => response);
    const get = vi
      .fn<() => Promise<ApprovalDetailResponse>>()
      .mockResolvedValueOnce(approvalDetail())
      .mockResolvedValue(after);
    const announce = vi.fn();
    const notify = vi.fn();
    const utils = render(
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
    return { ...utils, decide, get, announce, notify };
  }

  it("posts the fixed line and Notice when the request expired during the decision, and shows it expired", async () => {
    const { announce, notify } = outcomeSetup(
      { outcome: "expired" },
      approvalDetail(decidedView("expired")),
    );
    await loaded();
    fireEvent.click(await screen.findByRole("button", { name: /^Deny:/ }));
    await waitFor(() => expect(announce).toHaveBeenCalledWith(APPROVAL_STATUS.expiredDuringDecide));
    expect(notify).toHaveBeenCalledWith(APPROVAL_STATUS.expiredDuringDecide);
    await waitFor(() =>
      expect(screen.getByText("Expired \u2014 denied automatically")).toBeTruthy(),
    );
  });

  it("posts the fixed line and Notice when the request was already decided", async () => {
    const { announce, notify } = outcomeSetup(
      { outcome: "already-decided", state: "denied" },
      approvalDetail(decidedView("denied")),
    );
    await loaded();
    fireEvent.click(await screen.findByRole("button", { name: /^Deny:/ }));
    await waitFor(() => expect(announce).toHaveBeenCalledWith(APPROVAL_STATUS.alreadyDecided));
    expect(notify).toHaveBeenCalledWith(APPROVAL_STATUS.alreadyDecided);
    await waitFor(() => expect(screen.getByText("Denied")).toBeTruthy());
  });

  it("posts the fixed line for a missing request, sends no Notice and leaves the pane as it was", async () => {
    const { announce, notify, get } = outcomeSetup(
      { outcome: "not-found" },
      approvalDetail(decidedView("denied")),
    );
    await loaded();
    fireEvent.click(await screen.findByRole("button", { name: /^Deny:/ }));
    await waitFor(() => expect(announce).toHaveBeenCalledWith(APPROVAL_STATUS.notFound));
    expect(notify).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Deny:/ }).getAttribute("aria-busy")).toBeNull(),
    );
    expect(screen.getByText("Needs your decision")).toBeTruthy();
  });
});

describe("unknown id, load failure and loading (Task 3, Test 7)", () => {
  it("says the request is not in the inbox and moves focus to the heading", async () => {
    const get = vi.fn(async (): Promise<ApprovalDetailResponse> => {
      throw Object.assign(new Error("not-found"), { code: "not-found" });
    });
    setup({ props: { get } });
    const heading = await screen.findByRole("heading", {
      name: "That request isn't in the inbox.",
    });
    expect(
      screen.getByText("It may have been cleared. Pending and recent requests are listed here."),
    ).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.queryByRole("button", { name: /Deny|Approve once/ })).toBeNull();
  });

  it("shows the load error with both decisions withheld", async () => {
    const get = vi.fn(async (): Promise<ApprovalDetailResponse> => {
      throw new Error("boom");
    });
    setup({ props: { get } });
    const heading = await screen.findByRole("heading", { name: /Couldn't load this request\./ });
    expect(heading.textContent).toContain("\u25b2");
    expect(
      screen.getByText("Check the service in Settings \u2192 Diagnostics, then refresh."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Deny|Approve once/ })).toBeNull();
  });

  it("renders skeleton rows with Approve once held for the full request and Deny available", async () => {
    const gate = deferred<ApprovalDetailResponse>();
    const { container } = setup({
      props: {
        get: () => gate.promise,
        summary: summary(1, "pending", 1, { title: "Test approval 1" }),
      },
    });
    expect(container.querySelectorAll(".ccc-skeleton-line").length).toBeGreaterThanOrEqual(3);
    const approve = screen.getByRole("button", { name: /^Approve once/ });
    expect(approve.getAttribute("aria-disabled")).toBe("true");
    expect(
      document.getElementById(
        (approve.getAttribute("aria-describedby") ?? "").split(" ").pop() ?? "",
      )?.textContent,
    ).toBe(DISABLED_REASONS.loading);
    expect(screen.getByRole("button", { name: /^Deny/ }).getAttribute("aria-disabled")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Open originating run/ })).toBeNull();
    gate.resolve(approvalDetail());
    await loaded();
  });

  it("shows no decision group while loading a request the list does not know to be pending", () => {
    const gate = deferred<ApprovalDetailResponse>();
    setup({ props: { get: () => gate.promise, summary: summary(1, "denied", 1) } });
    expect(screen.queryByRole("group", { name: "Decision" })).toBeNull();
  });
});

describe("a selection the current chip does not list (Task 3, Test 8)", () => {
  it("names the chip the request is listed under and offers a button that only calls back", async () => {
    const onShowFilter = vi.fn();
    setup({
      detail: approvalDetail(decidedView("executed")),
      props: { activeFilter: "pending", onShowFilter },
    });
    await loaded();
    expect(screen.getByText("This request is listed under Decided.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show Decided" }));
    expect(onShowFilter).toHaveBeenCalledWith("decided");
  });

  it("says nothing when the request is in the active chip", async () => {
    setup({ props: { activeFilter: "pending", onShowFilter: vi.fn() } });
    await loaded();
    expect(screen.queryByText(/is listed under/)).toBeNull();
  });
});

describe("the record and history (Task 3, Test 9)", () => {
  it("shows the request, its id and the twelve-character fingerprint", async () => {
    const { container } = setup();
    await loaded();
    const record = container.querySelector('[data-block="record"]') as HTMLElement;
    expect(within(record).getByText("Requested")).toBeTruthy();
    expect(within(record).getByText(proposalId(1)).className).toContain("ccc-mono");
    const fingerprint = within(record).getByText(FIXTURE_HASH.slice(0, 12));
    expect(fingerprint.className).toContain("ccc-mono");
    expect(fingerprint.textContent).toHaveLength(12);
    expect(within(record).queryByText("Decided through")).toBeNull();
  });

  it("says a decision came through the command center, or from another local client in weight 600", async () => {
    const { container } = setup({ detail: approvalDetail(decidedView("denied")) });
    await loaded();
    expect(within(container as HTMLElement).getByText("The command center")).toBeTruthy();
    cleanup();
    const other = setup({
      detail: approvalDetail(decidedView("denied", { decidedVia: "other" })),
    });
    await loaded();
    const channel = within(other.container as HTMLElement).getByText("Another local client");
    expect(channel.getAttribute("data-channel")).toBe("other");
  });

  it("lists at most twenty audit events in the fixed vocabulary with absolute times", async () => {
    const history = Array.from({ length: 25 }, (_, index) => ({
      event: index === 0 ? ("requested" as const) : ("claimed" as const),
      at: "2026-10-06T11:59:00.000Z",
    }));
    const { container } = setup({ detail: approvalDetail(approvalView({ history })) });
    await loaded();
    const items = container.querySelectorAll('[data-block="history"] ol > li');
    expect(items).toHaveLength(20);
    expect(items[0]?.textContent).toContain("Requested");
    expect(items[1]?.textContent).toContain("Started carrying out");
    expect(items[0]?.textContent).toContain(
      formatApprovalTime("2026-10-06T11:59:00.000Z", FIXTURE_NOW_MS),
    );
  });
});

describe("disconnected (Task 3, Test 12)", () => {
  it("dims the pane and disables every service-backed control with the fixed reason", async () => {
    const { container } = setup({ props: { connected: false } });
    await loaded();
    expect(container.querySelector("section")?.getAttribute("data-dimmed")).toBe("true");
    const names = [/^Deny:/, /^Approve once:/, /^Open originating run/];
    for (const name of names) {
      const button = screen.getByRole("button", { name });
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.hasAttribute("disabled")).toBe(false);
      const reason = document.getElementById(
        (button.getAttribute("aria-describedby") ?? "").split(" ").pop() ?? "",
      );
      expect(reason?.textContent).toBe(DISABLED_REASONS.disconnected);
    }
    expect(
      screen.getByRole("button", { name: "Refactor parser" }).getAttribute("aria-disabled"),
    ).toBe("true");
  });
});

describe("out-of-order fetches (06-w3 finding 4)", () => {
  it("applies only the latest fetch when an older one for the same request resolves last", async () => {
    const first = deferred<ApprovalDetailResponse>();
    const second = deferred<ApprovalDetailResponse>();
    const get = vi
      .fn<() => Promise<ApprovalDetailResponse>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const base: ApprovalDetailProps = {
      proposalId: proposalId(1),
      now: FIXTURE_NOW_MS,
      connected: true,
      stale: false,
      revision: 1,
      get,
      decide: vi.fn(),
      announce: vi.fn(),
      notify: vi.fn(),
    };
    const view = render(<ApprovalDetail {...base} />);
    view.rerender(<ApprovalDetail {...base} revision={2} />);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    second.resolve(approvalDetail(decidedView("executed")));
    await waitFor(() => expect(screen.getAllByText("Carried out")[0]).toBeTruthy());
    first.resolve(approvalDetail());
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(screen.getAllByText("Carried out")[0]).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Decision" })).toBeNull();
  });
});
