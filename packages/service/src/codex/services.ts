import type { ClaudeHeadroomView, UsageSummary } from "@ccc/domain";
import type Database from "better-sqlite3";
import type { Logger } from "pino";
import type { AttributeFn } from "../claude/attribution.js";
import type { AnalysisChange } from "../claude/usage-services.js";
import type { EventBus } from "../events/event-bus.js";
import type { Spawner } from "../projects/spawner.js";
import type { BridgeStatus } from "./bridge-state.js";
import type { CodexHomePort } from "./codex-home.js";
import type { CodexDetection } from "./detection.js";
import type { HeadroomTimers } from "./headroom-service.js";
import type { HookStatusFs } from "./hook-status.js";
import type { CodexRouteDeps } from "./routes.js";

/**
 * The Codex composition root (plan 05.1-28, D-14, D-15, D-17, D-24, D-25).
 * SIGNATURE STUB in the RED commit: the interfaces are final, the function throws.
 */

export interface CodexServicesDeps {
  readonly db: Database.Database;
  readonly bus: Pick<EventBus, "publish" | "subscriberCount">;
  readonly logger: Logger;
  /** The service environment (`CCC_CODEX_HOME`, `CODEX_HOME`, `XDG_STATE_HOME`, `CCC_CODEX_INACTIVITY_MS`, `CCC_SPOOL_POLL_MS`). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The owner's home directory (resolved once by the caller). */
  readonly home: string;
  /** The service runtime directory (the hook spool and the installed hook copy live under it). */
  readonly runtimeDir: string;
  /** The one process port; only the transcript opener uses it. */
  readonly spawner: Spawner;
  /** The Phase 5 usage summary, read late (the usage services may start before or after). */
  readonly usageSummary: () => UsageSummary | null;
  /** Codex detection for the install cache; absent means the saved launcher row alone decides. */
  readonly detection?: Pick<CodexDetection, "detectCodex" | "candidatePath"> | undefined;
  readonly readBridgeStatus?: (() => BridgeStatus) | undefined;
  /** The CODEX_HOME port; defaults to the allowlisted port over the resolved home. */
  readonly port?: CodexHomePort | undefined;
  readonly attribute?: AttributeFn | undefined;
  readonly now?: (() => number) | undefined;
  readonly timers?: HeadroomTimers | undefined;
  readonly serviceStartedAt?: number | undefined;
  readonly timeZone?: string | undefined;
  readonly spoolPollMs?: number | undefined;
  readonly settle?: (() => Promise<void>) | undefined;
  readonly isExecutable?: ((path: string) => Promise<boolean>) | undefined;
  readonly statusFs?: HookStatusFs | undefined;
  readonly mintRunId?: (() => string) | undefined;
}

export interface CodexServices {
  /** What `createRequestListener` carries as `RouteContext.codex`. */
  readonly routeDeps: CodexRouteDeps;
  /** Arms the timers and kicks the first install detection; `main.ts` calls it once the socket is open. */
  start(): void;
  /** The Phase 5 toggle or delete moved (additive listener of the usage services). */
  onAnalysisChanged(change: AnalysisChange): void;
  /** A launcher row was saved or changed. */
  onLaunchersChanged(): void;
  /** The usage services' integration refresh point: rescan the hook copy and the bridge. */
  onIntegrationRefresh(): void;
  /** Idempotent. Stops the spool, timers and in-flight work; the store may close after it resolves. */
  stop(): Promise<void>;
}

/** The Claude member of the headroom signal, from the Phase 5 usage summary. */
export function claudeHeadroomViewOf(_summary: UsageSummary | null): ClaudeHeadroomView {
  throw new Error("not implemented");
}

export function startCodexServices(_deps: CodexServicesDeps): Promise<CodexServices> {
  return Promise.reject(new Error("not implemented"));
}
