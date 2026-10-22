import type { VNode } from "preact";
import { useId, useRef, useState } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import { SERVICE_AWAY_REASON, SettingRow, SettingSwitch } from "./settings-controls.js";
import type { SettingsHost } from "./settings-host.js";
import {
  applyNotifyApprovalsChange,
  NOTIFY_APPROVALS_DESC,
  NOTIFY_APPROVALS_NAME,
  REBUILD_DESC,
  REBUILD_FAILED_NOTICE,
  REBUILD_NAME,
  REBUILD_STARTED_NOTICE,
  rebuildSuccessNotice,
  SEND_TEST_APPROVAL_DESC,
  SEND_TEST_APPROVAL_NAME,
} from "./settings-model.js";

/**
 * The Approvals and tasks section (plan 08-11 Task 3; 08-UI-SPEC S2, D-44, G5).
 *
 * Three rows, each setting in exactly one section: the approval notifications switch (a
 * plugin-owned preference, persisted as `notifyApprovals`), `Send a test approval` and
 * `Rebuild task index`. The two buttons need the companion service: while it is away they are
 * `aria-disabled` with a visible, undimmed reason they are described by, never natively
 * `disabled`. A rebuild reports in the destination's status line AND in a result line under its
 * row that stays after the status line moves on, so the runner can read it. That line is a
 * `role="status"` with `aria-live="off"`: it keeps the role the stylesheet and the runner look
 * for without a second live region announcing the same words twice (the status line stays the
 * destination's one live region). Its words are the moved strings, unchanged.
 */

export const APPROVALS_TASKS_DESCRIPTION =
  "Notifications for approval requests and the task index.";

export interface ApprovalsTasksSettingsProps {
  readonly host: SettingsHost;
  /** Read during render so a change in the service's availability re-renders the section. */
  readonly connection: ConnectionState;
  /** Posts an outcome to the destination's status line. */
  readonly notify: (message: string) => void;
}

export function ApprovalsTasksSettings({
  host,
  connection,
  notify,
}: ApprovalsTasksSettingsProps): VNode {
  const approvalsReasonId = useId();
  const tasksReasonId = useId();
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const [rebuildResult, setRebuildResult] = useState<string | null>(null);

  // The seams read the live connection; `connection` is a prop so the section re-renders when it moves.
  const approvalsAway = connection.kind === "disconnected" || !host.approvals.serviceAvailable();
  const tasksAway = connection.kind === "disconnected" || !host.tasks.serviceAvailable();

  function sendTestApproval(): void {
    if (approvalsAway) return;
    host.approvals.sendTestApproval();
  }

  async function rebuild(): Promise<void> {
    if (tasksAway || runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    notify(REBUILD_STARTED_NOTICE);
    let result: string;
    try {
      const counts = await host.tasks.rebuildTaskIndex();
      result = rebuildSuccessNotice(counts.tasks, counts.attention);
    } catch {
      result = REBUILD_FAILED_NOTICE;
    }
    notify(result);
    setRebuildResult(result);
    runningRef.current = false;
    setRunning(false);
  }

  return (
    <>
      <h3 tabIndex={-1} className="ccc-settings-section-title">
        Approvals and tasks
      </h3>
      <p>{APPROVALS_TASKS_DESCRIPTION}</p>
      <SettingRow
        name={NOTIFY_APPROVALS_NAME}
        description={NOTIFY_APPROVALS_DESC}
        control={({ nameId, descriptionId }) => (
          <SettingSwitch
            checked={host.settings.notifyApprovals}
            labelledBy={nameId}
            describedBy={descriptionId}
            onChange={(next) => applyNotifyApprovalsChange(host, next, notify)}
          />
        )}
      />
      <SettingRow
        name={SEND_TEST_APPROVAL_NAME}
        description={SEND_TEST_APPROVAL_DESC}
        control={({ descriptionId }) => (
          <button
            type="button"
            className="ccc-connect-button"
            data-variant="secondary"
            aria-disabled={approvalsAway ? "true" : undefined}
            aria-describedby={
              approvalsAway
                ? [descriptionId, approvalsReasonId].filter(Boolean).join(" ")
                : descriptionId
            }
            onClick={sendTestApproval}
          >
            {SEND_TEST_APPROVAL_NAME}
          </button>
        )}
      >
        {approvalsAway && <p id={approvalsReasonId}>{SERVICE_AWAY_REASON}</p>}
      </SettingRow>
      <SettingRow
        name={REBUILD_NAME}
        description={REBUILD_DESC}
        control={({ descriptionId }) => (
          <button
            type="button"
            className="ccc-connect-button"
            data-variant="secondary"
            aria-busy={running ? "true" : undefined}
            aria-disabled={tasksAway || running ? "true" : undefined}
            aria-describedby={
              tasksAway ? [descriptionId, tasksReasonId].filter(Boolean).join(" ") : descriptionId
            }
            onClick={() => void rebuild()}
          >
            {REBUILD_NAME}
          </button>
        )}
      >
        {tasksAway && <p id={tasksReasonId}>{SERVICE_AWAY_REASON}</p>}
        {rebuildResult !== null && (
          <p role="status" aria-live="off" data-result="rebuild">
            {rebuildResult}
          </p>
        )}
      </SettingRow>
    </>
  );
}
