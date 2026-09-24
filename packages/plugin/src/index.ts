// `@ccc/plugin`'s real entry point is `main.ts` (esbuild bundles it to
// `main.js` at the plugin root, per Obsidian's loader contract) — this
// file exists so the package follows the same `src/index.ts` shape every
// other workspace package does; it re-exports the side-effect-free pieces.

export type { ConnectionState, LastEventInfo } from "./connection-state.js";
export {
  attachEventClient,
  connectionChangedAt,
  connectionState,
  lastEvent,
} from "./connection-state.js";
export type {
  DataDependencyKey,
  QuickActionDescriptor,
  RefreshPolicy,
  SizeHint,
  WidgetDefinition,
  WidgetState,
} from "./widgets/contract.js";
export { WidgetFooter } from "./widgets/footer.js";
export { WidgetFrame } from "./widgets/frame.js";
export type {
  CardPresentation,
  FooterModel,
  FooterSource,
  SourceStatus,
} from "./widgets/presentation.js";
export { resolveCardPresentation } from "./widgets/presentation.js";
export { formatAbsoluteTime, formatRelativeTime } from "./widgets/relative-time.js";
export type { ServiceHealthData } from "./widgets/service-health.js";
export {
  serviceHealthState,
  serviceHealthStateFor,
  serviceHealthWidget,
} from "./widgets/service-health.js";
