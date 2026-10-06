import { cleanup, render } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import type { ConnectionState } from "../connection-state.js";
import type { WidgetDefinition, WidgetState } from "./contract.js";
import { WidgetFrame } from "./frame.js";

/**
 * Audit (05-02 truths 1-2): the hero card root never carries an inline
 * style in any presentation, and the body still renders only its rows
 * beneath the frame-owned head.
 */

afterEach(cleanup);

const AT = "2026-09-15T00:10:00.000Z";
const NOW = Date.parse(AT) + 60_000;

const HERO: WidgetDefinition<{ readonly value: number }> = {
  id: "hero-audit",
  title: "Hero audit",
  dataKeys: [{ key: "hero.audit", transport: "service", sourceLabel: "Fixture" }],
  refresh: { kind: "manual" },
  minSize: "tall",
  preferredSize: "tall",
  featureFlag: "widget.hero-audit",
  quickActions: [],
  variant: {
    kind: "hero",
    metric: (data) => ({
      value: data.value,
      caption: `${data.value} running · 0 waiting for approval`,
      share: { value: data.value, max: 4 },
      srLabel: `${data.value} active sessions`,
    }),
  },
  renderBody: () => <p className="ccc-audit-row">row</p>,
  renderEmpty: () => null,
};

const READY: WidgetState<{ readonly value: number }> = {
  kind: "ready",
  data: { value: 2 },
  observedAt: AT,
  freshness: "live",
  partiality: { partial: false },
  isEmpty: false,
};

const LIVE: ConnectionState = { kind: "live" };

const CASES: readonly [string, WidgetState<{ readonly value: number }>, ConnectionState][] = [
  ["loading", { kind: "loading" }, LIVE],
  ["ready", READY, LIVE],
  ["empty", { ...READY, isEmpty: true }, LIVE],
  ["stale", { ...READY, freshness: "stale" }, LIVE],
  ["disconnected", READY, { kind: "disconnected", reason: "down" }],
  ["error", { kind: "error", message: "boom" }, LIVE],
  [
    "permission-required",
    { kind: "permission-required", capability: "claude-hooks", sourceLabel: "Claude Code hooks" },
    LIVE,
  ],
  ["unavailable", { kind: "unavailable" }, LIVE],
];

describe("hero card root (audit)", () => {
  it.each(CASES)(
    "%s: data-variant is hero and no element carries an inline style",
    (_n, state, connection) => {
      const { container } = render(
        <WidgetFrame
          definition={HERO}
          state={state}
          connection={connection}
          size="tall"
          now={NOW}
        />,
      );
      const card = container.querySelector("section.ccc-card");
      expect(card?.getAttribute("data-variant")).toBe("hero");
      expect(card?.hasAttribute("style")).toBe(false);
      expect(container.querySelectorAll("[style]")).toHaveLength(0);
    },
  );

  it("ready: the body renders its rows outside the hero head, and the head holds no row", () => {
    const { container } = render(
      <WidgetFrame definition={HERO} state={READY} connection={LIVE} size="tall" now={NOW} />,
    );
    const head = container.querySelector(".ccc-hero-head");
    expect(head).toBeTruthy();
    expect(head?.querySelector(".ccc-audit-row")).toBeNull();
    expect(container.querySelectorAll(".ccc-audit-row")).toHaveLength(1);
    expect(container.querySelectorAll(".ccc-kpi-number")).toHaveLength(1);
  });
});
