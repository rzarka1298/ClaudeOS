import { describe, expect, it } from "vitest";
import type { ConnectionState } from "../connection-state.js";
import type { DataDependencyKey, WidgetState } from "./contract.js";
import type { CardPresentation } from "./presentation.js";
import { resolveCardPresentation } from "./presentation.js";

/**
 * The derivation table, row by row (UI-05).
 *
 * Every visual state a card can take is decided here and nowhere else, so this
 * file is where the precedence is PINNED rather than described: a future edit
 * that reorders two branches has to come back and change a named row.
 */

const SERVICE_KEY: DataDependencyKey = {
  key: "github.discoveries",
  transport: "service",
  sourceLabel: "GitHub",
};
const LOCAL_KEY: DataDependencyKey = {
  key: "service.event-stream",
  transport: "local",
  sourceLabel: "Companion service event stream",
};

const LIVE: ConnectionState = { kind: "live" };
const DOWN: ConnectionState = { kind: "disconnected", reason: "connect ECONNREFUSED" };

const OBSERVED_AT = "2026-09-15T00:10:00.000Z";

function ready(
  overrides: Partial<Extract<WidgetState<string>, { kind: "ready" }>> = {},
): WidgetState<string> {
  return {
    kind: "ready",
    data: "payload",
    observedAt: OBSERVED_AT,
    freshness: "live",
    partiality: { partial: false },
    isEmpty: false,
    ...overrides,
  };
}

interface Row {
  readonly name: string;
  readonly state: WidgetState<string>;
  readonly connection: ConnectionState;
  readonly keys: readonly DataDependencyKey[];
  readonly expected: CardPresentation["kind"];
  readonly check?: (presentation: CardPresentation) => void;
}

const ROWS: readonly Row[] = [
  {
    name: "loading resolves loading",
    state: { kind: "loading" },
    connection: LIVE,
    keys: [SERVICE_KEY],
    expected: "loading",
  },
  {
    name: "permission-required carries its capability and source label",
    state: { kind: "permission-required", capability: "github", sourceLabel: "GitHub" },
    connection: LIVE,
    keys: [SERVICE_KEY],
    expected: "permission-required",
    check: (presentation) => {
      if (presentation.kind !== "permission-required") throw new Error("wrong kind");
      expect(presentation.capability).toBe("github");
      expect(presentation.sourceLabel).toBe("GitHub");
      expect(presentation.footer.sources).toEqual([{ label: "GitHub", status: "not-connected" }]);
    },
  },
  {
    name: "error resolves error with an unavailable footer naming the failed key",
    state: { kind: "error", message: "HTTP 500" },
    connection: LIVE,
    keys: [SERVICE_KEY],
    expected: "error",
    check: (presentation) => {
      if (presentation.kind !== "error") throw new Error("wrong kind");
      expect(presentation.footer.freshness).toBe("unavailable");
      expect(presentation.footer.sources).toEqual([{ label: "GitHub", status: "failed" }]);
    },
  },
  {
    name: "unavailable resolves unavailable with a no-source footer",
    state: { kind: "unavailable" },
    connection: LIVE,
    keys: [SERVICE_KEY],
    expected: "unavailable",
    check: (presentation) => {
      if (presentation.kind !== "unavailable") throw new Error("wrong kind");
      expect(presentation.footer.freshness).toBe("unavailable");
      expect(presentation.footer.sources).toEqual([{ label: "GitHub", status: "no-source" }]);
      expect(presentation.reason).toBeUndefined();
    },
  },
  {
    name: "unavailable with a reason (SESS-18, D-12) carries that reason code through unchanged",
    state: {
      kind: "unavailable",
      reason: { code: "session-telemetry-changed", version: "2.1.300" },
    },
    connection: LIVE,
    keys: [SERVICE_KEY],
    expected: "unavailable",
    check: (presentation) => {
      if (presentation.kind !== "unavailable") throw new Error("wrong kind");
      expect(presentation.reason).toEqual({
        code: "session-telemetry-changed",
        version: "2.1.300",
      });
    },
  },
  {
    name: "ready over a service key resolves disconnected when the transport is down",
    state: ready(),
    connection: DOWN,
    keys: [SERVICE_KEY],
    expected: "disconnected",
    check: (presentation) => {
      if (presentation.kind !== "disconnected") throw new Error("wrong kind");
      expect(presentation.reason).toBe("connect ECONNREFUSED");
      expect(presentation.lastGood?.observedAt).toBe(OBSERVED_AT);
      expect(presentation.lastGood?.freshness).toBe("unavailable");
    },
  },
  {
    name: "ready over a local key stays ready when the transport is down",
    state: ready(),
    connection: DOWN,
    keys: [LOCAL_KEY],
    expected: "ready",
  },
  {
    name: "ready whose freshness is unavailable resolves error",
    state: ready({ freshness: "unavailable" }),
    connection: LIVE,
    keys: [SERVICE_KEY],
    expected: "error",
  },
  {
    name: "ready and empty resolves empty",
    state: ready({ isEmpty: true }),
    connection: LIVE,
    keys: [SERVICE_KEY],
    expected: "empty",
  },
  {
    name: "ready, empty and stale resolves empty while the footer keeps the stale badge",
    state: ready({ isEmpty: true, freshness: "stale" }),
    connection: LIVE,
    keys: [SERVICE_KEY],
    expected: "empty",
    check: (presentation) => {
      if (presentation.kind !== "empty") throw new Error("wrong kind");
      expect(presentation.footer.freshness).toBe("stale");
    },
  },
  {
    name: "ready and stale resolves stale",
    state: ready({ freshness: "stale" }),
    connection: LIVE,
    keys: [SERVICE_KEY],
    expected: "stale",
  },
  {
    name: "ready and live resolves ready",
    state: ready(),
    connection: LIVE,
    keys: [SERVICE_KEY],
    expected: "ready",
  },
  {
    name: "ready and cached resolves ready",
    state: ready({ freshness: "cached" }),
    connection: LIVE,
    keys: [SERVICE_KEY],
    expected: "ready",
  },
];

describe("resolveCardPresentation matrix", () => {
  it.each(ROWS)("$name", ({ state, connection, keys, expected, check }) => {
    const presentation = resolveCardPresentation(state, connection, keys);
    expect(presentation.kind).toBe(expected);
    check?.(presentation);
  });
});

describe("precedence (UI-05 ordering edge)", () => {
  it("resolves error before disconnected — a terminal failure outranks the transport", () => {
    const presentation = resolveCardPresentation({ kind: "error", message: "HTTP 500" }, DOWN, [
      SERVICE_KEY,
    ]);
    expect(presentation.kind).toBe("error");
  });

  it("resolves permission-required before error and before disconnected", () => {
    const presentation = resolveCardPresentation(
      { kind: "permission-required", capability: "github", sourceLabel: "GitHub" },
      DOWN,
      [SERVICE_KEY],
    );
    expect(presentation.kind).toBe("permission-required");
  });
});

describe("the disconnect invariant (roadmap success criterion 3, T-03-05)", () => {
  it("never resolves ready or stale for a service-keyed widget while the connection is disconnected", () => {
    const freshnesses = ["live", "cached", "stale", "unavailable"] as const;
    const states: WidgetState<string>[] = [
      { kind: "loading" },
      { kind: "permission-required", capability: "github", sourceLabel: "GitHub" },
      { kind: "error", message: "HTTP 500" },
      { kind: "unavailable" },
    ];
    for (const freshness of freshnesses) {
      for (const isEmpty of [true, false]) {
        states.push(ready({ freshness, isEmpty }));
      }
    }

    for (const state of states) {
      const presentation = resolveCardPresentation(state, DOWN, [SERVICE_KEY, LOCAL_KEY]);
      expect(
        presentation.kind,
        `${state.kind} resolved ${presentation.kind} while disconnected`,
      ).not.toBe("ready");
      expect(presentation.kind).not.toBe("stale");
    }
  });
});

describe("footer sources", () => {
  it("reports a named missing source as missing and every other declared key as ok", () => {
    const presentation = resolveCardPresentation(
      ready({ partiality: { partial: true, missingSources: ["GitHub"] } }),
      LIVE,
      [SERVICE_KEY, LOCAL_KEY],
    );
    if (presentation.kind !== "ready") throw new Error("wrong kind");
    expect(presentation.footer.sources).toEqual([
      { label: "GitHub", status: "missing" },
      { label: "Companion service event stream", status: "ok" },
    ]);
  });

  it("reports every service-keyed source as disconnected while the transport is down", () => {
    const presentation = resolveCardPresentation(ready(), DOWN, [SERVICE_KEY, LOCAL_KEY]);
    if (presentation.kind !== "disconnected") throw new Error("wrong kind");
    expect(presentation.lastGood?.sources).toEqual([
      { label: "GitHub", status: "disconnected" },
      { label: "Companion service event stream", status: "ok" },
    ]);
  });
});
