import type { CodexUsageSnapshot, HeadroomSignal } from "@ccc/domain/codex-usage.js";
import { cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, expect, it } from "vitest";
import { CodexHeadroomSection } from "./codex-headroom.js";

const observedAt = "2026-10-08T12:00:00.000Z";
const nowMs = Date.parse(observedAt);
const usage: CodexUsageSnapshot = {
  kind: "available",
  windows: [
    {
      windowMinutes: 10080,
      usedPercent: 41,
      resetsAt: "2026-10-09T16:40:00.000Z",
      limitLabel: null,
    },
  ],
  ordinaryUsageAllowed: true,
  rateLimitReached: false,
  rateLimitReachedType: null,
  source: "app-server",
  observedAt,
  freshness: "live",
};
const headroom: HeadroomSignal = {
  generatedAt: observedAt,
  claude: {
    kind: "available",
    window: "five-hour",
    usedPercent: 62,
    resetsAt: "2026-10-09T16:40:00.000Z",
    source: "claude-code-status-line",
    observedAt,
    freshness: "live",
  },
  codex: {
    verdict: "allow",
    reason: null,
    worstWindow: { windowMinutes: 10080, usedPercent: 41, resetsAt: "2026-10-09T16:40:00.000Z" },
    source: "app-server",
    observedAt,
    freshness: "live",
    pausedRuns: { count: 0, earliestResetAt: null },
  },
};

import type { CodexCardData } from "./codex-signals.js";
export const data: CodexCardData = {
  sessions: null,
  usage,
  headroom,
  tokens: null,
  integration: null,
  nowMs,
  analysisOn: false,
};
afterEach(cleanup);
it("renders Claude then Codex, the verdict and a read-only strip", () => {
  const { container, getByText, getByRole } = render(<CodexHeadroomSection data={data} />);
  expect(
    [...container.querySelectorAll(".ccc-headroom-cell")].map(
      (cell) => cell.firstElementChild?.textContent,
    ),
  ).toEqual(["Claude", "Codex"]);
  getByText("Has headroom");
  getByText("62% used · 5-hour window");
  expect(container.textContent).not.toMatch(/41% used|7-day window|10,080/);
  expect(container.querySelectorAll(".ccc-headroom-cell button")).toHaveLength(0);
  getByRole("button", { name: "Source for headroom" });
});
it("gives every row of the two columns a fixed grid row so verdicts and reasons align", () => {
  const view = render(
    <CodexHeadroomSection
      data={{
        ...data,
        headroom: {
          ...headroom,
          codex: { ...headroom.codex, verdict: "refuse", reason: "paused-run" },
        },
      }}
    />,
  );
  const [claude, codex] = [...view.container.querySelectorAll(".ccc-headroom-cell")];
  expect(claude?.querySelector(".ccc-headroom-reason")).toBeNull();
  expect(claude?.querySelector(".ccc-headroom-observed")).not.toBeNull();
  expect(codex?.querySelector(".ccc-headroom-reason")?.textContent).toBe(
    "A paused run is waiting for its reset.",
  );
  expect(codex?.querySelector(".ccc-headroom-observed")).not.toBeNull();
});
it("keeps unavailable Claude capacity numeric-free", () => {
  const { container, getByText } = render(
    <CodexHeadroomSection
      data={{
        ...data,
        headroom: { ...headroom, claude: { kind: "unavailable", reason: "no-report-yet" } },
      }}
    />,
  );
  getByText("Account capacity unavailable");
  expect(container.querySelector(".ccc-headroom-cell")?.textContent).not.toMatch(/[0-9%]/);
});

it.each([
  ["reserve-line", "At or over the 80% reserve line."],
  ["usage-not-allowed", "Codex says ordinary usage isn't allowed right now."],
  ["paused-run", "A paused run is waiting for its reset."],
  ["no-live-read", "No live usage read yet."],
  ["usage-unavailable", "Usage is unavailable."],
] as const)("renders one reason for %s and discloses the Claude number", (reason, line) => {
  const view = render(
    <CodexHeadroomSection
      data={{
        ...data,
        headroom: { ...headroom, codex: { ...headroom.codex, verdict: "refuse", reason } },
      }}
    />,
  );
  view.getByText(line);
  view.getByText("Held back");
  fireEvent.click(view.getByRole("button", { name: "Source for headroom" }));
  expect(view.container.querySelector(".ccc-source-panel")?.textContent).toContain(
    "Claude 5-hour window: 62% used",
  );
});
it("shows plural paused runs and their earliest absolute resume", () => {
  const view = render(
    <CodexHeadroomSection
      data={{
        ...data,
        headroom: {
          ...headroom,
          codex: {
            ...headroom.codex,
            verdict: "refuse",
            reason: "paused-run",
            pausedRuns: { count: 2, earliestResetAt: null },
          },
        },
      }}
    />,
  );
  view.getByText("2 runs paused by the usage limit. Reset time not reported.");
});
it("preserves a higher-priority reserve refusal even on a fallback", () => {
  const view = render(
    <CodexHeadroomSection
      data={{
        ...data,
        usage: usage.kind === "available" ? { ...usage, source: "rollout-fallback" } : usage,
        headroom: {
          ...headroom,
          codex: { ...headroom.codex, verdict: "refuse", reason: "reserve-line" },
        },
      }}
    />,
  );
  view.getByText("At or over the 80% reserve line.");
});
