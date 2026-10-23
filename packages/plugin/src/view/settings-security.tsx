import type { ClaudeIntegrationStatus } from "@ccc/domain";
import { TOKEN_TTL_MS } from "@ccc/domain/auth.js";
import {
  type DiagnosticsHealthResponse,
  SUBSYSTEM_STATUS_DISPLAY,
  type SubsystemStatus,
} from "@ccc/domain/diagnostics.js";
import type { VNode } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import {
  healthPhase,
  healthResponse,
  refreshHealth,
  registerHealthView,
  shownFreshness,
} from "../health/state.js";
import { claudeIntegration } from "../widgets/session-signals.js";
import { ERROR_HEADING, SETUP_ACTION_COPY, SETUP_COMMANDS } from "./diagnostics-copy.js";
import { FreshnessBadge } from "./diagnostics-row.js";
import { SERVICE_AWAY_REASON, SettingRow, SettingSwitch } from "./settings-controls.js";
import type { SettingsHost } from "./settings-host.js";
import { useIntegrationStatus } from "./settings-integration-status.js";
import {
  applyTranscriptAnalysisChange,
  CLAUDE_DELETE_USAGE_DESC,
  CLAUDE_DELETE_USAGE_NAME,
  CLAUDE_DELETE_USAGE_RETAINED_NOTE,
  CLAUDE_HOOKS_CHECKING_TEXT,
  CLAUDE_TRANSCRIPT_ANALYSIS_DESC,
  CLAUDE_TRANSCRIPT_ANALYSIS_NAME,
  CLAUDE_USAGE_DELETE_FAILED_NOTICE,
  CLAUDE_USAGE_DELETED_NOTICE,
} from "./settings-model.js";
import { setActionResult, useActionGate, useActionResult } from "./settings-pending.js";
import { requestSettingsSection } from "./settings-sections.js";

/**
 * The Security section (plan 08-15 Task 2; 08-UI-SPEC S2 Security and R-F5, D-17, OD-4, APPR-05):
 * what protects the command center and what it stores, read-only, plus the two privacy controls
 * that already existed (Transcript analysis, Delete cached usage analytics).
 *
 * Nothing here changes a credential. The two Keychain chips show PRESENCE only, from the same
 * health answer Diagnostics reads (`healthResponse`, fetched when this section opens and
 * refreshed by the shared reconnect hook; there is no second fetch path and no timer). A chip
 * never reads `Present` unless the service said so in a held, live answer: with the service away,
 * a failed check or no answer yet it reads `Unknown` (or a skeleton while the first answer is
 * awaited), and an answer older than five minutes carries the Stale badge. When the research key
 * is not present the section offers the owner-run setup command as copyable text; copying is all
 * it does. No control stores, rotates or deletes a credential, and none adds an always-allow.
 */

export const SECURITY_DESCRIPTION =
  "What protects the command center, and what it stores. Nothing here changes a credential.";
export const APPROVALS_POINTER = "Approval notifications are in the approvals and tasks section.";
export const GO_TO_APPROVALS_LABEL = "Go to the approvals and tasks section";
export const KEYCHAIN_UNCHECKED_TEXT = "The keychain couldn't be checked.";
export const COPY_KEY_SETUP_LABEL = "Copy key setup command";

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const MS_PER_DAY = 24 * MINUTES_PER_HOUR * MS_PER_MINUTE;
const PLURAL = new Intl.PluralRules("en");

/** `1 hour`, `2 hours`, or minutes when the lifetime is not a whole number of hours. */
export function tokenLifeText(ttlMs: number): string {
  const minutes = Math.round(ttlMs / MS_PER_MINUTE);
  const wholeHours = minutes % MINUTES_PER_HOUR === 0;
  const count = wholeHours ? minutes / MINUTES_PER_HOUR : minutes;
  const unit = wholeHours ? "hour" : "minute";
  return `${count} ${PLURAL.select(count) === "one" ? unit : `${unit}s`}`;
}

export type KeychainKind = "installSecret" | "researchKey";

/** What the service says about one Keychain item: `present`, `absent` or `unknown`. */
type KeychainPresence = DiagnosticsHealthResponse["keychain"][KeychainKind];

export interface KeychainChip {
  readonly status: SubsystemStatus;
  readonly word: string;
  readonly glyph: string;
}

/**
 * The per-row word over the domain's status kinds (UI-SPEC S2: the kind is what tests assert).
 * `Present` needs the service's own `present`; `null` is no answer at all and reads `Unknown`.
 */
export function keychainChipFor(
  kind: KeychainKind,
  presence: KeychainPresence | null,
): KeychainChip {
  if (presence === "present") {
    return { status: "ok", word: "Present", glyph: SUBSYSTEM_STATUS_DISPLAY.ok.glyph };
  }
  if (presence === "absent") {
    return kind === "researchKey"
      ? {
          status: "setup-needed",
          word: SUBSYSTEM_STATUS_DISPLAY["setup-needed"].word,
          glyph: SUBSYSTEM_STATUS_DISPLAY["setup-needed"].glyph,
        }
      : { status: "failing", word: "Missing", glyph: SUBSYSTEM_STATUS_DISPLAY.failing.glyph };
  }
  return {
    status: "unknown",
    word: SUBSYSTEM_STATUS_DISPLAY.unknown.word,
    glyph: SUBSYSTEM_STATUS_DISPLAY.unknown.glyph,
  };
}

/** What one Keychain row can be showing. */
type KeychainView =
  | { readonly kind: "loading" }
  | {
      readonly kind: "shown";
      readonly chip: KeychainChip;
      readonly reason: string | null;
      readonly stale: boolean;
    };

export interface SecuritySectionProps {
  readonly host: SettingsHost;
  /** Read during render so the section follows the service coming and going. */
  readonly connection: ConnectionState;
  readonly now: number;
  /** Posts an outcome to the destination's one status line. */
  readonly notify: (message: string) => void;
}

function Chip({ chip }: { readonly chip: KeychainChip }): VNode {
  return (
    <span className="ccc-badge" data-status={chip.status}>
      <span className="ccc-visually-hidden">Status: </span>
      <span className="ccc-badge-glyph" aria-hidden="true">
        {chip.glyph}
      </span>
      <span className="ccc-badge-label">{chip.word}</span>
    </span>
  );
}

interface KeychainFactProps {
  readonly name: string;
  readonly sentence: string;
  readonly view: KeychainView;
  readonly children?: VNode | undefined;
}

/** One `dt` / `dd` pair for a Keychain value: chip, stale badge, reason, the fixed sentence. */
function KeychainFact({ name, sentence, view, children }: KeychainFactProps): VNode {
  return (
    <>
      <dt>{name}</dt>
      <dd>
        {view.kind === "loading" ? (
          <div className="ccc-skeleton-line" aria-hidden="true" />
        ) : (
          <p>
            <Chip chip={view.chip} />
            {view.stale && (
              <>
                {" "}
                <FreshnessBadge freshness="stale" />
              </>
            )}
          </p>
        )}
        {view.kind === "shown" && view.reason !== null && <p>{view.reason}</p>}
        <p>{sentence}</p>
        {children}
      </dd>
    </>
  );
}

export function SecuritySection({ host, connection, now, notify }: SecuritySectionProps): VNode {
  const live = connection.kind === "live";
  const away = connection.kind === "disconnected";
  // A held answer is only trusted while the connection is live: no last-good value survives.
  const response = live ? healthResponse.value : null;
  const phase = healthPhase.value;

  // Opening the section is an owner action, so this is the one fetch it makes. The connection is
  // read once, at mount: a service that comes up later is the reconnect hook's business.
  const openedLive = useRef(live);
  useEffect(() => {
    const release = registerHealthView({ vaultBasePath: () => host.display.vaultBasePath });
    if (openedLive.current) {
      void refreshHealth("gesture", { vaultBasePath: host.display.vaultBasePath });
    }
    return release;
  }, [host]);

  function viewFor(kind: KeychainKind): KeychainView {
    if (!live) {
      return {
        kind: "shown",
        chip: keychainChipFor(kind, null),
        reason: SERVICE_AWAY_REASON,
        stale: false,
      };
    }
    if (response === null) {
      if (phase === "error") {
        return {
          kind: "shown",
          chip: keychainChipFor(kind, null),
          reason: ERROR_HEADING,
          stale: false,
        };
      }
      return { kind: "loading" };
    }
    const presence = response.keychain[kind];
    const stale =
      shownFreshness({ checkedAt: response.generatedAt, freshness: "live" }, now) === "stale";
    return {
      kind: "shown",
      chip: keychainChipFor(kind, presence),
      reason: presence === "unknown" ? KEYCHAIN_UNCHECKED_TEXT : null,
      stale,
    };
  }

  const installView = viewFor("installSecret");
  const researchView = viewFor("researchKey");
  const offerKeySetup = researchView.kind === "shown" && researchView.chip.status !== "ok";

  // --- the setup command (copy only) ---------------------------------------------------------
  const copyGate = useActionGate(undefined);
  async function copyKeySetup(): Promise<void> {
    if (!copyGate.begin()) return;
    const command = SETUP_COMMANDS["research-key-setup"];
    try {
      await host.copyText(command);
      notify(SETUP_ACTION_COPY.copied({ command: "research-key-setup" }));
    } catch {
      notify(SETUP_ACTION_COPY.copyFailed);
    } finally {
      copyGate.end();
    }
  }

  // --- Transcript analysis and Delete cached usage analytics ---------------------------------
  const claude = useIntegrationStatus<ClaudeIntegrationStatus>(claudeIntegration.value, away, () =>
    host.claude.getIntegration(),
  );
  const status = typeof claude === "object" ? claude : null;
  // A confirmed change shows at once; a newer status from the service supersedes it.
  const [override, setOverride] = useState<boolean | null>(null);
  useEffect(() => {
    setOverride(null);
  }, [status]);
  const [justDisabled, setJustDisabled] = useState(false);
  const analysisOn = override ?? status?.transcriptAnalysis.enabled ?? false;
  const switchUnavailable = !live || status === null;
  const switchReasonId = useId();
  const deleteReasonId = useId();
  const switchReason =
    !live || claude === "unavailable" ? SERVICE_AWAY_REASON : CLAUDE_HOOKS_CHECKING_TEXT;

  async function changeAnalysis(next: boolean): Promise<"saved" | "reverted"> {
    const outcome = await applyTranscriptAnalysisChange(host, next, notify);
    if (outcome === "saved") {
      setOverride(next);
      // R-15: deletion is offered in the same flow as switching analysis off.
      setJustDisabled(!next);
    }
    return outcome;
  }

  const deleteGate = useActionGate("delete-usage");
  const deleteResult = useActionResult("delete-usage");
  async function deleteUsage(): Promise<void> {
    if (!live || !deleteGate.begin()) return;
    try {
      // The horizon is derived from the already-read status and the shared clock, never guessed.
      const horizon =
        status === null
          ? null
          : new Date(now - status.cleanupPeriodDays * MS_PER_DAY).toISOString();
      let confirmed = false;
      try {
        confirmed = await host.openDeleteUsageModal(horizon, analysisOn);
      } catch {
        confirmed = false;
      }
      if (!confirmed) return;
      let result: string;
      try {
        await host.claude.deleteUsageAnalytics();
        setJustDisabled(false);
        result = CLAUDE_USAGE_DELETED_NOTICE;
      } catch {
        result = CLAUDE_USAGE_DELETE_FAILED_NOTICE;
      }
      setActionResult("delete-usage", result);
      notify(result);
    } finally {
      deleteGate.end();
    }
  }

  return (
    <>
      <h3 tabIndex={-1} className="ccc-settings-section-title">
        Security
      </h3>
      <p>{SECURITY_DESCRIPTION}</p>
      <dl
        className="ccc-detail-fields"
        aria-busy={installView.kind === "loading" ? "true" : undefined}
      >
        <dt>Service connection</dt>
        <dd>A local socket that only you can read (mode 0600).</dd>
        <dt>Network listener</dt>
        <dd>None. The companion service doesn't listen on any network port.</dd>
        <dt>Connection tokens</dt>
        <dd>{`Each lasts ${tokenLifeText(TOKEN_TTL_MS)}. The plugin asks for a new one when it expires.`}</dd>
        <KeychainFact
          name="Install secret in keychain"
          sentence="Stored in the macOS keychain. Only its presence is shown, never its value."
          view={installView}
        />
        <KeychainFact
          name="Research key in keychain"
          sentence="Only its presence is shown, never its value."
          view={researchView}
        >
          {offerKeySetup ? (
            <>
              <p>
                <code className="ccc-mono">{SETUP_COMMANDS["research-key-setup"]}</code>
              </p>
              <button
                type="button"
                className="ccc-connect-button"
                data-variant="secondary"
                aria-busy={copyGate.busy ? "true" : undefined}
                aria-disabled={copyGate.busy ? "true" : undefined}
                onClick={() => void copyKeySetup()}
              >
                {COPY_KEY_SETUP_LABEL}
              </button>
            </>
          ) : undefined}
        </KeychainFact>
        <dt>Always allow</dt>
        <dd>No always-allow control exists. Every consequential action asks you each time.</dd>
      </dl>

      <SettingRow
        name={CLAUDE_TRANSCRIPT_ANALYSIS_NAME}
        description={CLAUDE_TRANSCRIPT_ANALYSIS_DESC}
        control={({ nameId, descriptionId }) => (
          <SettingSwitch
            checked={analysisOn}
            pendingKey="transcript-analysis"
            labelledBy={nameId}
            describedBy={
              switchUnavailable
                ? [descriptionId, switchReasonId].filter(Boolean).join(" ")
                : descriptionId
            }
            unavailable={switchUnavailable}
            onChange={changeAnalysis}
          />
        )}
      >
        {switchUnavailable && <p id={switchReasonId}>{switchReason}</p>}
      </SettingRow>

      <SettingRow
        name={CLAUDE_DELETE_USAGE_NAME}
        description={
          justDisabled
            ? `${CLAUDE_DELETE_USAGE_DESC} ${CLAUDE_DELETE_USAGE_RETAINED_NOTE}`
            : CLAUDE_DELETE_USAGE_DESC
        }
        control={({ descriptionId }) => (
          <button
            type="button"
            className="ccc-connect-button"
            data-variant="secondary"
            aria-busy={deleteGate.busy ? "true" : undefined}
            aria-disabled={!live || deleteGate.busy ? "true" : undefined}
            aria-describedby={
              live ? descriptionId : [descriptionId, deleteReasonId].filter(Boolean).join(" ")
            }
            onClick={() => void deleteUsage()}
          >
            {CLAUDE_DELETE_USAGE_NAME}
          </button>
        )}
      >
        {!live && <p id={deleteReasonId}>{SERVICE_AWAY_REASON}</p>}
        {deleteResult !== null && <p data-result="delete-usage">{deleteResult}</p>}
      </SettingRow>

      <SettingRow
        name="Approval notifications"
        description={APPROVALS_POINTER}
        control={({ descriptionId }) => (
          <button
            type="button"
            className="ccc-connect-button"
            data-variant="secondary"
            aria-describedby={descriptionId}
            onClick={() => requestSettingsSection("approvals-tasks")}
          >
            {GO_TO_APPROVALS_LABEL}
          </button>
        )}
      />
    </>
  );
}
