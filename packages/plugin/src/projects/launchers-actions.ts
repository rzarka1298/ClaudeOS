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
import {
  detectLaunchers,
  getLauncherConfigs,
  markLauncherTested,
  openSystemSettings,
  ProjectsRequestError,
  type SocketApiClient,
  SocketUnreachableError,
  saveLauncherConfig,
  testLauncher,
} from "@ccc/service-api-client";
import { classifyLaunchFailure } from "./launch-client.js";

/**
 * The Launchers section's bound service actions (plan 04-12, D-27, D-28,
 * PR-13). Like `createProjectsActions`, this is the only seam through which
 * `packages/plugin/src/view/**` reaches `@ccc/service-api-client`: the view
 * host builds one real instance and components receive it as a prop.
 *
 * No method ever rejects. A `SocketUnreachableError` is classified by
 * `errno` alone — its `.message` embeds the socket path and is never read
 * (SC-3) — and a constant-body refusal by its HTTP status.
 */

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
  /** Finds candidate apps, `claude` executables and the terminal presets (D-27). */
  readonly detect: () => Promise<DetectOutcome>;
  /** The saved, display-safe configuration. */
  readonly getConfigs: () => Promise<ConfigsOutcome>;
  /** Saves exactly the owner's choice; the service re-validates it in full (D-22). */
  readonly save: (request: SaveLauncherConfigRequest) => Promise<SaveOutcome>;
  /**
   * Fires one real launch of the SAVED configuration (D-28). `terminal` is
   * the saved Claude Code terminal, so the client waits past the service's
   * Automation cap when the Test may meet that prompt (wave 5).
   */
  readonly test: (
    launcherId: LaunchAction,
    terminal?: TerminalChoice | null,
  ) => Promise<TestOutcome>;
  /** The owner answered "It opened" (RR-14). */
  readonly markTested: (launcherId: LauncherId) => Promise<MarkTestedOutcome>;
  /** Opens one of the two fixed System Settings panes (RR-16). */
  readonly openSystemSettings: (pane: SystemSettingsPane) => Promise<OpenSettingsOutcome>;
}

function classifyFailure(error: unknown): LauncherActionFailure {
  if (error instanceof SocketUnreachableError) {
    return error.errno === "ECONNREFUSED" || error.errno === "ENOENT"
      ? { kind: "service-disconnected" }
      : { kind: "failed" };
  }
  return { kind: "failed" };
}

function isConflict(error: unknown): boolean {
  return error instanceof ProjectsRequestError && error.status === 409;
}

/** The production {@link LaunchersActions}, bound to one authenticated client. */
export function createLaunchersActions(client: SocketApiClient): LaunchersActions {
  return {
    async detect() {
      try {
        return { kind: "detected", detection: await detectLaunchers(client) };
      } catch (error: unknown) {
        return classifyFailure(error);
      }
    },
    async getConfigs() {
      try {
        return { kind: "loaded", configs: await getLauncherConfigs(client) };
      } catch (error: unknown) {
        return classifyFailure(error);
      }
    },
    async save(request) {
      try {
        const result = await saveLauncherConfig(client, request);
        if (result.ok) return { kind: "saved" };
        return result.template === undefined
          ? { kind: "refused", reason: result.reason, index: result.index }
          : {
              kind: "refused",
              reason: result.reason,
              index: result.index,
              template: result.template,
            };
      } catch (error: unknown) {
        return classifyFailure(error);
      }
    },
    async test(launcherId, terminal) {
      try {
        const result = await testLauncher(client, launcherId, { terminal });
        return result.ok ? { kind: "sent" } : { kind: "error", error: result.error };
      } catch (error: unknown) {
        // A Test of a configuration newer than the one already being tested.
        if (isConflict(error)) return { kind: "conflict" };
        return { kind: "error", error: classifyLaunchFailure(error) };
      }
    },
    async markTested(launcherId) {
      try {
        await markLauncherTested(client, launcherId);
        return { kind: "marked" };
      } catch (error: unknown) {
        // The current saved row has no passing Test in this service run
        // (a save in between, or a restart): the owner tests again.
        if (isConflict(error)) return { kind: "needs-test" };
        return classifyFailure(error);
      }
    },
    async openSystemSettings(pane) {
      try {
        await openSystemSettings(client, pane);
        return { kind: "opened" };
      } catch (error: unknown) {
        return classifyFailure(error);
      }
    },
  };
}
