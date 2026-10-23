/**
 * The Diagnostics cells of the visual harness (plan 08-21; Phase 8 UI-SPEC S3 and S4, "Contrast
 * pages" and "Visual regression and fixtures").
 *
 *   index.html?view=diagnostics&case=diagnostics-mixed&width=full&host=light
 *
 * Every cell mounts the REAL `SettingsDestination` on its Diagnostics section, so the frame, the
 * `DiagnosticsSection`, the `DiagnosticBundleBlock` and the destination's one status line are the
 * shipped ones. Only what the section reads from outside is fixtured: the health holder is
 * configured with a resolving, never-resolving or rejecting `get` over the synthetic answers in
 * `diagnostics-fixtures.json`, the connection is set, and `now` is a frozen instant (the stale cell
 * moves it past the five-minute line). The bundle is built by the real builder from those answers and
 * checked by the real verifier; the refusal cell swaps in a verifier that always refuses, because the
 * builder alone can never produce a refusal.
 *
 * The bundle export port stays unconfigured, so `Save bundle` reads as unavailable and nothing can
 * be written, and `health/wiring.ts` is not in this graph (08-16).
 *
 * PRIVACY (PRIV-04 layer 1, T-03-03, T-08-52). This module may import exactly three modules:
 * `preact`, `@ccc/plugin` and the synthetic `diagnostics-fixtures.json`, plus the sibling
 * `settings-cells.tsx` (itself held to the same three). `src/harness-purity.test.ts` enforces it.
 */

import type { ConnectionState, SettingsHost, VerifyAndSerialise } from "@ccc/plugin";
import { DiagnosticBundleBlock, DiagnosticsSection, SECTION_VIEWS } from "@ccc/plugin";
import type { VNode } from "preact";
import fixtureFile from "./diagnostics-fixtures.json";
import {
  contentBusy,
  contentText,
  DISCONNECTED,
  fixtureHost,
  HarnessError,
  type HealthBehaviour,
  installSettingsHolders,
  isWidth,
  LIVE,
  type Press,
  type SETTINGS_FIXTURES,
  SettingsFrame,
  startReady,
} from "./settings-cells";

type HealthAnswer = typeof SETTINGS_FIXTURES.health;

interface FixtureFile {
  readonly now: string;
  readonly staleNow: string;
  readonly responses: Readonly<Record<string, HealthAnswer>>;
}

const FIXTURES = fixtureFile as unknown as FixtureFile;

interface DiagnosticsCaseSpec {
  /** The named health answer the holder resolves with. */
  readonly answer: "fresh" | "mixed" | "ok";
  readonly behaviour: HealthBehaviour;
  readonly connection: ConnectionState;
  /** The clock the section reads: `now`, or the later instant that makes every answer stale. */
  readonly at: "now" | "staleNow";
  readonly presses?: readonly Press[];
  /** Swaps in a verifier that always refuses (the refusal cell). */
  readonly refuse?: boolean;
  /** Text that must be inside the section before the cell is ready. */
  readonly expect: readonly string[];
  /** Whether the section is meant to be busy (loading) when the cell is ready. */
  readonly busy?: boolean;
}

const SHOW_PREVIEW: Press = { button: "Show bundle preview" };

const CASES: Readonly<Record<string, DiagnosticsCaseSpec>> = {
  "diagnostics-fresh": {
    answer: "fresh",
    behaviour: "answer",
    connection: LIVE,
    at: "now",
    expect: ["Run checks again", "Needs setup", "Not part of this version"],
  },
  "diagnostics-mixed": {
    answer: "mixed",
    behaviour: "answer",
    connection: LIVE,
    at: "now",
    expect: ["Degraded", "Failing", "Codex hooks"],
  },
  "diagnostics-disconnected": {
    answer: "fresh",
    behaviour: "answer",
    connection: DISCONNECTED,
    at: "now",
    expect: ["Failing", "Can't be checked while"],
  },
  "diagnostics-loading": {
    answer: "fresh",
    behaviour: "loading",
    connection: LIVE,
    at: "now",
    expect: ["Subsystems"],
    busy: true,
  },
  "diagnostics-error": {
    answer: "fresh",
    behaviour: "error",
    connection: LIVE,
    at: "now",
    expect: ["Couldn't run the checks"],
  },
  "diagnostics-stale": {
    answer: "ok",
    behaviour: "answer",
    connection: LIVE,
    at: "staleNow",
    expect: ["Stale"],
  },
  "diagnostics-bundle": {
    answer: "ok",
    behaviour: "answer",
    connection: LIVE,
    at: "now",
    presses: [SHOW_PREVIEW],
    expect: ["Copy bundle", "Save bundle", "bundleVersion"],
  },
  "diagnostics-bundle-refused": {
    answer: "ok",
    behaviour: "answer",
    connection: LIVE,
    at: "now",
    presses: [SHOW_PREVIEW],
    refuse: true,
    expect: ["Bundle not offered", "refused by a privacy check"],
  },
  "diagnostics-bundle-service-away": {
    answer: "ok",
    behaviour: "answer",
    connection: DISCONNECTED,
    at: "now",
    presses: [SHOW_PREVIEW],
    expect: ["Copy bundle", "bundleVersion", "isn't running, so service versions"],
  },
};

/** A verifier that refuses every bundle for one closed reason (never a matched value). */
const REFUSE: VerifyAndSerialise = () => ({ ok: false, rule: "home-path" });

let refusalInstalled = false;

/** Mounts the bundle block with the forcing verifier in place of the shipped Diagnostics view. */
function installRefusingView(): void {
  if (refusalInstalled) return;
  refusalInstalled = true;
  SECTION_VIEWS.diagnostics = ({ host, connection, now, notify }) => (
    <DiagnosticsSection host={host} connection={connection} now={now} notify={notify}>
      <DiagnosticBundleBlock
        host={host}
        connection={connection}
        now={now}
        notify={notify}
        verify={REFUSE}
      />
    </DiagnosticsSection>
  );
}

/** The `view` value this module owns; `main.tsx` delegates exactly this. */
export function isDiagnosticsView(view: string): boolean {
  return view === "diagnostics";
}

/**
 * Renders one Diagnostics cell from the page's query parameters: `case` (`diagnostics-<state>`),
 * `width` (narrow or full) and `nav=1` for the tab strip. `motion` is validated and applied by the
 * harness entry before it delegates here.
 */
export function DiagnosticsCell({ params }: { readonly params: URLSearchParams }): VNode {
  const caseId = params.get("case") ?? "";
  const width = params.get("width") ?? "full";
  if (!isWidth(width)) {
    return <HarnessError message={`Unknown width "${width}" - expected narrow or full.`} />;
  }
  const spec = CASES[caseId];
  if (spec === undefined) {
    return <HarnessError message={`Unknown diagnostics case "${caseId}".`} />;
  }
  const answer = FIXTURES.responses[spec.answer];
  if (answer === undefined) {
    return <HarnessError message={`No health answer "${spec.answer}".`} />;
  }
  installSettingsHolders(spec.behaviour, answer);
  if (spec.refuse === true) installRefusingView();
  const host: SettingsHost = fixtureHost();
  startReady({
    ...(spec.presses === undefined ? {} : { presses: spec.presses }),
    done: () => {
      const text = contentText();
      if (!spec.expect.every((wanted) => text.includes(wanted))) return false;
      // A loading cell is ready while it is busy; every other cell only once nothing is.
      return spec.busy === true ? true : !contentBusy();
    },
  });
  return (
    <SettingsFrame
      section="diagnostics"
      width={width}
      connection={spec.connection}
      now={Date.parse(spec.at === "now" ? FIXTURES.now : FIXTURES.staleNow)}
      withNav={params.get("nav") === "1"}
      host={host}
    />
  );
}
