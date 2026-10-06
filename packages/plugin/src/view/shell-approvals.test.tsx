import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  adoptApprovalsSnapshot,
  approvalDetailFocusRequested,
  resetApprovalsState,
  selectedProposalId,
} from "../approvals/signals.js";
import { connectionState } from "../connection-state.js";
import { approvalsSnapshot, proposalId, summary } from "../test-support/approval-fixtures.js";
import type {
  NavigationSelection,
  QuickActionDescriptor,
  WidgetBodyProps,
} from "../widgets/contract.js";
import { selectedRunId } from "./agent-runs-state.js";
import {
  approvalsHeadingRequested,
  navigationRequest,
  requestDestination,
  taskFormRequested,
} from "./navigation-request.js";
import { Shell } from "./shell.js";

/**
 * Plan 06-10, Task 3: the selection union, the shell's handling of the new
 * navigation intents and the Agent runs count chip (UI-SPEC S6, E13, R-23).
 * The Overview is replaced by a probe that exposes the two channels a body
 * has out of its card, `onNavigate` and `onQuickAction`.
 */

type Selection = { runId: string } | { proposalId: string } | { taskId: string };

vi.mock("./overview.js", () => ({
  Overview: (props: {
    onNavigate: (destination: string, selection?: Selection) => void;
    onQuickAction: (descriptor: QuickActionDescriptor) => void;
  }) => (
    <div>
      <button type="button" onClick={() => props.onNavigate("agent-runs", { runId: "run-1" })}>
        go-run
      </button>
      <button
        type="button"
        onClick={() => props.onNavigate("agent-runs", { proposalId: "0mfk1a2b3c4d5e6f7a8b9c001" })}
      >
        go-proposal
      </button>
      <button type="button" onClick={() => props.onNavigate("tasks", { taskId: "task-1" })}>
        go-task
      </button>
      <button type="button" onClick={() => props.onNavigate("tasks")}>
        go-plain
      </button>
      <button
        type="button"
        onClick={() =>
          props.onQuickAction({
            id: "create-task",
            label: "Create a task",
            capability: "task:create",
          })
        }
      >
        create-task
      </button>
    </div>
  ),
}));

function reset(): void {
  cleanup();
  resetApprovalsState();
  selectedRunId.value = null;
  navigationRequest.value = null;
  taskFormRequested.value = false;
  approvalsHeadingRequested.value = false;
  connectionState.value = { kind: "connecting" };
}
beforeEach(reset);
afterEach(reset);

function tab(name: string | RegExp): HTMLElement {
  return screen.getByRole("tab", { name });
}

describe("onNavigate accepts a run, a proposal or a task selection (Test 1)", () => {
  it("a proposal selection selects the destination, the request and requests detail focus", () => {
    connectionState.value = { kind: "live" };
    render(<Shell />);
    fireEvent.click(screen.getByRole("button", { name: "go-proposal" }));
    expect(tab(/^Agent runs/).getAttribute("aria-selected")).toBe("true");
    expect(selectedProposalId.value).toBe("0mfk1a2b3c4d5e6f7a8b9c001");
    expect(approvalDetailFocusRequested.value).toBe(true);
    expect(selectedRunId.value).toBeNull();
  });

  it("a run selection behaves as before and leaves the proposal signals alone", () => {
    connectionState.value = { kind: "live" };
    render(<Shell />);
    fireEvent.click(screen.getByRole("button", { name: "go-run" }));
    expect(selectedRunId.value).toBe("run-1");
    expect(selectedProposalId.value).toBeNull();
    expect(approvalDetailFocusRequested.value).toBe(false);
  });

  it("a task selection only navigates and changes no signal", () => {
    connectionState.value = { kind: "live" };
    render(<Shell />);
    fireEvent.click(screen.getByRole("button", { name: "go-task" }));
    expect(tab("Tasks").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Tasks"));
    expect(selectedRunId.value).toBeNull();
    expect(selectedProposalId.value).toBeNull();
    expect(approvalDetailFocusRequested.value).toBe(false);
  });

  it("moves tab focus to the destination, as the run selection already does", () => {
    connectionState.value = { kind: "live" };
    render(<Shell />);
    fireEvent.click(screen.getByRole("button", { name: "go-proposal" }));
    expect(document.activeElement).toBe(tab(/^Agent runs/));
  });
});

describe("the selection type (Test 2)", () => {
  it("is the union of the three shapes and a body's onNavigate prop accepts each", () => {
    type OnNavigate = NonNullable<WidgetBodyProps<unknown>["onNavigate"]>;
    type Accepted = NonNullable<Parameters<OnNavigate>[1]>;
    expectTypeOf<NavigationSelection>().toEqualTypeOf<
      { readonly runId: string } | { readonly proposalId: string } | { readonly taskId: string }
    >();
    expectTypeOf<{ readonly runId: string }>().toExtend<Accepted>();
    expectTypeOf<{ readonly proposalId: string }>().toExtend<Accepted>();
    expectTypeOf<{ readonly taskId: string }>().toExtend<Accepted>();
    // A selection naming none of the three keys is not accepted.
    expectTypeOf<{ readonly somethingElse: string }>().not.toExtend<Accepted>();
  });
});

describe("navigation intents (Test 3)", () => {
  it("an approvals-heading request navigates to Agent runs and leaves the intent for the section", async () => {
    connectionState.value = { kind: "live" };
    render(<Shell />);
    await act(async () => {
      requestDestination("agent-runs", { focusApprovalsHeading: true });
    });
    expect(tab(/^Agent runs/).getAttribute("aria-selected")).toBe("true");
    expect(approvalsHeadingRequested.value).toBe(true);
    expect(navigationRequest.value).toBeNull();
  });

  it("a request carrying a proposal id selects it and asks for detail focus", async () => {
    connectionState.value = { kind: "live" };
    render(<Shell />);
    await act(async () => {
      requestDestination("agent-runs", { focusProposalId: proposalId(7) });
    });
    expect(tab(/^Agent runs/).getAttribute("aria-selected")).toBe("true");
    expect(selectedProposalId.value).toBe(proposalId(7));
    expect(approvalDetailFocusRequested.value).toBe(true);
  });

  it("a request asking for the create form navigates to Tasks and leaves the intent set", async () => {
    connectionState.value = { kind: "live" };
    render(<Shell />);
    await act(async () => {
      requestDestination("tasks", { openTaskForm: true });
    });
    expect(tab("Tasks").getAttribute("aria-selected")).toBe("true");
    expect(taskFormRequested.value).toBe(true);
  });

  it("the existing project and plain destination requests still work", async () => {
    connectionState.value = { kind: "live" };
    render(<Shell />);
    await act(async () => {
      requestDestination("knowledge");
    });
    expect(tab("Knowledge").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Knowledge"));
    expect(approvalsHeadingRequested.value).toBe(false);
    expect(taskFormRequested.value).toBe(false);
  });

  it("the task:create quick action navigates to Tasks and sets the create-form intent", () => {
    connectionState.value = { kind: "live" };
    render(<Shell />);
    fireEvent.click(screen.getByRole("button", { name: "create-task" }));
    expect(tab("Tasks").getAttribute("aria-selected")).toBe("true");
    expect(taskFormRequested.value).toBe(true);
  });
});

describe("the Agent runs count chip (Test 4)", () => {
  function chip(): HTMLElement | null {
    return document.querySelector<HTMLElement>(".ccc-nav-count");
  }

  it("shows the count, aria-hidden, with a visually hidden plural suffix", () => {
    adoptApprovalsSnapshot(approvalsSnapshot({ pending: [summary(1), summary(2)] }));
    render(<Shell />);
    const el = chip();
    expect(el?.textContent).toBe("2");
    expect(el?.getAttribute("aria-hidden")).toBe("true");
    const agentTab = tab(/^Agent runs/);
    expect(agentTab.contains(el)).toBe(true);
    expect(agentTab.querySelector(".ccc-visually-hidden")?.textContent).toBe(
      ", 2 approval requests need your decision",
    );
    expect(agentTab.getAttribute("aria-selected")).toBe("false");
    expect(tab("Agent runs, 2 approval requests need your decision")).toBe(agentTab);
  });

  it("uses the singular sentence for one request", () => {
    adoptApprovalsSnapshot(approvalsSnapshot({ pending: [summary(1)] }));
    render(<Shell />);
    expect(tab(/^Agent runs/).querySelector(".ccc-visually-hidden")?.textContent).toBe(
      ", 1 approval request needs your decision",
    );
  });

  it("caps the visible count at 9+ and keeps the true count in the spoken suffix", () => {
    adoptApprovalsSnapshot(
      approvalsSnapshot({
        pending: [summary(1)],
        counts: { pending: 12, decided: 0, expired: 0 },
      }),
    );
    render(<Shell />);
    expect(chip()?.textContent).toBe("9+");
    expect(tab(/^Agent runs/).querySelector(".ccc-visually-hidden")?.textContent).toBe(
      ", 12 approval requests need your decision",
    );
    cleanup();
    adoptApprovalsSnapshot(
      approvalsSnapshot({ pending: [summary(1)], counts: { pending: 9, decided: 0, expired: 0 } }),
    );
    render(<Shell />);
    expect(chip()?.textContent).toBe("9");
  });

  it("renders neither element for a count of zero or null", () => {
    render(<Shell />);
    expect(chip()).toBeNull();
    expect(document.querySelector(".ccc-visually-hidden")).toBeNull();
    cleanup();
    adoptApprovalsSnapshot(approvalsSnapshot());
    render(<Shell />);
    expect(chip()).toBeNull();
    expect(tab(/^Agent runs/).textContent).toBe("Agent runs");
  });

  it("is never styled as accent or danger by markup: a plain span with the one class", () => {
    adoptApprovalsSnapshot(approvalsSnapshot({ pending: [summary(1)] }));
    render(<Shell />);
    const el = chip();
    expect(el?.tagName).toBe("SPAN");
    expect(el?.className).toBe("ccc-nav-count");
    expect(el?.getAttribute("style")).toBeNull();
  });

  it("updates when an upsert changes the pending count", () => {
    adoptApprovalsSnapshot(approvalsSnapshot({ pending: [summary(1)] }));
    render(<Shell />);
    expect(chip()?.textContent).toBe("1");
    act(() => {
      adoptApprovalsSnapshot(approvalsSnapshot({ pending: [summary(1), summary(2), summary(3)] }));
    });
    expect(chip()?.textContent).toBe("3");
  });
});

describe("the chip stays honest (Test 5, UI-SPEC E13)", () => {
  it("keeps the last known count when the service disconnects", () => {
    connectionState.value = { kind: "live" };
    adoptApprovalsSnapshot(approvalsSnapshot({ pending: [summary(1), summary(2)] }));
    render(<Shell />);
    act(() => {
      connectionState.value = { kind: "disconnected", reason: "service stopped" };
    });
    expect(document.querySelector(".ccc-nav-count")?.textContent).toBe("2");
  });

  it("is absent before the first snapshot and the tab is not blocked", () => {
    connectionState.value = { kind: "connecting" };
    render(<Shell />);
    expect(document.querySelector(".ccc-nav-count")).toBeNull();
    fireEvent.click(tab("Agent runs"));
    expect(tab("Agent runs").getAttribute("aria-selected")).toBe("true");
  });
});

describe("the pinned tab labels (Test 6, SC-6)", () => {
  it("renders every destination label exactly as before, and only Agent runs can carry a chip", () => {
    adoptApprovalsSnapshot(approvalsSnapshot({ pending: [summary(1), summary(2), summary(3)] }));
    render(<Shell />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(8);
    const labels = [
      "Overview",
      "Projects",
      "Research",
      "Tasks",
      "Agent runs",
      "Skills",
      "Knowledge",
      "Settings",
    ];
    tabs.forEach((el, index) => {
      const label = labels[index] ?? "";
      expect(el.firstChild?.textContent).toBe(label);
      const hasChip = el.querySelector(".ccc-nav-count") !== null;
      expect(hasChip).toBe(label === "Agent runs");
      if (label !== "Agent runs") expect(el.textContent).toBe(label);
    });
  });
});
