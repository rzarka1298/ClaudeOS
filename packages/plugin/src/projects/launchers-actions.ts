import type {
  DetectionResponse,
  LaunchAction,
  LaunchErrorKind,
  LauncherConfigView,
  LauncherId,
  RefusedTemplate,
  SaveLauncherConfigRequest,
  SystemSettingsPane,
  TemplateRefusalReason,
  TerminalChoice,
} from "@ccc/domain";
import type { SocketApiClient } from "@ccc/service-api-client";

/** The two failures every non-Test launcher action can end in (SC-3: no message). */
export type LauncherActionFailure =
  | { readonly kind: "service-disconnected" }
  | { readonly kind: "failed" };

export type DetectOutcome =
  | { readonly kind: "detected"; readonly detection: DetectionResponse }
  | LauncherActionFailure;

export type ConfigsOutcome =
  | { readonly kind: "loaded"; readonly configs: LauncherConfigView }
  | LauncherActionFailure;

export type SaveOutcome =
  | { readonly kind: "saved" }
  | {
      readonly kind: "refused";
      readonly reason: TemplateRefusalReason;
      readonly index: number | null;
      readonly template?: RefusedTemplate;
    }
  | LauncherActionFailure;

export type TestOutcome =
  | { readonly kind: "sent" }
  | { readonly kind: "error"; readonly error: LaunchErrorKind }
  | { readonly kind: "conflict" };

export type MarkTestedOutcome =
  | { readonly kind: "marked" }
  | { readonly kind: "needs-test" }
  | LauncherActionFailure;

export type OpenSettingsOutcome = { readonly kind: "opened" } | LauncherActionFailure;

/** Every outcome a {@link LaunchersActions} method can resolve to. */
export type LauncherActionOutcome =
  | DetectOutcome
  | ConfigsOutcome
  | SaveOutcome
  | TestOutcome
  | MarkTestedOutcome
  | OpenSettingsOutcome;

export interface LaunchersActions {
  detect(): Promise<DetectOutcome>;
  getConfigs(): Promise<ConfigsOutcome>;
  save(request: SaveLauncherConfigRequest): Promise<SaveOutcome>;
  test(launcherId: LaunchAction, terminal?: TerminalChoice | null): Promise<TestOutcome>;
  markTested(launcherId: LauncherId): Promise<MarkTestedOutcome>;
  openSystemSettings(pane: SystemSettingsPane): Promise<OpenSettingsOutcome>;
}

const FAILED = Promise.resolve({ kind: "failed" as const });

/** RED stub: every action fails. */
export function createLaunchersActions(_client: SocketApiClient): LaunchersActions {
  return {
    detect: () => FAILED,
    getConfigs: () => FAILED,
    save: () => FAILED,
    test: () => Promise.resolve({ kind: "error", error: "spawn-failed" }),
    markTested: () => FAILED,
    openSystemSettings: () => FAILED,
  };
}
