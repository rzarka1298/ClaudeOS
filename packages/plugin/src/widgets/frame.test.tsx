import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState } from "../connection-state.js";
import { connectionChangedAt, connectionState, lastEvent } from "../connection-state.js";
import type { QuickActionDescriptor, WidgetDefinition, WidgetState } from "./contract.js";
import { WidgetFrame } from "./frame.js";
import { type AnyWidgetDefinition, WIDGET_IDS, WIDGETS, type WidgetId } from "./registry.js";
import { serviceHealthState, serviceHealthWidget } from "./service-health.js";

/**
 * The tracer test for plan 03-05: one real widget, rendered through the shared
 * frame, from the live connection signals — contract → derivation → frame →
 * footer, end to end. Every other widget and every other presentation expands
 * from this proven path without an architectural change.
 *
 * Module-level signals leak across tests unless reset in BOTH hooks — the same
 * discipline `view/shell.test.tsx` already keeps.
 */

const CHANGED_AT = "2026-09-15T00:00:00.000Z";
const EVENT_AT = "2026-09-15T00:10:00.000Z";
const TWO_MINUTES_LATER = Date.parse(EVENT_AT) + 2 * 60 * 1000;

function reset(): void {
  connectionState.value = { kind: "connecting" };
  lastEvent.value = undefined;
  connectionChangedAt.value = CHANGED_AT;
}

afterEach(() => {
  cleanup();
  reset();
});

beforeEach(reset);

function renderServiceHealth(now: number) {
  return render(
    <WidgetFrame
      definition={serviceHealthWidget}
      state={serviceHealthState.value}
      connection={connectionState.value}
      size="medium"
      now={now}
    />,
  );
}

describe("WidgetFrame rendering the service-health widget", () => {
  it("renders a ready card with the live event, its relative time and a Source disclosure", () => {
    connectionState.value = { kind: "live" };
    lastEvent.value = { type: "service.heartbeat", occurredAt: EVENT_AT };

    const { container } = renderServiceHealth(TWO_MINUTES_LATER);
    const card = container.querySelector("section.ccc-card");

    expect(card).toBeTruthy();
    expect(card?.getAttribute("data-presentation")).toBe("ready");
    expect(card?.getAttribute("data-size")).toBe("medium");
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Service health");
    expect(card?.querySelector(".ccc-card-body")?.textContent).toContain("service.heartbeat");

    const time = card?.querySelector("time.ccc-footer-time");
    expect(time?.getAttribute("datetime")).toBe(EVENT_AT);
    expect(time?.textContent).toBe("2 minutes ago");

    const badge = card?.querySelector('.ccc-badge[data-badge="live"]');
    expect(badge?.textContent).toContain("Live");

    const source = screen.getByRole("button", { name: "Source" });
    expect(source.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders the connecting state as a busy skeleton with an em-dash time and a disabled Source button", () => {
    connectionState.value = { kind: "connecting" };

    const { container } = renderServiceHealth(TWO_MINUTES_LATER);
    const card = container.querySelector("section.ccc-card");

    expect(card?.getAttribute("data-presentation")).toBe("loading");
    expect(card?.getAttribute("aria-busy")).toBe("true");
    expect(card?.querySelector("time.ccc-footer-time")?.textContent).toBe("—");
    expect(card?.querySelector(".ccc-badge")).toBeNull();
    expect(screen.getByRole("button", { name: "Source" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
  });

  it("keeps the disconnected service-health card ready, because its data IS the connection", () => {
    connectionState.value = { kind: "disconnected", reason: "connect ECONNREFUSED" };

    const { container } = renderServiceHealth(TWO_MINUTES_LATER);
    const card = container.querySelector("section.ccc-card");

    // ADR-0023 "Panel state assignment": a card cannot be disconnected from the
    // fact that it is disconnected — its single data key is `local`, so the
    // D-15 transport flip never reaches it.
    expect(card?.getAttribute("data-presentation")).toBe("ready");
    expect(screen.getByText(/Service disconnected — connect ECONNREFUSED/)).toBeTruthy();
  });
});

describe("WidgetFrame ownership of the footer", () => {
  const EMPTY_BODY_WIDGET: WidgetDefinition<null> = {
    id: "test-widget",
    title: "Test widget",
    dataKeys: [{ key: "test.key", transport: "local", sourceLabel: "Test source" }],
    refresh: { kind: "manual" },
    minSize: "small",
    preferredSize: "small",
    featureFlag: "widget.test-widget",
    quickActions: [],
    renderBody: () => null,
    renderEmpty: () => null,
  };

  it("puts a tall card's scrollable body in the tab order, and no other card's", () => {
    const state: WidgetState<null> = {
      kind: "ready",
      data: null,
      observedAt: EVENT_AT,
      freshness: "live",
      partiality: { partial: false },
      isEmpty: false,
    };
    const body = (size: "small" | "tall"): Element | null =>
      render(
        <WidgetFrame
          definition={EMPTY_BODY_WIDGET}
          state={state}
          connection={{ kind: "live" }}
          size={size}
          now={TWO_MINUTES_LATER}
        />,
      ).container.querySelector(".ccc-card-body");

    // Only `tall` scrolls (`overflow-y: auto`), and a scroll container outside
    // the tab order cannot be scrolled without a mouse (A11Y-01).
    expect(body("tall")?.getAttribute("tabindex")).toBe("0");
    cleanup();
    expect(body("small")?.hasAttribute("tabindex")).toBe(false);
  });

  it("renders the footer even when a widget's body renders nothing at all", () => {
    const { container } = render(
      <WidgetFrame
        definition={EMPTY_BODY_WIDGET}
        state={{
          kind: "ready",
          data: null,
          observedAt: EVENT_AT,
          freshness: "live",
          partiality: { partial: false },
          isEmpty: false,
        }}
        connection={{ kind: "live" }}
        size="small"
        now={TWO_MINUTES_LATER}
      />,
    );

    expect(container.querySelector(".ccc-card-body")?.textContent).toBe("");
    expect(container.querySelector(".ccc-card-footer")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Source" })).toBeTruthy();
  });
});

/**
 * Every presentation's copy, verbatim from the UI-SPEC Copywriting Contract,
 * plus the A11Y-04 floor: the accessible text of the card differs across all
 * eight presentations, so no two states are distinguishable only by colour.
 */
describe("the eight presentations", () => {
  const PANEL: WidgetDefinition<string> = {
    id: "test-panel",
    title: "Test panel",
    dataKeys: [{ key: "github.discoveries", transport: "service", sourceLabel: "GitHub" }],
    refresh: { kind: "manual" },
    minSize: "small",
    preferredSize: "small",
    featureFlag: "widget.test-panel",
    quickActions: [],
    renderBody: ({ data }) => <p className="ccc-body-value">{data}</p>,
    renderEmpty: () => null,
  };

  const READY: WidgetState<string> = {
    kind: "ready",
    data: "payload",
    observedAt: EVENT_AT,
    freshness: "live",
    partiality: { partial: false },
    isEmpty: false,
  };

  function renderPanel(
    state: WidgetState<string>,
    connection: Parameters<typeof renderCard>[1] = { kind: "live" },
    onQuickAction?: (descriptor: QuickActionDescriptor) => void,
  ) {
    return renderCard(state, connection, onQuickAction);
  }

  function renderCard(
    state: WidgetState<string>,
    connection:
      | { kind: "connecting" }
      | { kind: "live" }
      | { kind: "disconnected"; reason: string },
    onQuickAction?: (descriptor: QuickActionDescriptor) => void,
  ) {
    return render(
      onQuickAction === undefined ? (
        <WidgetFrame
          definition={PANEL}
          state={state}
          connection={connection}
          size="small"
          now={TWO_MINUTES_LATER}
        />
      ) : (
        <WidgetFrame
          definition={PANEL}
          state={state}
          connection={connection}
          size="small"
          now={TWO_MINUTES_LATER}
          onQuickAction={onQuickAction}
        />
      ),
    );
  }

  function focusableCount(container: Element): number {
    return container.querySelectorAll("button, a[href], input, select, textarea, [tabindex]")
      .length;
  }

  it("loading: a busy card with three skeleton lines and a hidden Loading line", () => {
    const { container } = renderPanel({ kind: "loading" });
    const card = container.querySelector("section.ccc-card");
    expect(card?.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelectorAll(".ccc-skeleton-line")).toHaveLength(3);
    expect(container.querySelector(".ccc-visually-hidden")?.textContent).toBe("Loading test panel");
  });

  it("empty: the contract copy, a footer that stays, and no control beyond the footer's two stops", () => {
    const { container } = renderPanel({ ...READY, isEmpty: true });
    expect(screen.getByText("Nothing here yet")).toBeTruthy();
    expect(
      screen.getByText("Test panel has no items right now. New items appear as they arrive."),
    ).toBeTruthy();
    expect(container.querySelector(".ccc-card-footer")).toBeTruthy();
    // The footer's two keyboard stops and nothing else: the "last updated"
    // time (focusable so its absolute timestamp is reachable, D-16, judge-r1
    // finding 2) and the Source disclosure. An empty card offers no action.
    expect(focusableCount(container)).toBe(2);
    expect(container.querySelector(".ccc-card-footer time[tabindex='0']")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Source" })).toBeTruthy();
  });

  it("ready: the full body, the header at full ink and a Live badge", () => {
    const { container } = renderPanel(READY);
    const card = container.querySelector("section.ccc-card");
    expect(card?.getAttribute("data-presentation")).toBe("ready");
    expect(container.querySelector(".ccc-body-value")?.textContent).toBe("payload");
    expect(container.querySelector(".ccc-card-body")?.getAttribute("data-dimmed")).toBeNull();
    expect(container.querySelector(".ccc-badge")?.textContent).toContain("Live");
  });

  it("stale: the last-good values stay readable, the header mutes, the badge reads Stale", () => {
    const { container } = renderPanel({ ...READY, freshness: "stale" });
    const card = container.querySelector("section.ccc-card");
    expect(card?.getAttribute("data-presentation")).toBe("stale");
    expect(container.querySelector(".ccc-body-value")?.textContent).toBe("payload");
    expect(container.querySelector(".ccc-badge")?.textContent).toContain("Stale");
  });

  it("disconnected: both lines, a dimmed body and an Unavailable badge", () => {
    const { container } = renderPanel(READY, {
      kind: "disconnected",
      reason: "connect ECONNREFUSED",
    });
    expect(screen.getByText("Service disconnected")).toBeTruthy();
    expect(
      screen.getByText("Showing the last values received 2 minutes ago. They may be out of date."),
    ).toBeTruthy();
    expect(container.querySelector(".ccc-card-body")?.getAttribute("data-dimmed")).toBe("true");
    expect(container.querySelector(".ccc-badge")?.textContent).toContain("Unavailable");
  });

  it("error: the contract copy with a decorative glyph, and a failed source in the panel", () => {
    const { container } = renderPanel({ kind: "error", message: "HTTP 500" });
    expect(screen.getByText("Couldn't load test panel.")).toBeTruthy();
    expect(
      screen.getByText("Check the service in Settings → Diagnostics, then refresh."),
    ).toBeTruthy();
    const glyph = container.querySelector(".ccc-error-glyph");
    expect(glyph?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".ccc-badge")?.textContent).toContain("Unavailable");

    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(container.querySelector(".ccc-source-panel")?.textContent).toContain("GitHub — failed");
  });

  it("permission-required: a Connect button that precedes Source and only emits a descriptor", () => {
    const onQuickAction = vi.fn();
    const { container } = renderPanel(
      { kind: "permission-required", capability: "github", sourceLabel: "GitHub" },
      { kind: "live" },
      onQuickAction,
    );

    expect(screen.getByText("GitHub isn't connected")).toBeTruthy();
    expect(screen.getByText("Connect GitHub to see test panel here.")).toBeTruthy();

    const buttons = [...container.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).toEqual(["Connect GitHub", "Source"]);

    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));
    expect(onQuickAction).toHaveBeenCalledTimes(1);
    expect(onQuickAction).toHaveBeenCalledWith({
      id: "connect-github",
      label: "Connect GitHub",
      capability: "connect:github",
    });
  });

  it("unavailable: the no-source-yet copy and an Unavailable badge", () => {
    const { container } = renderPanel({ kind: "unavailable" });
    expect(screen.getByText("No source yet")).toBeTruthy();
    expect(
      screen.getByText(
        "Test panel has no data source in this build. It fills in once its source is available.",
      ),
    ).toBeTruthy();
    expect(container.querySelector(".ccc-badge")?.textContent).toContain("Unavailable");
  });

  it("A11Y-04: the accessible text differs across all eight presentations", () => {
    const cases: [string, WidgetState<string>, Parameters<typeof renderCard>[1]][] = [
      ["loading", { kind: "loading" }, { kind: "live" }],
      ["empty", { ...READY, isEmpty: true }, { kind: "live" }],
      ["ready", READY, { kind: "live" }],
      ["stale", { ...READY, freshness: "stale" }, { kind: "live" }],
      ["disconnected", READY, { kind: "disconnected", reason: "connect ECONNREFUSED" }],
      ["error", { kind: "error", message: "HTTP 500" }, { kind: "live" }],
      [
        "permission-required",
        { kind: "permission-required", capability: "github", sourceLabel: "GitHub" },
        { kind: "live" },
      ],
      ["unavailable", { kind: "unavailable" }, { kind: "live" }],
    ];

    const texts = cases.map(([, state, connection]) => {
      const { container, unmount } = renderCard(state, connection);
      const text = container.querySelector("section.ccc-card")?.textContent ?? "";
      unmount();
      return text;
    });

    expect(new Set(texts).size).toBe(8);
    for (const text of texts) expect(text.length).toBeGreaterThan(0);
  });
});

/**
 * Quick actions reach the card only in the two presentations where the card is
 * actually showing the owner something (UI-SPEC per-state copy: `ready` lists
 * `Source` + declared quick actions; every other state lists `Source` alone).
 *
 * The buttons emit DESCRIPTORS and do nothing else — the frame has no path to
 * an action's effect, which is what keeps `dispatchQuickAction` the single
 * choke point Phase 6's approval engine plugs into (C-11, APPR-01, T-03-13).
 */
describe("quick-action buttons in the frame (UI-04, A11Y-01)", () => {
  const RUN_SKILL: QuickActionDescriptor = {
    id: "run-skill",
    label: "Run a skill",
    capability: "skill:run",
  };
  const OPEN_DESKTOP: QuickActionDescriptor = {
    id: "open-claude-desktop",
    label: "Open Claude Desktop",
    capability: "app:open",
  };

  const ACTION_PANEL: WidgetDefinition<string> = {
    id: "action-panel",
    title: "Quick actions",
    dataKeys: [{ key: "skills.registry", transport: "service", sourceLabel: "Skill registry" }],
    refresh: { kind: "manual" },
    minSize: "small",
    preferredSize: "small",
    featureFlag: "widget.quick-actions",
    quickActions: [RUN_SKILL, OPEN_DESKTOP],
    renderBody: ({ data }) => <p className="ccc-body-value">{data}</p>,
    renderEmpty: () => null,
  };

  const READY_STATE: WidgetState<string> = {
    kind: "ready",
    data: "payload",
    observedAt: EVENT_AT,
    freshness: "live",
    partiality: { partial: false },
    isEmpty: false,
  };

  function renderActions(
    state: WidgetState<string>,
    connection: ConnectionState = { kind: "live" },
    onQuickAction: (descriptor: QuickActionDescriptor) => void = vi.fn(),
  ) {
    return render(
      <WidgetFrame
        definition={ACTION_PANEL}
        state={state}
        connection={connection}
        size="small"
        now={TWO_MINUTES_LATER}
        onQuickAction={onQuickAction}
      />,
    );
  }

  it("renders every declared action as a keyboard-reachable button in ready", () => {
    const { container } = renderActions(READY_STATE);
    const buttons = [...container.querySelectorAll("button.ccc-quick-action")];
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Run a skill",
      "Open Claude Desktop",
    ]);
    for (const button of buttons) expect(button.getAttribute("type")).toBe("button");
  });

  it("renders them in stale too, where last-good values are still on screen", () => {
    const { container } = renderActions({ ...READY_STATE, freshness: "stale" });
    expect(container.querySelectorAll("button.ccc-quick-action")).toHaveLength(2);
  });

  it("emits exactly the activated descriptor and does nothing else", () => {
    const onQuickAction = vi.fn();
    renderActions(READY_STATE, { kind: "live" }, onQuickAction);

    fireEvent.click(screen.getByRole("button", { name: "Open Claude Desktop" }));

    expect(onQuickAction).toHaveBeenCalledTimes(1);
    expect(onQuickAction).toHaveBeenCalledWith(OPEN_DESKTOP);
  });

  const LIVE: ConnectionState = { kind: "live" };
  const SILENT: [string, WidgetState<string>, ConnectionState][] = [
    ["loading", { kind: "loading" }, LIVE],
    ["empty", { ...READY_STATE, isEmpty: true }, LIVE],
    ["error", { kind: "error", message: "HTTP 500" }, LIVE],
    ["unavailable", { kind: "unavailable" }, LIVE],
    [
      "permission-required",
      { kind: "permission-required", capability: "github", sourceLabel: "GitHub" },
      LIVE,
    ],
    ["disconnected", READY_STATE, { kind: "disconnected", reason: "connect ECONNREFUSED" }],
  ];

  it.each(SILENT)("renders no quick action in %s", (_name, state, connection) => {
    const { container } = renderActions(state, connection);
    expect(container.querySelectorAll("button.ccc-quick-action")).toHaveLength(0);
  });
});

/**
 * The hero variant (UI-SPEC S1 "Contract field", D-50): a definition that
 * declares `variant: { kind: "hero", metric }` gets a frame-owned cream head
 * — one Display-step numeral, a hidden screen-reader label, a sub-caption and
 * a decorative meter — rendered between the header and the body. Nothing
 * about a non-hero widget changes (Test 4 below, and every case in "the eight
 * presentations" above).
 */
describe("hero variant (D-50, UI-SPEC S1)", () => {
  interface HeroFixtureData {
    readonly value: number;
  }

  const HERO_WIDGET: WidgetDefinition<HeroFixtureData> = {
    id: "hero-fixture",
    title: "Test hero panel",
    dataKeys: [{ key: "hero.fixture", transport: "service", sourceLabel: "Fixture" }],
    refresh: { kind: "manual" },
    minSize: "tall",
    preferredSize: "tall",
    featureFlag: "widget.hero-fixture",
    quickActions: [],
    variant: {
      kind: "hero",
      metric: (data) => ({
        value: data.value,
        caption:
          data.value === 3
            ? "1 waiting for approval · 1 unknown"
            : "0 waiting for approval · 0 unknown",
        share: data.value === 3 ? { value: 1, max: 3 } : null,
        srLabel: `${data.value} active sessions, running or waiting for approval`,
      }),
    },
    renderBody: () => <p className="ccc-hero-fixture-body">rows</p>,
    renderEmpty: () => null,
  };

  const HERO_READY: WidgetState<HeroFixtureData> = {
    kind: "ready",
    data: { value: 3 },
    observedAt: EVENT_AT,
    freshness: "live",
    partiality: { partial: false },
    isEmpty: false,
  };

  function renderHero(
    state: WidgetState<HeroFixtureData>,
    connection: ConnectionState = { kind: "live" },
  ) {
    return render(
      <WidgetFrame
        definition={HERO_WIDGET}
        state={state}
        connection={connection}
        size="tall"
        now={TWO_MINUTES_LATER}
      />,
    );
  }

  it("Test 1: renders the numeral, its hidden label, the caption and a backed meter", () => {
    const { container } = renderHero(HERO_READY);
    const card = container.querySelector("section.ccc-card");
    expect(card?.getAttribute("data-variant")).toBe("hero");
    expect(card?.getAttribute("data-surface")).toBe("cream");

    const numeral = container.querySelector(".ccc-hero-head .ccc-kpi-number");
    expect(numeral?.textContent).toBe("3");
    expect(numeral?.nextElementSibling?.classList.contains("ccc-visually-hidden")).toBe(true);
    expect(numeral?.nextElementSibling?.textContent).toBe(
      "3 active sessions, running or waiting for approval",
    );
    expect(screen.getByText("1 waiting for approval · 1 unknown")).toBeTruthy();

    const meter = container.querySelector(".ccc-hero-head meter.ccc-hero-meter");
    expect(meter?.getAttribute("min")).toBe("0");
    expect(meter?.getAttribute("max")).toBe("3");
    expect(meter?.getAttribute("value")).toBe("1");
    expect(meter?.getAttribute("aria-hidden")).toBe("true");
  });

  it("Test 2: renders no meter at all when share is null", () => {
    const { container } = renderHero({ ...HERO_READY, data: { value: 0 } });
    expect(screen.getByText("0 waiting for approval · 0 unknown")).toBeTruthy();
    expect(container.querySelector(".ccc-hero-meter")).toBeNull();
  });

  it.each([
    ["loading", { kind: "loading" }, { kind: "live" } as const, "cream"],
    ["ready", HERO_READY, { kind: "live" } as const, "cream"],
    ["empty", { ...HERO_READY, isEmpty: true }, { kind: "live" } as const, "cream"],
    ["stale", { ...HERO_READY, freshness: "stale" }, { kind: "live" } as const, "cream"],
    [
      "disconnected",
      HERO_READY,
      { kind: "disconnected", reason: "connect ECONNREFUSED" } as const,
      "glass",
    ],
    ["error", { kind: "error", message: "boom" }, { kind: "live" } as const, "glass"],
    [
      "permission-required",
      { kind: "permission-required", capability: "claude-hooks", sourceLabel: "Claude Code hooks" },
      { kind: "live" } as const,
      "glass",
    ],
    ["unavailable", { kind: "unavailable" }, { kind: "live" } as const, "glass"],
  ] as const)(
    "Test 3: the %s presentation resolves to the %s surface",
    (_name, state, connection, surface) => {
      const { container } = renderHero(state, connection);
      expect(container.querySelector("section.ccc-card")?.getAttribute("data-surface")).toBe(
        surface,
      );
    },
  );

  it("Test 3: loading renders exactly three skeleton lines inside the hero head, with the panel's hidden loading text", () => {
    const { container } = renderHero({ kind: "loading" });
    const head = container.querySelector(".ccc-hero-head");
    expect(head?.querySelectorAll(".ccc-skeleton-line")).toHaveLength(3);
    expect(head?.querySelector(".ccc-visually-hidden")?.textContent).toBe(
      "Loading test hero panel",
    );
    // Not duplicated: the generic body loading branch does not also render a skeleton.
    expect(container.querySelectorAll(".ccc-skeleton-line")).toHaveLength(3);
  });

  it("Test 4: a definition without a variant renders no data-variant or data-surface attribute", () => {
    const { container } = render(
      <WidgetFrame
        definition={
          {
            id: "no-variant-fixture",
            title: "No variant fixture",
            dataKeys: [{ key: "test.key", transport: "local", sourceLabel: "Test source" }],
            refresh: { kind: "manual" },
            minSize: "small",
            preferredSize: "small",
            featureFlag: "widget.no-variant-fixture",
            quickActions: [],
            renderBody: () => null,
            renderEmpty: () => null,
          } satisfies WidgetDefinition<null>
        }
        state={{
          kind: "ready",
          data: null,
          observedAt: EVENT_AT,
          freshness: "live",
          partiality: { partial: false },
          isEmpty: false,
        }}
        connection={{ kind: "live" }}
        size="small"
        now={TWO_MINUTES_LATER}
      />,
    );
    const card = container.querySelector("section.ccc-card");
    expect(card?.hasAttribute("data-variant")).toBe(false);
    expect(card?.hasAttribute("data-surface")).toBe(false);
  });

  it("Test 4 (Task 3): every rendered meter has its value and max backed by digits in nearby text", () => {
    const { container } = renderHero(HERO_READY);
    const head = container.querySelector(".ccc-hero-head");
    const meter = head?.querySelector("meter.ccc-hero-meter");
    expect(meter).toBeTruthy();
    const value = meter?.getAttribute("value");
    const max = meter?.getAttribute("max");
    expect(value).not.toBeNull();
    expect(max).not.toBeNull();
    const headText = head?.textContent ?? "";
    // The numeral (.ccc-kpi-number) carries the meter's max, and the caption
    // carries its value — the meter is decorative precisely because these
    // digits already appear as real text (UI-SPEC "the meter is decorative
    // because the sub-caption states the same numbers in text").
    expect(head?.querySelector(".ccc-kpi-number")?.textContent).toBe(max);
    expect(headText).toContain(String(value));
  });
});

/**
 * Setup-state copy, the unavailable reason, and the body quick-action
 * channel (UI-SPEC "Setup state: hooks not installed (D-53)", "Telemetry
 * shape changed (SESS-18, D-12)", 04-PATTERNS `onQuickAction` body channel).
 */
describe("setup-state copy, unavailable reason and body quick-action (D-53, SESS-18)", () => {
  const COPY_PANEL: WidgetDefinition<string> = {
    id: "copy-panel",
    title: "Copy panel",
    dataKeys: [{ key: "test.key", transport: "service", sourceLabel: "Test source" }],
    refresh: { kind: "manual" },
    minSize: "small",
    preferredSize: "small",
    featureFlag: "widget.copy-panel",
    quickActions: [],
    renderBody: () => null,
    renderEmpty: () => null,
  };

  it("Test 1: the claude-hooks permission-required card uses the per-capability setup copy and descriptor", () => {
    const onQuickAction = vi.fn();
    render(
      <WidgetFrame
        definition={COPY_PANEL}
        state={{
          kind: "permission-required",
          capability: "claude-hooks",
          sourceLabel: "Claude Code hooks",
        }}
        connection={{ kind: "live" }}
        size="small"
        now={TWO_MINUTES_LATER}
        onQuickAction={onQuickAction}
      />,
    );

    expect(screen.getByText("Claude Code hooks aren't installed")).toBeTruthy();
    expect(
      screen.getByText(
        "Install the optional hook package to see your Claude Code sessions here. Obsidian settings → Claude command center → Claude shows the command to run.",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Set up Claude hooks" }));
    expect(onQuickAction).toHaveBeenCalledTimes(1);
    expect(onQuickAction).toHaveBeenCalledWith({
      id: "connect-claude-hooks",
      label: "Connect Claude Code hooks",
      capability: "connect:claude-hooks",
    });
  });

  it("Test 2: every other capability keeps the unchanged Phase 3 template", () => {
    render(
      <WidgetFrame
        definition={COPY_PANEL}
        state={{ kind: "permission-required", capability: "github", sourceLabel: "GitHub" }}
        connection={{ kind: "live" }}
        size="small"
        now={TWO_MINUTES_LATER}
      />,
    );
    expect(screen.getByText("GitHub isn't connected")).toBeTruthy();
    expect(screen.getByText("Connect GitHub to see copy panel here.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect GitHub" })).toBeTruthy();
  });

  it("Test 3: a session-telemetry-changed reason reads Session tracking paused plus plugin-owned copy", () => {
    render(
      <WidgetFrame
        definition={COPY_PANEL}
        state={{
          kind: "unavailable",
          reason: { code: "session-telemetry-changed", version: "2.1.300" },
        }}
        connection={{ kind: "live" }}
        size="small"
        now={TWO_MINUTES_LATER}
      />,
    );
    expect(screen.getByText("Session tracking paused")).toBeTruthy();
    expect(
      screen.getByText(
        "Claude Code 2.1.300 reports sessions in a format this build doesn't recognise, so they're hidden rather than shown wrong.",
      ),
    ).toBeTruthy();
  });

  it("Test 3: a claude-version-unsupported reason reads Session tracking paused plus the floor copy", () => {
    render(
      <WidgetFrame
        definition={COPY_PANEL}
        state={{
          kind: "unavailable",
          reason: { code: "claude-version-unsupported", version: "2.1.100" },
        }}
        connection={{ kind: "live" }}
        size="small"
        now={TWO_MINUTES_LATER}
      />,
    );
    expect(screen.getByText("Session tracking paused")).toBeTruthy();
    expect(
      screen.getByText("Claude Code 2.1.100 is older than the minimum supported 2.1.214."),
    ).toBeTruthy();
  });

  it("Test 3: a version that is not version-shaped is never rendered", () => {
    const smuggled = "2.1.300 /Users/USERNAME/secret";
    const { container } = render(
      <WidgetFrame
        definition={COPY_PANEL}
        state={{
          kind: "unavailable",
          reason: { code: "session-telemetry-changed", version: smuggled },
        }}
        connection={{ kind: "live" }}
        size="small"
        now={TWO_MINUTES_LATER}
      />,
    );
    expect(container.textContent).not.toContain("/Users");
    expect(
      screen.getByText(
        "Your Claude Code version reports sessions in a format this build doesn't recognise, so they're hidden rather than shown wrong.",
      ),
    ).toBeTruthy();
  });

  it("Test 3: a free-string or unknown-code reason is never rendered verbatim and never says Session tracking paused", () => {
    const free = "connect ECONNREFUSED /Users/USERNAME/.ccc/service.sock";
    for (const reason of [free, { code: "some-future-code", version: "1.0.0" }]) {
      const { container, unmount } = render(
        <WidgetFrame
          definition={COPY_PANEL}
          // An erased widget's state is unvalidated at runtime (FrameState),
          // so the frame must survive a reason the type does not allow.
          state={{ kind: "unavailable", reason } as unknown as WidgetState<string>}
          connection={{ kind: "live" }}
          size="small"
          now={TWO_MINUTES_LATER}
        />,
      );
      expect(container.textContent).not.toContain("ECONNREFUSED");
      expect(container.textContent).not.toContain("Session tracking paused");
      expect(screen.getByText("No source yet")).toBeTruthy();
      unmount();
    }
  });

  it("Test 3: an unavailable state without a reason keeps the unchanged 'No source yet' copy", () => {
    render(
      <WidgetFrame
        definition={COPY_PANEL}
        state={{ kind: "unavailable" }}
        connection={{ kind: "live" }}
        size="small"
        now={TWO_MINUTES_LATER}
      />,
    );
    expect(screen.getByText("No source yet")).toBeTruthy();
  });

  const ROW_ACTION: QuickActionDescriptor = {
    id: "row-action",
    label: "Focus",
    capability: "session:focus",
    target: { runId: "run-1" },
  };

  function CapturingBody({
    onQuickAction,
  }: {
    readonly onQuickAction?: ((d: QuickActionDescriptor) => void) | undefined;
  }) {
    return (
      <button
        type="button"
        className="ccc-capturing-body-button"
        onClick={() => onQuickAction?.(ROW_ACTION)}
      >
        emit
      </button>
    );
  }

  const BODY_WIDGET: WidgetDefinition<string> = {
    id: "body-quick-action-fixture",
    title: "Body quick action fixture",
    dataKeys: [{ key: "test.key", transport: "service", sourceLabel: "Test source" }],
    refresh: { kind: "manual" },
    minSize: "small",
    preferredSize: "small",
    featureFlag: "widget.body-quick-action-fixture",
    quickActions: [],
    renderBody: CapturingBody,
    renderEmpty: () => null,
  };

  const BODY_READY: WidgetState<string> = {
    kind: "ready",
    data: "x",
    observedAt: EVENT_AT,
    freshness: "live",
    partiality: { partial: false },
    isEmpty: false,
  };

  it("Test 4: the frame threads onQuickAction into the body in ready, stale and disconnected, and calls nothing else itself", () => {
    const onQuickAction = vi.fn();
    const { rerender } = render(
      <WidgetFrame
        definition={BODY_WIDGET}
        state={BODY_READY}
        connection={{ kind: "live" }}
        size="small"
        now={TWO_MINUTES_LATER}
        onQuickAction={onQuickAction}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "emit" }));
    expect(onQuickAction).toHaveBeenCalledTimes(1);
    expect(onQuickAction).toHaveBeenCalledWith(ROW_ACTION);
    onQuickAction.mockClear();

    rerender(
      <WidgetFrame
        definition={BODY_WIDGET}
        state={{ ...BODY_READY, freshness: "stale" }}
        connection={{ kind: "live" }}
        size="small"
        now={TWO_MINUTES_LATER}
        onQuickAction={onQuickAction}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "emit" }));
    expect(onQuickAction).toHaveBeenCalledTimes(1);
    expect(onQuickAction).toHaveBeenCalledWith(ROW_ACTION);
    onQuickAction.mockClear();

    rerender(
      <WidgetFrame
        definition={BODY_WIDGET}
        state={BODY_READY}
        connection={{ kind: "disconnected", reason: "connect ECONNREFUSED" }}
        size="small"
        now={TWO_MINUTES_LATER}
        onQuickAction={onQuickAction}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "emit" }));
    expect(onQuickAction).toHaveBeenCalledTimes(1);
    expect(onQuickAction).toHaveBeenCalledWith(ROW_ACTION);
  });
});

// ---------------------------------------------------------------------------
// `{panel}` mid-sentence keeps proper nouns (UI-SPEC Copywriting Contract:
// sentence case, "Proper nouns keep their capitals"). Wave-6 finding:
// `lowerFirst` rendered "Loading gitHub discoveries".
// ---------------------------------------------------------------------------

describe("a panel title used mid-sentence keeps its proper nouns", () => {
  const MID_SENTENCE: Record<WidgetId, string> = {
    "service-health": "service health",
    today: "today",
    "active-sessions": "active Claude sessions",
    "project-shortcuts": "project shortcuts",
    "claude-usage": "Claude usage",
    "tech-intel": "technology and market intelligence",
    "github-discoveries": "GitHub discoveries",
    "quick-actions": "quick actions",
  };

  it("covers every registered widget", () => {
    expect(Object.keys(MID_SENTENCE).sort()).toEqual([...WIDGET_IDS].sort());
  });

  it.each(WIDGET_IDS)("%s reads correctly in the loading and error copy", (id) => {
    const definition: AnyWidgetDefinition = WIDGETS[id];
    const panel = MID_SENTENCE[id];

    const loading = render(
      <WidgetFrame
        definition={definition}
        state={{ kind: "loading" }}
        connection={{ kind: "live" }}
        now={TWO_MINUTES_LATER}
      />,
    );
    expect(
      loading.container.querySelector(".ccc-card-body .ccc-visually-hidden")?.textContent,
    ).toBe(`Loading ${panel}`);
    cleanup();

    render(
      <WidgetFrame
        definition={definition}
        state={{ kind: "error", message: "boom" }}
        connection={{ kind: "live" }}
        now={TWO_MINUTES_LATER}
      />,
    );
    expect(screen.getByText(`Couldn't load ${panel}.`)).toBeTruthy();
    expect(screen.getByText(`Sources for ${panel}`)).toBeTruthy();
  });
});
