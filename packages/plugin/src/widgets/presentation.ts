import type { Freshness, Partiality } from "@ccc/domain";
import type { ConnectionState } from "../connection-state.js";
import type { DataDependencyKey, WidgetState } from "./contract.js";

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
  | { readonly kind: "unavailable"; readonly footer: FooterModel };

/** Skeleton — plan 03-05 Task 1 replaces this with the real derivation. */
export function resolveCardPresentation<T>(
  _state: WidgetState<T>,
  _connection: ConnectionState,
  _dataKeys: readonly DataDependencyKey[],
): CardPresentation {
  throw new Error(
    "resolveCardPresentation is not implemented yet (packages/plugin/src/widgets/presentation.ts)",
  );
}
