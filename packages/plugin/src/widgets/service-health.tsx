import { computed } from "@preact/signals";
import type { VNode } from "preact";
import type { ConnectionState, LastEventInfo } from "../connection-state.js";
import { connectionChangedAt, connectionState, lastEvent } from "../connection-state.js";
import type { WidgetDefinition, WidgetState } from "./contract.js";

/**
 * The one widget in this phase backed by real data (ADR-0023 "Panel state
 * assignment"). Every other PRD §7.1 panel renders `permission-required` or
 * `unavailable` until the phase that gives it a route — no fixture-backed card
 * ships behind a dev flag, because a card that looks real must be real (D-17).
 *
 * Its single data key declares `transport: "local"` deliberately. This card's
 * DATA *is* the connection, so when the companion service goes away it reports
 * that as current knowledge — freshness `live`, body `Service disconnected —
 * {reason}` — rather than flipping to the D-15 disconnected treatment, which
 * exists for cards whose OTHER data went stale because the connection died.
 * A card cannot be disconnected from the fact that it is disconnected.
 */

export interface ServiceHealthData {
  readonly connection: "live" | "disconnected";
  readonly reason?: string;
  readonly lastEvent?: LastEventInfo;
}

export function serviceHealthStateFor(
  connection: ConnectionState,
  event: LastEventInfo | undefined,
  changedAtIso: string,
): WidgetState<ServiceHealthData> {
  switch (connection.kind) {
    case "connecting":
      return { kind: "loading" };
    case "live":
      return {
        kind: "ready",
        data:
          event === undefined ? { connection: "live" } : { connection: "live", lastEvent: event },
        observedAt: event?.occurredAt ?? changedAtIso,
        freshness: "live",
        partiality: { partial: false },
        isEmpty: false,
      };
    case "disconnected":
      return {
        kind: "ready",
        data: { connection: "disconnected", reason: connection.reason },
        observedAt: changedAtIso,
        freshness: "live",
        partiality: { partial: false },
        isEmpty: false,
      };
  }
}

export const serviceHealthState = computed<WidgetState<ServiceHealthData>>(() =>
  serviceHealthStateFor(connectionState.value, lastEvent.value, connectionChangedAt.value),
);

function ServiceHealthBody({ data }: { readonly data: ServiceHealthData }): VNode {
  if (data.connection === "disconnected") {
    const line = `Service disconnected — ${data.reason ?? "no reason reported"}`;
    return (
      <p className="ccc-service-line ccc-clamp-2" title={line}>
        <span className="ccc-error-glyph" aria-hidden="true">
          ▲
        </span>
        {line}
      </p>
    );
  }
  return (
    <>
      <p className="ccc-kpi-number">Live</p>
      <p className="ccc-service-line">
        {data.lastEvent === undefined
          ? "No events received yet."
          : `Last event: ${data.lastEvent.type}`}
      </p>
    </>
  );
}

function ServiceHealthEmpty(): VNode {
  return <p className="ccc-service-line">No events received yet.</p>;
}

export const serviceHealthWidget: WidgetDefinition<ServiceHealthData> = {
  id: "service-health",
  title: "Service health",
  description: "Whether the companion service is connected, and what it last sent.",
  dataKeys: [
    {
      key: "service.event-stream",
      transport: "local",
      sourceLabel: "Companion service event stream",
    },
  ],
  refresh: { kind: "event-driven" },
  minSize: "small",
  preferredSize: "medium",
  featureFlag: "widget.service-health",
  quickActions: [],
  renderBody: ServiceHealthBody,
  renderEmpty: ServiceHealthEmpty,
};
