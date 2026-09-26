import type { Freshness, Partiality } from "@ccc/domain";
import type { ConnectionState } from "../connection-state.js";
import type { DataDependencyKey, WidgetState } from "./contract.js";

/**
 * The one place a card's visual state is decided (UI-05).
 *
 * Presentation is DERIVED from three inputs — what the widget knows, what the
 * transport is doing, and which sources the widget declared — and never
 * invented, and never frozen on a stale value while the client is retrying.
 * A widget mid-disconnect always resolves `disconnected`, never `ready` with
 * last-good data presented as current: a card that freezes on its last good
 * value while its source is gone is the specific dishonesty the freshness
 * model exists to prevent (PLUG-04, roadmap success criterion 3).
 *
 * That is why there is no `kind: "stale"` and no `kind: "disconnected"` a
 * widget can set by hand. A parallel union would let `kind` and `freshness`
 * disagree and reopen exactly what ADR-0002 closed
 * (`docs/adr/0002-freshness-enum-plus-partial-flag.md`).
 *
 * The switch below is exhaustive with NO `default:` branch — TypeScript
 * exhaustiveness is the guard, the same shape `connection-state.ts`'s
 * `mapClientState` uses.
 */

/** What the Source panel reports for one declared data key. */
export type SourceStatus =
  | "ok"
  | "missing"
  | "disconnected"
  | "failed"
  | "no-source"
  | "not-connected";

export interface FooterSource {
  readonly label: string;
  readonly status: SourceStatus;
}

export interface FooterModel {
  readonly observedAt: string | null;
  readonly freshness: Freshness | null;
  readonly partiality: Partiality | null;
  readonly sources: readonly FooterSource[];
}

export type CardPresentation =
  | { readonly kind: "loading" }
  | { readonly kind: "empty"; readonly footer: FooterModel }
  | { readonly kind: "ready"; readonly footer: FooterModel }
  | { readonly kind: "stale"; readonly footer: FooterModel }
  | {
      readonly kind: "disconnected";
      readonly reason: string;
      readonly lastGood: FooterModel | null;
    }
  | { readonly kind: "error"; readonly message: string; readonly footer: FooterModel }
  | {
      readonly kind: "permission-required";
      readonly capability: string;
      readonly sourceLabel: string;
      readonly footer: FooterModel;
    }
  | {
      readonly kind: "unavailable";
      readonly footer: FooterModel;
      /** Carried unchanged from `WidgetState`'s `unavailable.reason` (SESS-18, D-12). */
      readonly reason?: string | undefined;
    };

/** Every declared key reported with the same status. */
function sourcesWith(
  dataKeys: readonly DataDependencyKey[],
  status: SourceStatus,
): readonly FooterSource[] {
  return dataKeys.map((key) => ({ label: key.sourceLabel, status }));
}

/**
 * The Source panel's row per declared key for a card that DID observe: a key
 * named in `partiality.missingSources` is reported `missing`, every other key
 * `ok`. This is what makes the partial badge checkable rather than decorative
 * (ADR-0002).
 */
function observedSources(
  dataKeys: readonly DataDependencyKey[],
  partiality: Partiality,
): readonly FooterSource[] {
  const missing = new Set(partiality.missingSources ?? []);
  return dataKeys.map((key) => ({
    label: key.sourceLabel,
    status: missing.has(key.sourceLabel) ? ("missing" as const) : ("ok" as const),
  }));
}

/** A footer for a card that has no observation to report. */
function blankFooter(
  dataKeys: readonly DataDependencyKey[],
  freshness: Freshness | null,
  status: SourceStatus,
): FooterModel {
  return { observedAt: null, freshness, partiality: null, sources: sourcesWith(dataKeys, status) };
}

/**
 * THE line that makes roadmap success criterion 3 structural rather than
 * per-widget discipline: a widget declaring even one `service` key cannot
 * resolve `ready` or `stale` while the transport is down, no matter what its
 * own state says. A widget author cannot opt out of it, because they never
 * decide their own presentation.
 */
function transportIsDown(
  connection: ConnectionState,
  dataKeys: readonly DataDependencyKey[],
): boolean {
  return connection.kind === "disconnected" && dataKeys.some((key) => key.transport === "service");
}

export function resolveCardPresentation<T>(
  state: WidgetState<T>,
  connection: ConnectionState,
  dataKeys: readonly DataDependencyKey[],
): CardPresentation {
  const reason = connection.kind === "disconnected" ? connection.reason : "";

  switch (state.kind) {
    case "loading":
      return { kind: "loading" };

    case "permission-required":
      return {
        kind: "permission-required",
        capability: state.capability,
        sourceLabel: state.sourceLabel,
        footer: blankFooter(dataKeys, null, "not-connected"),
      };

    case "error":
      // Terminal before transport: a card that failed to load did so whether
      // or not the connection is also down, and saying "disconnected" would
      // send the owner to the wrong diagnostic.
      return {
        kind: "error",
        message: state.message,
        footer: blankFooter(dataKeys, "unavailable", "failed"),
      };

    case "unavailable":
      if (transportIsDown(connection, dataKeys)) {
        return { kind: "disconnected", reason, lastGood: null };
      }
      return {
        kind: "unavailable",
        footer: blankFooter(dataKeys, "unavailable", "no-source"),
        reason: state.reason,
      };

    case "ready": {
      const footer: FooterModel = {
        observedAt: state.observedAt,
        freshness: state.freshness,
        partiality: state.partiality,
        sources: observedSources(dataKeys, state.partiality),
      };
      if (transportIsDown(connection, dataKeys)) {
        return {
          kind: "disconnected",
          reason,
          // The badge reads `Unavailable` while the observation time keeps the
          // last-good moment, so "Showing the last values received {relative}"
          // can be honest without the badge claiming currency (UI-SPEC
          // per-state table; truth 5).
          lastGood: {
            ...footer,
            freshness: "unavailable",
            sources: dataKeys.map((key) => ({
              label: key.sourceLabel,
              status: key.transport === "service" ? ("disconnected" as const) : ("ok" as const),
            })),
          },
        };
      }
      // An observation whose freshness is `unavailable` is not an observation:
      // presenting it as `ready` would put a card's last-good values on screen
      // with a badge that says the source is gone.
      if (state.freshness === "unavailable") {
        return { kind: "error", message: "The source reported no usable result.", footer };
      }
      if (state.isEmpty) return { kind: "empty", footer };
      if (state.freshness === "stale") return { kind: "stale", footer };
      return { kind: "ready", footer };
    }
  }
}
