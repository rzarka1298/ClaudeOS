import type { ClaudeIntegrationStatus } from "@ccc/domain";
import type { CodexIntegrationStatus } from "@ccc/domain/codex-integration.js";
import type { VNode } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import { codexIntegration } from "../widgets/codex-signals.js";
import { claudeIntegration } from "../widgets/session-signals.js";
import { HealthLines } from "./codex-launcher-panel.js";
import {
  CODEX_BRIDGE_NAME,
  CODEX_COPY_BRIDGE_DESC,
  CODEX_COPY_BRIDGE_NAME,
  CODEX_COPY_INSTALL_DESC,
  CODEX_COPY_INSTALL_NAME,
  CODEX_GROUP_HEADING,
  CODEX_HOOKS_NAME,
  CODEX_LAUNCHER_DESC,
  CODEX_LAUNCHER_NAME,
  CODEX_NOTIFY_DESC,
  CODEX_NOTIFY_NAME,
  codexBridgeStatusText,
  codexHookStatusText,
} from "./codex-settings.js";
import {
  NOT_IN_VERSION_MARK,
  NOT_IN_VERSION_NAMES,
  NOT_IN_VERSION_SENTENCE,
  NOT_IN_VERSION_TAG,
  SETUP_COMMANDS,
} from "./diagnostics-copy.js";
import type { LaunchersSession } from "./launchers-settings.js";
import { SettingRow } from "./settings-controls.js";
import type { SettingsHost } from "./settings-host.js";
import {
  CLAUDE_COPY_FAILED_NOTICE,
  CLAUDE_COPY_INSTALL_DESC,
  CLAUDE_COPY_INSTALL_NAME,
  CLAUDE_COPY_UNINSTALL_DESC,
  CLAUDE_COPY_UNINSTALL_NAME,
  CLAUDE_HOOKS_NAME,
  CLAUDE_INSTALL_COPIED_NOTICE,
  CLAUDE_STATUS_UNAVAILABLE_TEXT,
  CLAUDE_STATUSLINE_NAME,
  CLAUDE_UNINSTALL_COMMAND,
  CLAUDE_UNINSTALL_COPIED_NOTICE,
  hookStatusText,
  statusLineStatusText,
} from "./settings-model.js";
import { useActionGate } from "./settings-pending.js";
import { requestSettingsSection } from "./settings-sections.js";

/**
 * The Integrations section (plan 08-15 Task 1; 08-UI-SPEC S2 Integrations, D-15, D-44, OD-2,
 * OD-4): the Claude Code and Codex rows moved from the native tab as copy-only status rows, and
 * the three accounts this version does not read.
 *
 * The app installs nothing and connects nothing. A copy row writes one fixed, repository-relative
 * command to the clipboard through `host.copyText` and says so in the destination's status line;
 * there is no install seam, no settings write and no Connect control anywhere in this file.
 *
 * Status text comes from the live `claudeIntegration` / `codexIntegration` signals, with the
 * seam's `getIntegration()` read once as the fallback while a signal is still empty, so a service
 * restart re-reads without a second state machine. With the service away (`disconnected`) every
 * status row reads the moved unavailable sentence and the copy rows stay enabled: copying needs
 * no service. `Check Codex health` stays in the launchers section (D-44); the Codex health row
 * here only reads the last result and links there. This file starts no timer and makes no
 * request of its own.
 */

export const INTEGRATIONS_DESCRIPTION =
  "Claude Code and Codex hooks, the status-line wrapper and the Codex bridge. " +
  "The app never installs anything: it shows status and copies the command for you to run.";

export const CODEX_HEALTH_NAME = "Codex health";
export const CODEX_HEALTH_HINT = "Run Check Codex health in the launchers section.";
export const GO_TO_LAUNCHERS_LABEL = "Go to the launchers section";
export const ACCOUNTS_HEADING = "Accounts";
export const CLAUDE_GROUP_TITLE = "Claude Code";

/** The label every install copy button shows; the Codex ones add what they install to the name. */
const COPY_INSTALL_LABEL = "Copy install command";
const COPY_CODEX_HOOKS_LABEL = "Copy install command for the Codex hooks";
const COPY_CODEX_BRIDGE_LABEL = "Copy install command for the Codex bridge";
const CODEX_INSTALL_COPIED_NOTICE = "Install step copied. Run it in Terminal.";

export interface IntegrationsSectionProps {
  readonly host: SettingsHost;
  /** Read during render so the section follows the service coming and going. */
  readonly connection: ConnectionState;
  readonly now: number;
  /** Posts an outcome to the destination's one status line. */
  readonly notify: (message: string) => void;
  /** Only its Codex health result is read, and read-only. */
  readonly launchersSession: LaunchersSession;
}

type Read<T> = T | "checking" | "unavailable";

/**
 * The live value when there is one; otherwise the seam's answer, read once per time the section
 * needs one (mounted with no signal, or the service coming back with no signal). A rejected read
 * settles on `unavailable`, never on `checking` forever.
 */
function useIntegrationStatus<T>(live: T | null, away: boolean, read: () => Promise<T>): Read<T> {
  const [fetched, setFetched] = useState<Read<T>>("checking");
  const readRef = useRef(read);
  readRef.current = read;
  const needsRead = live === null && !away;

  useEffect(() => {
    if (!needsRead) return;
    let cancelled = false;
    setFetched("checking");
    // `new Promise` also turns a synchronous throw in the seam into a rejection.
    new Promise<T>((resolve) => {
      resolve(readRef.current());
    }).then(
      (status) => {
        if (!cancelled) setFetched(status);
      },
      () => {
        if (!cancelled) setFetched("unavailable");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [needsRead]);

  if (live !== null) return live;
  return fetched;
}

/** A status row's text: a skeleton line while the first answer is awaited, else the sentence. */
function StatusText({
  id,
  checking,
  text,
}: {
  readonly id: string;
  readonly checking: boolean;
  readonly text: string;
}): VNode {
  if (checking) {
    return (
      <>
        <div className="ccc-skeleton-line" aria-hidden="true" />
        <p className="ccc-visually-hidden" data-status-text={id}>
          {text}
        </p>
      </>
    );
  }
  return <p data-status-text={id}>{text}</p>;
}

interface CopyRowProps {
  readonly name: string;
  readonly description: string;
  readonly command: string;
  readonly label: string;
  /** Names what is installed when several rows share the visible label; contains the label. */
  readonly ariaLabel?: string | undefined;
  readonly copiedNotice: string;
  readonly host: SettingsHost;
  readonly notify: (message: string) => void;
}

/**
 * A copy-only row. The press claims the gate before the clipboard await, so a second press is
 * ignored; the control stays focusable (`aria-busy`, never native `disabled`) and the outcome goes
 * to the one status line. Nothing here runs the command.
 */
function CopyRow({
  name,
  description,
  command,
  label,
  ariaLabel,
  copiedNotice,
  host,
  notify,
}: CopyRowProps): VNode {
  const gate = useActionGate(undefined);

  async function copy(): Promise<void> {
    if (!gate.begin()) return;
    try {
      await host.copyText(command);
      notify(copiedNotice);
    } catch {
      notify(CLAUDE_COPY_FAILED_NOTICE);
    } finally {
      gate.end();
    }
  }

  return (
    <SettingRow
      name={name}
      description={description}
      control={({ descriptionId }) => (
        <button
          type="button"
          className="ccc-connect-button"
          data-variant="secondary"
          aria-label={ariaLabel}
          aria-describedby={descriptionId}
          aria-busy={gate.busy ? "true" : undefined}
          aria-disabled={gate.busy ? "true" : undefined}
          onClick={() => void copy()}
        >
          {label}
        </button>
      )}
    >
      <p>
        <code className="ccc-mono">{command}</code>
      </p>
    </SettingRow>
  );
}

function GoToLaunchersButton({ describedBy }: { readonly describedBy: string | undefined }): VNode {
  return (
    <button
      type="button"
      className="ccc-connect-button"
      data-variant="secondary"
      aria-describedby={describedBy}
      onClick={() => requestSettingsSection("launchers")}
    >
      {GO_TO_LAUNCHERS_LABEL}
    </button>
  );
}

export function IntegrationsSection({
  host,
  connection,
  now,
  notify,
  launchersSession,
}: IntegrationsSectionProps): VNode {
  const away = connection.kind === "disconnected";
  const claude = useIntegrationStatus<ClaudeIntegrationStatus>(claudeIntegration.value, away, () =>
    host.claude.getIntegration(),
  );
  const codex = useIntegrationStatus<CodexIntegrationStatus>(codexIntegration.value, away, () =>
    host.codex.getIntegration(),
  );
  const doctor = launchersSession.codexDoctor.value;

  // The service being away is its own sentence; a Codex read that failed keeps its moved one.
  const claudeChecking = !away && claude === "checking";
  const codexChecking = !away && codex === "checking";
  const hookText = away ? CLAUDE_STATUS_UNAVAILABLE_TEXT : hookStatusText(claude, now);
  const statusLineText = away ? CLAUDE_STATUS_UNAVAILABLE_TEXT : statusLineStatusText(claude, now);
  const codexHooksText = away ? CLAUDE_STATUS_UNAVAILABLE_TEXT : codexHookStatusText(codex, now);
  const codexBridgeText = away ? CLAUDE_STATUS_UNAVAILABLE_TEXT : codexBridgeStatusText(codex, now);

  return (
    <>
      <h3 tabIndex={-1} className="ccc-settings-section-title">
        Integrations
      </h3>
      <p>{INTEGRATIONS_DESCRIPTION}</p>

      <div data-group="claude">
        <h4 className="ccc-settings-group-title">{CLAUDE_GROUP_TITLE}</h4>
        <SettingRow name={CLAUDE_HOOKS_NAME} control={() => null}>
          <StatusText id="claude-hooks" checking={claudeChecking} text={hookText} />
        </SettingRow>
        <CopyRow
          name={CLAUDE_COPY_INSTALL_NAME}
          description={CLAUDE_COPY_INSTALL_DESC}
          command={SETUP_COMMANDS["claude-hooks-install"]}
          label={COPY_INSTALL_LABEL}
          copiedNotice={CLAUDE_INSTALL_COPIED_NOTICE}
          host={host}
          notify={notify}
        />
        <CopyRow
          name={CLAUDE_COPY_UNINSTALL_NAME}
          description={CLAUDE_COPY_UNINSTALL_DESC}
          command={CLAUDE_UNINSTALL_COMMAND}
          label={CLAUDE_COPY_UNINSTALL_NAME}
          copiedNotice={CLAUDE_UNINSTALL_COPIED_NOTICE}
          host={host}
          notify={notify}
        />
        <SettingRow name={CLAUDE_STATUSLINE_NAME} control={() => null}>
          <StatusText id="claude-statusline" checking={claudeChecking} text={statusLineText} />
        </SettingRow>
      </div>

      <div data-group="codex">
        <h4 className="ccc-settings-group-title">{CODEX_GROUP_HEADING}</h4>
        <SettingRow name={CODEX_HOOKS_NAME} control={() => null}>
          <StatusText id="codex-hooks" checking={codexChecking} text={codexHooksText} />
        </SettingRow>
        <CopyRow
          name={CODEX_COPY_INSTALL_NAME}
          description={CODEX_COPY_INSTALL_DESC}
          command={SETUP_COMMANDS["codex-hooks-install"]}
          label={COPY_INSTALL_LABEL}
          ariaLabel={COPY_CODEX_HOOKS_LABEL}
          copiedNotice={CODEX_INSTALL_COPIED_NOTICE}
          host={host}
          notify={notify}
        />
        <SettingRow name={CODEX_BRIDGE_NAME} control={() => null}>
          <StatusText id="codex-bridge" checking={codexChecking} text={codexBridgeText} />
        </SettingRow>
        <CopyRow
          name={CODEX_COPY_BRIDGE_NAME}
          description={CODEX_COPY_BRIDGE_DESC}
          command={SETUP_COMMANDS["codex-bridge-install"]}
          label={COPY_INSTALL_LABEL}
          ariaLabel={COPY_CODEX_BRIDGE_LABEL}
          copiedNotice={CODEX_INSTALL_COPIED_NOTICE}
          host={host}
          notify={notify}
        />
        <SettingRow
          name={CODEX_HEALTH_NAME}
          description={CODEX_HEALTH_HINT}
          control={({ descriptionId }) => <GoToLaunchersButton describedBy={descriptionId} />}
        >
          {doctor.kind !== "idle" && (
            <p data-result="codex-health">
              <HealthLines state={doctor} />
            </p>
          )}
        </SettingRow>
        <SettingRow name={CODEX_NOTIFY_NAME} control={() => null}>
          <p>{CODEX_NOTIFY_DESC}</p>
        </SettingRow>
        <SettingRow
          name={CODEX_LAUNCHER_NAME}
          description={CODEX_LAUNCHER_DESC}
          control={({ descriptionId }) => <GoToLaunchersButton describedBy={descriptionId} />}
        />
      </div>

      <div data-group="accounts">
        <h4 className="ccc-settings-group-title">{ACCOUNTS_HEADING}</h4>
        {NOT_IN_VERSION_NAMES.map((name) => (
          <SettingRow key={name} name={name} control={() => null}>
            <p>
              <span className="ccc-badge" data-status="not-in-version">
                <span className="ccc-visually-hidden">Status: </span>
                <span className="ccc-badge-glyph" aria-hidden="true">
                  {NOT_IN_VERSION_MARK}
                </span>{" "}
                <span className="ccc-badge-label">{NOT_IN_VERSION_TAG}</span>
              </span>
            </p>
            <p>{NOT_IN_VERSION_SENTENCE}</p>
          </SettingRow>
        ))}
      </div>
    </>
  );
}
