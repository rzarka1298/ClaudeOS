import type { Freshness } from "@ccc/domain";
import {
  type DiagnosticsErrorCode,
  type DiagnosticsHealthResponse,
  type DisplayedRow,
  type HealthTrigger,
  type OverlayOnlyReason,
  type ServiceReason,
  type SetupAction,
  type SubsystemId,
  type SubsystemStatus,
  VAULT_REASON_STATUS,
} from "@ccc/domain/diagnostics.js";
import { effect, signal } from "@preact/signals";
import { type ConnectionState, connectionState } from "../connection-state.js";
import { HealthApiError, healthApi } from "./api.js";

/**
 * The Diagnostics health state (plan 08-13; D-03, D-05, D-43, 08-UI-SPEC S3).
 *
 * What the section shows is a pure function of three things: the connection state, the last
 * answer from the health route, and the result of comparing the vault fingerprint with the open
 * vault (the plugin-side overlay, D-36). The Companion service row never comes from the route: it is computed here
 * from the connection KIND alone (D-43), so the raw connection reason text has nowhere to go.
 * While the service is not live every other row is cleared to `unknown` with no last-good value
 * (D-03, ADR-0002), and the held answer itself is dropped.
 *
 * The health route is fetched by {@link refreshHealth} and nothing else; the callers are the
 * section opening and `Run checks again` (both owner gestures, in `diagnostics-section.tsx`) and
 * the reconnect hook ({@link onHealthLive}, trigger `reconnect`). There is no timer here, and
 * this module sends `gesture` nowhere: the trigger is always the caller's (Amendment A1).
 *
 * Memory only: the answer is held for the life of the plugin and never persisted.
 */

/** After this long a row's answer is shown as `Stale` (a plugin constant, UI-SPEC R-F5). */
export const HEALTH_STALE_AFTER_MS = 5 * 60 * 1000;

export type HealthPhase = "idle" | "loading" | "ready" | "error";

/** The last answer from the health route, or `null` (never fetched, cleared, or failed). */
export const healthResponse = signal<DiagnosticsHealthResponse | null>(null);

/** `loading` only until the first answer; a re-check keeps the rows it already has. */
export const healthPhase = signal<HealthPhase>("idle");

/**
 * Whether the vault open in Obsidian is the vault the service manages (D-36), decided with the
 * answer it belongs to. Only the verdict is held: the fingerprint stays inside the response
 * signal and the base path is never stored.
 */
export type VaultCheck = "match" | "mismatch" | "unavailable";
export const healthVaultCheck = signal<VaultCheck>("unavailable");

// ---------------------------------------------------------------------------
// Rows

/** The Companion service row, computed in the plugin (D-03). Its `checkedAt` is `null` unless live. */
export interface ServiceShownRow {
  readonly id: "service";
  readonly status: SubsystemStatus;
  readonly reasonCode: ServiceReason;
  readonly checkedAt: string | null;
  readonly freshness: Freshness;
}

/**
 * A service-dependent row cleared because the service is not live (D-03). A distinct type from
 * `DisplayedRow` because it has no `checkedAt`: "Not checked" is the truth, and a placeholder
 * instant would be an invented one.
 */
export interface ClearedRow {
  readonly id: Exclude<SubsystemId, "service">;
  readonly status: "unknown";
  readonly reasonCode: Extract<OverlayOnlyReason, "service-not-running">;
  readonly checkedAt: null;
  readonly freshness: "unavailable";
}

/** Any row the section can show, in its fixed order of six. */
export type ShownRow = ServiceShownRow | DisplayedRow | ClearedRow;

/**
 * The Companion service row from the connection state. Only the KIND is read: the `reason` of a
 * disconnected state is raw error text and never reaches a row (D-43, T-08-33).
 */
export function serviceRowFor(
  connection: ConnectionState,
  response: DiagnosticsHealthResponse | null,
): ServiceShownRow {
  switch (connection.kind) {
    case "live":
      return {
        id: "service",
        status: "ok",
        reasonCode: "service-live",
        checkedAt: response?.generatedAt ?? null,
        freshness: "live",
      };
    case "connecting":
      return {
        id: "service",
        status: "unknown",
        reasonCode: "service-connecting",
        checkedAt: null,
        freshness: "unavailable",
      };
    case "disconnected":
      return {
        id: "service",
        status: "failing",
        reasonCode: "service-unreachable",
        checkedAt: null,
        freshness: "unavailable",
      };
  }
}

const SERVICE_DEPENDENT_IDS = [
  "vault",
  "hooks",
  "collectors",
  "scheduler",
  "launchers",
] as const satisfies readonly Exclude<SubsystemId, "service">[];

/** The five service-dependent rows with the service away: unknown, no value, no action. */
export function clearedRows(): ClearedRow[] {
  return SERVICE_DEPENDENT_IDS.map((id) => ({
    id,
    status: "unknown",
    reasonCode: "service-not-running",
    checkedAt: null,
    freshness: "unavailable",
  }));
}

/**
 * The freshness a row shows now (UI-SPEC "Freshness on a health row"). The service says `live`,
 * `cached` or `unavailable`; the plugin derives `stale` when the row's `checkedAt` is older than
 * {@link HEALTH_STALE_AFTER_MS}, flipped by the one shared clock tick the caller passes in as
 * `now` (never a per-row timer, never a fetch). A row that was never checked, or whose probe gave
 * no answer (`unavailable`), is not made stale: there is no answer to age.
 */
export function shownFreshness(
  row: { readonly checkedAt: string | null; readonly freshness: Freshness },
  now: number,
): Freshness {
  if (row.checkedAt === null || row.freshness === "unavailable") return row.freshness;
  const age = now - Date.parse(row.checkedAt);
  return age > HEALTH_STALE_AFTER_MS ? "stale" : row.freshness;
}

/** True when any of the rows shows as stale at `now` (the stale line appears under the toolbar). */
export function anyStale(
  rows: readonly { readonly checkedAt: string | null; readonly freshness: Freshness }[],
  now: number,
): boolean {
  return rows.some((row) => shownFreshness(row, now) === "stale");
}

/** The vault row exactly as the service sent it. */
export type VaultServiceRow = DiagnosticsHealthResponse["rows"][0];

const VAULT_SETUP_ACTION: SetupAction = { kind: "run-plugin-command", command: "vault-setup" };

/**
 * The plugin-side vault overlay (D-36). The service says the managed vault is ready; only the
 * plugin knows which vault is open in Obsidian. A different vault reads `vault-mismatch`
 * (degraded, with the vault-setup action); a vault with no base path reads
 * `vault-check-unavailable` (unknown). Only a `vault-ready` row is overlaid: a worse answer from
 * the service (missing, unreadable, incomplete) is the more useful one and is never softened or
 * replaced. A matching vault returns the row itself.
 */
export function applyVaultOverlay(row: VaultServiceRow, check: VaultCheck): DisplayedRow {
  if (row.reasonCode !== "vault-ready" || check === "match") return row;
  if (check === "mismatch") {
    return {
      ...row,
      status: VAULT_REASON_STATUS["vault-mismatch"],
      reasonCode: "vault-mismatch",
      setupAction: VAULT_SETUP_ACTION,
    };
  }
  return {
    ...row,
    status: VAULT_REASON_STATUS["vault-check-unavailable"],
    reasonCode: "vault-check-unavailable",
  };
}

/**
 * The six rows, service first. The five service-dependent rows are the held answer (with the
 * vault overlay applied) when the service is live and an answer exists, and cleared in every
 * other case.
 */
export function rowsFor(
  connection: ConnectionState,
  response: DiagnosticsHealthResponse | null,
  vaultCheck: VaultCheck = "match",
): ShownRow[] {
  const service = serviceRowFor(connection, response);
  if (connection.kind !== "live" || response === null) return [service, ...clearedRows()];
  const [vault, ...rest] = response.rows;
  return [service, applyVaultOverlay(vault, vaultCheck), ...rest];
}

/** The first 16 lowercase hex characters of SHA-256 over `text`, with WebCrypto. */
async function digest16(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = await window.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/**
 * Compares the service's salted vault fingerprint with a WebCrypto digest of the open vault's
 * base path (D-36): both sides hash `salt:path` and compare the first 16 hex characters. The path
 * itself never crosses the wire. `unavailable` when there is no managed vault, the open vault has
 * no base path, or WebCrypto is not there to answer.
 */
export async function computeVaultCheck(
  fingerprint: DiagnosticsHealthResponse["vaultFingerprint"],
  basePath: string | null,
): Promise<VaultCheck> {
  if (fingerprint === null || basePath === null || basePath === "") return "unavailable";
  try {
    return (await digest16(`${fingerprint.salt}:${basePath}`)) === fingerprint.digest
      ? "match"
      : "mismatch";
  } catch {
    return "unavailable";
  }
}

// ---------------------------------------------------------------------------
// Refresh

export type HealthRefreshOutcome =
  | { readonly kind: "ok"; readonly timedOut: number }
  | { readonly kind: "error"; readonly code: DiagnosticsErrorCode }
  | { readonly kind: "superseded" };

export interface RefreshOptions {
  /** The open vault's folder on disk, or `null` for a vault that is not a local folder (D-36). */
  readonly vaultBasePath: string | null;
}

let sequence = 0;
let newest: Promise<HealthRefreshOutcome> | null = null;

/** Rows whose probe ran out of time (a row counts once, whether the row or one of its parts did). */
function countTimedOut(response: DiagnosticsHealthResponse): number {
  let count = 0;
  for (const row of response.rows) {
    const parts = "parts" in row && row.parts !== undefined ? row.parts : [];
    if (
      row.reasonCode === "probe-timeout" ||
      parts.some((part) => part.reasonCode === "probe-timeout")
    ) {
      count += 1;
    }
  }
  return count;
}

async function fetchAndPublish(
  token: number,
  trigger: HealthTrigger,
  options: RefreshOptions,
): Promise<HealthRefreshOutcome> {
  try {
    const response = await healthApi().get(trigger);
    // The verdict is computed with the answer it belongs to, so the vault row never flashes ready.
    const vaultCheck = await computeVaultCheck(response.vaultFingerprint, options.vaultBasePath);
    if (token !== sequence) return { kind: "superseded" };
    healthResponse.value = response;
    healthVaultCheck.value = vaultCheck;
    healthPhase.value = "ready";
    return { kind: "ok", timedOut: countTimedOut(response) };
  } catch (error) {
    if (token !== sequence) return { kind: "superseded" };
    // A failed check leaves no last-good answer on screen (D-03).
    healthResponse.value = null;
    healthVaultCheck.value = "unavailable";
    healthPhase.value = "error";
    return { kind: "error", code: error instanceof HealthApiError ? error.code : "internal" };
  }
}

/**
 * Waits for `first` and, while its answer was thrown away because a newer fetch overtook it,
 * for the newest fetch instead, so a caller is never left on an answer nobody published.
 */
async function settle(first: Promise<HealthRefreshOutcome>): Promise<HealthRefreshOutcome> {
  let attempt = first;
  let outcome = await attempt;
  while (outcome.kind === "superseded" && newest !== null && newest !== attempt) {
    attempt = newest;
    outcome = await attempt;
  }
  return outcome;
}

/**
 * The owner-gesture fetch still in flight, with the sequence token it ran under and what its
 * callers are waiting on. A reconnect joins it rather than overtaking it (see {@link refreshHealth}).
 */
let gestureFlight: {
  readonly token: number;
  readonly result: Promise<HealthRefreshOutcome>;
} | null = null;

/**
 * Fetches the health route and publishes the answer, newest fetch wins (the `statusSeq`
 * sequence-token pattern): an answer from an older fetch, or from one overtaken by
 * {@link clearHealth}, is dropped. A caller whose fetch was overtaken by a newer one is told what
 * the newest fetch found, so it never waits on an answer that was thrown away.
 *
 * `trigger` is the caller's: `gesture` only ever comes from an owner action. A `reconnect` never
 * overtakes a gesture fetch that is still in flight: it joins that fetch (no second request, the
 * gesture's trigger and its Keychain check kept) so the owner's fresh answer is not discarded in
 * favour of a reconnect answer that skips the key lookup. A gesture fetch that
 * {@link clearHealth} already overtook is not joined: its answer will be dropped, so the
 * reconnect fetches for itself. A gesture still overtakes a reconnect.
 */
export function refreshHealth(
  trigger: HealthTrigger,
  options: RefreshOptions,
): Promise<HealthRefreshOutcome> {
  if (trigger === "reconnect" && gestureFlight !== null && gestureFlight.token === sequence) {
    return gestureFlight.result;
  }
  sequence += 1;
  const token = sequence;
  if (healthResponse.peek() === null) healthPhase.value = "loading";
  const attempt = fetchAndPublish(token, trigger, options);
  newest = attempt;
  const result = settle(attempt);
  // The only other trigger is the owner's gesture, and this module never names it (the scan keeps
  // the word out of every file but the section and the API normaliser).
  if (trigger !== "reconnect") {
    const flight = { token, result };
    gestureFlight = flight;
    void result.then(() => {
      if (gestureFlight === flight) gestureFlight = null;
    });
  }
  return result;
}

/** Drops the held answer and any fetch in flight (the service went away, or the plugin unloads). */
export function clearHealth(): void {
  sequence += 1;
  healthResponse.value = null;
  healthVaultCheck.value = "unavailable";
  healthPhase.value = "idle";
}

// ---------------------------------------------------------------------------
// Reconnect hook

/** What a mounted Diagnostics section lends the reconnect hook. */
export interface HealthViewPort {
  /** The open vault's folder on disk, read when the hook fetches. */
  readonly vaultBasePath: () => string | null;
}

const views = new Set<HealthViewPort>();

/** Registers a mounted section; the returned function unregisters it. */
export function registerHealthView(port: HealthViewPort): () => void {
  views.add(port);
  return () => {
    views.delete(port);
  };
}

/** True while at least one Diagnostics section is mounted. */
export function healthViewMounted(): boolean {
  return views.size > 0;
}

/**
 * The reconnect hook (Amendment A1): refetches with the `reconnect` trigger, and only while a
 * section is mounted, so an unopened Diagnostics section costs the service nothing. It never
 * sends `gesture`, so a launchd restart or a wake from sleep can never cause a Keychain check.
 */
export function onHealthLive(): void {
  const view = views.values().next();
  if (view.done === true) return;
  void refreshHealth("reconnect", { vaultBasePath: view.value.vaultBasePath() });
}

/**
 * Drops the held answer the moment the service is not live (D-03): no last-good value survives a
 * disconnect, even with the section closed. Returns the stop function; the wiring releases it
 * through the host registry.
 */
export function watchConnection(): () => void {
  return effect(() => {
    if (connectionState.value.kind !== "live") clearHealth();
  });
}

/** Forgets the answer, any fetch in flight and every mounted view. For unload and tests. */
export function resetHealthState(): void {
  clearHealth();
  newest = null;
  gestureFlight = null;
  views.clear();
}
