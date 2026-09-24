import { computed } from "@preact/signals";
import type { VNode } from "preact";
import type { ConnectionState, LastEventInfo } from "../connection-state.js";
import { connectionChangedAt, connectionState, lastEvent } from "../connection-state.js";
import type { WidgetDefinition, WidgetState } from "./contract.js";

export interface ServiceHealthData {
  readonly connection: "live" | "disconnected";
  readonly reason?: string;
  readonly lastEvent?: LastEventInfo;
}

/** Skeleton — plan 03-05 Task 1 replaces this with the real derivation. */
export function serviceHealthStateFor(
  _connection: ConnectionState,
  _event: LastEventInfo | undefined,
  _changedAtIso: string,
): WidgetState<ServiceHealthData> {
  throw new Error(
    "serviceHealthStateFor is not implemented yet (packages/plugin/src/widgets/service-health.tsx)",
  );
}

export const serviceHealthState = computed<WidgetState<ServiceHealthData>>(() =>
  serviceHealthStateFor(connectionState.value, lastEvent.value, connectionChangedAt.value),
);

/** Skeleton — plan 03-05 Task 1 replaces this with the real definition. */
export const serviceHealthWidget: WidgetDefinition<ServiceHealthData> = {
  id: "service-health",
  title: "Service health",
  dataKeys: [],
  refresh: { kind: "event-driven" },
  minSize: "small",
  preferredSize: "medium",
  featureFlag: "widget.service-health",
  quickActions: [],
  renderBody: (): VNode => {
    throw new Error("serviceHealthWidget.renderBody is not implemented yet");
  },
  renderEmpty: (): VNode => {
    throw new Error("serviceHealthWidget.renderEmpty is not implemented yet");
  },
};
