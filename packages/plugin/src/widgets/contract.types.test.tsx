import { cleanup, render } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import type { WidgetDefinition, WidgetState } from "./contract.js";
import { WidgetFrame } from "./frame.js";
import { type ProjectShortcutsData, projectShortcutsWidget } from "./panels.js";
import { type AnyWidgetDefinition, WIDGETS } from "./registry.js";

/**
 * The registry's payload is no longer erased to `any` (wave-5 review MINOR,
 * `registry.ts` deviation 1). These are TYPE tests: `tsc -b` (ci:typecheck)
 * fails if any `@ts-expect-error` below stops being an error, so each line is
 * a claim the compiler re-proves on every build.
 */

const OBSERVED = "2026-09-25T11:58:00Z";
const LIVE = { kind: "live" } as const;

const WRONG_READY = {
  kind: "ready",
  data: { projects: "not a list" },
  observedAt: OBSERVED,
  freshness: "cached",
  partiality: { partial: false },
  isEmpty: false,
} as const;

const RIGHT_READY: WidgetState<ProjectShortcutsData> = {
  kind: "ready",
  data: {
    projects: [
      {
        id: "p",
        name: "Example project",
        pinned: true,
        branch: "main",
        dirty: false,
        openItems: 2,
        sessionCount: null,
        nextTask: null,
      },
    ],
  },
  observedAt: OBSERVED,
  freshness: "cached",
  partiality: { partial: false },
  isEmpty: false,
};

/** Compile-time claims only — never called. */
export function payloadTypeClaims(erased: AnyWidgetDefinition): void {
  // @ts-expect-error an erased body accepts no payload; it is reached only through its frame
  erased.renderBody({ data: { projects: "not a list" }, size: "wide" });

  // @ts-expect-error an erased definition cannot be passed off as a typed one
  const typed: WidgetDefinition<ProjectShortcutsData> = erased;
  void typed;

  const wrong = {
    definition: projectShortcutsWidget,
    state: WRONG_READY,
    connection: LIVE,
    now: 0,
  };
  // @ts-expect-error a typed definition refuses a wrong-shaped ready payload
  WidgetFrame(wrong);

  // Every registered definition is still an AnyWidgetDefinition.
  const registered: readonly AnyWidgetDefinition[] = Object.values(WIDGETS);
  void registered;
}

afterEach(cleanup);

describe("a typed definition renders a payload of its own shape", () => {
  it("renders the project through the shared frame", () => {
    const { container } = render(
      <WidgetFrame
        definition={projectShortcutsWidget}
        state={RIGHT_READY}
        connection={LIVE}
        now={Date.parse(OBSERVED)}
      />,
    );
    expect(container.querySelector(".ccc-card-body")?.textContent).toContain("Example project");
    expect(payloadTypeClaims).toBeTypeOf("function");
  });
});
