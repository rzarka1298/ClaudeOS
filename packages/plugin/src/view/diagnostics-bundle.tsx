import type { BundleRefusalCode } from "@ccc/domain/diagnostic-bundle.js";
import type { VNode } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import { diagnostics } from "../diagnostics.js";
import {
  type BundleOutcome,
  type BundleSources,
  buildBundle,
  currentRuntimeFacts,
  type VerifyAndSerialise,
} from "../health/bundle-input.js";
import { bundleExport, type SaveOutcome } from "../health/export-port.js";
import {
  anyStale,
  healthPhase,
  healthResponse,
  healthVaultCheck,
  refreshHealth,
  rowsFor,
} from "../health/state.js";
import { projectsSnapshot } from "../projects/projects-state.js";
import { claudeIntegration } from "../widgets/session-signals.js";
import { CHECKING_LINE, checkedLine, ERROR_HEADING } from "./diagnostics-copy.js";
import { StatusLine } from "./settings-controls.js";
import type { SettingsHost } from "./settings-host.js";
import { useActionGate } from "./settings-pending.js";

/**
 * The diagnostic bundle block (plan 08-16; D-10 to D-13, 08-UI-SPEC S4, R-16, R-F5). HIGH RISK:
 * this is where a bundle can leave the process, so the rules here are the privacy boundary's UI.
 *
 * - The bundle is built only when the owner presses `Show bundle preview` (and rebuilt as the
 *   health answer changes while it is open), from the plugin's own facts by explicit picks
 *   (`health/bundle-input.ts`), and verified before anything renders.
 * - `outcome.text`, the string `verifyAndSerialise` returned, is the ONLY string this block ever
 *   previews, copies or saves. It is held in component state alone: never in `data.json`, never in
 *   the vault, never sent to the service; hiding the preview, or unmounting, drops it.
 * - A refused bundle is never rendered. The panel names the rule by its closed label, never the
 *   matched value; Copy and Save stay, `aria-disabled`, with the reason.
 * - Save goes through the export port, which opens the native save dialog and writes only outside
 *   the vault. This file imports neither Electron nor the file system (the harness bundle must not
 *   see them). Copy needs only the clipboard, so it is the fallback when there is no save dialog.
 * - With the service away the bundle is still offered, from plugin-local data (R-16); one built
 *   from checks older than five minutes says so (R-F5).
 * - Every outcome goes through the destination's one status line; this block adds no live region.
 */

export const BUNDLE_INTRO =
  "A bundle lists versions, the status of each subsystem with its reason code, counts and setting flags. " +
  "It never contains file paths, names of projects, sessions, tasks or reports, log lines, email addresses or tokens. " +
  "Read the preview before you share it.";

export const SAVE_UNAVAILABLE_REASON =
  "The save dialog isn't available here. Use Copy bundle instead.";
const SAVE_FAILED = "Couldn't save the bundle.";
const WAITING_REASON = "Waiting for the checks.";
const REFUSED_REASON = "The bundle was refused by a privacy check.";
const UNAVAILABLE_TEXT = "The bundle couldn't be built.";
const SERVICE_AWAY_LINE =
  "The companion service isn't running, so service versions and counts are left out.";
const CHECK_FAILED_LINE = "The checks couldn't run, so service versions and counts are left out.";
const STALE_LINE = "Built from checks older than 5 minutes";
const RUN_CHECKS_LABEL = "Run checks again";

/** What the refusal panel calls each rule. A closed map: the matched value is never in it. */
const REFUSAL_LABELS = {
  "home-path": "a home folder path",
  "tilde-path": "a path starting with ~/",
  email: "an email address",
  "token-shaped": "a token-shaped string",
  "denylist-project": "a project name",
  "denylist-folder": "a folder name",
  "denylist-github": "a GitHub owner or repository name",
  "denylist-vault": "the vault name",
  "denylist-user": "your macOS user name",
  "schema-invalid": "the bundle format",
  "too-large": "the size limit",
} as const satisfies Record<BundleRefusalCode, string>;

/** The status line for each save outcome. None of them names a path (T-08-42). */
const SAVE_NOTICES: Readonly<Record<SaveOutcome["kind"], string>> = {
  saved: "Bundle saved.",
  cancelled: "Save cancelled. Nothing was written.",
  unavailable: SAVE_UNAVAILABLE_REASON,
  "inside-vault": "That location is inside your vault. Choose a folder outside the vault.",
  "invalid-path": SAVE_FAILED,
  exists: "A file with that name already exists. Choose a new name. Nothing was written.",
  "unsupported-location":
    "This location can't hold the bundle safely. Choose a folder on your Mac's disk.",
  failed: SAVE_FAILED,
};

export interface DiagnosticBundleBlockProps {
  readonly host: SettingsHost;
  readonly connection: ConnectionState;
  readonly now: number;
  /**
   * The destination's status-line poster. Kept for API stability; the block no longer calls it
   * (D-09): its own outcomes are announced by the block's local status line, once.
   */
  readonly notify: (message: string) => void;
  /**
   * The verifier. Defaults to the domain's `verifyAndSerialise`; a parameter only so a test can
   * force a refusal the builder can never produce on its own.
   */
  readonly verify?: VerifyAndSerialise | undefined;
}

/**
 * The gap that makes an identical repeated message audible: the line is cleared, then set again a
 * beat later (the same rule as the destination's top line, so Copy bundle pressed twice is heard twice).
 */
const REPEAT_GAP_MS = 60;

const NUMBER = new Intl.NumberFormat("en");
const PLURAL = new Intl.PluralRules("en");

function sizeLine(text: string): string {
  const bytes = new TextEncoder().encode(text).length;
  const size = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
  const lines = text.split("\n").length;
  return `${size} · ${NUMBER.format(lines)} ${PLURAL.select(lines) === "one" ? "line" : "lines"}`;
}

/**
 * The preview: a `pre` that is a labelled, keyboard-reachable, vertically scrolling region
 * (UI-SPEC S4). The text is a text node, never markup, and stays selectable.
 */
function BundlePreview({
  id,
  text,
  onKeyDown,
}: {
  readonly id: string;
  readonly text: string;
  readonly onKeyDown: (event: KeyboardEvent) => void;
}): VNode {
  return (
    // biome-ignore lint/a11y/useSemanticElements: UI-SPEC S4 fixes `pre` with role region; a `section` would not keep the preformatted text
    <pre
      id={id}
      className="ccc-bundle-preview"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard reachable (UI-SPEC S4)
      tabIndex={0}
      role="region"
      aria-label="Diagnostic bundle preview"
      onKeyDown={onKeyDown}
    >
      {text}
    </pre>
  );
}

export function DiagnosticBundleBlock({
  host,
  connection,
  now,
  verify,
}: DiagnosticBundleBlockProps): VNode {
  const kind = connection.kind;
  const live = kind === "live";
  // Read during render so a new answer, a failed check or the clock moving on re-renders the block.
  const response = healthResponse.value;
  const phase = healthPhase.value;
  const vaultCheck = healthVaultCheck.value;
  // The other inputs the bundle is built from are read here too, so a change to any of them while
  // the preview is open re-renders the block and rebuilds the string (FIX4B m6).
  const projects = projectsSnapshot.value;
  const pluginDiagnostics = diagnostics.value;
  const integration = claudeIntegration.value;
  const { reducedMotion, notifyApprovals } = host.settings;
  const { pluginVersion, obsidianVersion, vaultName, userName } = host.display;
  const loading = live && response === null && phase !== "error";

  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<BundleOutcome | null>(null);
  // The bundle actions' own announcer (D-09): mounted, empty, before its first message.
  const [bundleStatus, setBundleStatus] = useState("");
  const shownRef = useRef("");
  const repeatTimerRef = useRef<number | null>(null);
  // The bundle text a copy or save message described; null when the line holds nothing about a
  // bundle (empty, or a checks line). A rebuild to different text or hiding the preview clears it.
  const describedTextRef = useRef<string | null>(null);
  // The preview's identity: bumped when the preview is hidden or its text changes, so a Copy or
  // Save that finishes afterwards (FIX15) cannot describe a preview that is no longer on screen.
  const previewEpochRef = useRef(0);
  const shownTextRef = useRef<string | null>(null);
  const previewId = useId();
  const reasonId = useId();
  const saveReasonId = useId();
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const nowRef = useRef(now);
  nowRef.current = now;
  const openRef = useRef(false);
  openRef.current = open;
  const mountedRef = useRef(true);
  const copyGate = useActionGate("bundle:copy");
  const saveGate = useActionGate("bundle:save");
  // The same key as the section's own button: one check at a time, whichever button started it.
  const checkGate = useActionGate("diagnostics:run-checks");
  const exporter = bundleExport();
  const saveAvailable = exporter.saveDialogAvailable();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (repeatTimerRef.current !== null) window.clearTimeout(repeatTimerRef.current);
    };
  }, []);

  /** The one way a bundle action speaks: its own line, beside its buttons (D-09). */
  function announce(message: string): void {
    // A press that finishes after unmount must not set a timer or touch state.
    if (!mountedRef.current) return;
    if (repeatTimerRef.current !== null) window.clearTimeout(repeatTimerRef.current);
    repeatTimerRef.current = null;
    if (message === shownRef.current && message !== "") {
      shownRef.current = "";
      setBundleStatus("");
      repeatTimerRef.current = window.setTimeout(() => {
        repeatTimerRef.current = null;
        shownRef.current = message;
        setBundleStatus(message);
      }, REPEAT_GAP_MS);
      return;
    }
    shownRef.current = message;
    setBundleStatus(message);
  }

  /** A copy or save outcome: announced, and remembered as describing this exact bundle text. */
  function announceAbout(epoch: number, bundleText: string, message: string): void {
    if (!mountedRef.current || epoch !== previewEpochRef.current) return;
    announce(message);
    describedTextRef.current = bundleText;
  }

  /** Empties the bundle line (and any pending repeat) without announcing anything. */
  function clearBundleLine(): void {
    if (repeatTimerRef.current !== null) window.clearTimeout(repeatTimerRef.current);
    repeatTimerRef.current = null;
    describedTextRef.current = null;
    shownRef.current = "";
    setBundleStatus("");
  }

  /** Builds from the values as they are at this moment (signals read with `peek`). */
  function build(): BundleOutcome | null {
    const held = healthResponse.peek();
    if (kind === "live" && held === null && healthPhase.peek() !== "error") return null;
    const snapshot = projectsSnapshot.peek();
    const sources: BundleSources = {
      now: nowRef.current,
      connection: kind,
      health: held,
      vaultCheck: healthVaultCheck.peek(),
      runtime: currentRuntimeFacts(host.display.obsidianVersion),
      pluginVersion: host.display.pluginVersion,
      settings: {
        reducedMotion: host.settings.reducedMotion,
        notifyApprovals: host.settings.notifyApprovals,
      },
      // Both come from last-good state that survives a disconnect. Unless the service is live
      // they are unknown (null), never old values reported as current (FIX6B).
      transcriptAnalysis: live
        ? (claudeIntegration.peek()?.transcriptAnalysis.enabled ?? null)
        : null,
      launchers: live ? (snapshot?.launchers ?? null) : null,
      diagnostics: diagnostics.peek(),
    };
    return buildBundle(
      sources,
      {
        projects: snapshot?.projects ?? [],
        vaultName: host.display.vaultName,
        userName: host.display.userName,
      },
      verify,
    );
  }

  // A new answer, a failed check, a connection change or a change to any other input (projects,
  // plugin records, the Claude integration, the host's flags) while the preview is open rebuilds it,
  // so the preview never shows an older answer than the one the plugin holds. The string is replaced
  // as a whole: the preview, Copy and Save move together.
  useEffect(() => {
    if (!openRef.current) return;
    const next = build();
    const nextText = next?.kind === "offered" ? next.text : null;
    if (nextText !== shownTextRef.current) previewEpochRef.current += 1;
    shownTextRef.current = nextText;
    setOutcome(next);
    // A copy or save message is about one string; once the preview shows a different one it is stale.
    const described = describedTextRef.current;
    if (described !== null && (next?.kind !== "offered" || next.text !== described)) {
      clearBundleLine();
    }
  }, [
    response,
    phase,
    kind,
    vaultCheck,
    projects,
    pluginDiagnostics,
    integration,
    reducedMotion,
    notifyApprovals,
    pluginVersion,
    obsidianVersion,
    vaultName,
    userName,
  ]);

  // Focus moves to the refusal heading when a refusal appears, not on every later rebuild.
  const shownKind = useRef<string | undefined>(undefined);
  useEffect(() => {
    const now_ = outcome?.kind;
    if (now_ === "refused" && shownKind.current !== "refused") headingRef.current?.focus();
    shownKind.current = now_;
  }, [outcome]);

  function close(): void {
    previewEpochRef.current += 1;
    shownTextRef.current = null;
    setOpen(false);
    setOutcome(null);
    clearBundleLine();
  }

  function toggle(): void {
    if (open) {
      close();
      return;
    }
    const built = build();
    shownTextRef.current = built?.kind === "offered" ? built.text : null;
    setOutcome(built);
    setOpen(true);
  }

  async function copy(): Promise<void> {
    if (outcome?.kind !== "offered" || !copyGate.begin()) return;
    const epoch = previewEpochRef.current;
    try {
      await host.copyText(outcome.text);
      announceAbout(epoch, outcome.text, "Bundle copied.");
    } catch {
      announceAbout(
        epoch,
        outcome.text,
        "Couldn't copy the bundle. Select the text in the preview and copy it by hand.",
      );
    } finally {
      copyGate.end();
    }
  }

  /**
   * The whole Save gesture. It saves the very string on screen (`outcome.text`), through the port,
   * which opens the dialog and refuses the vault; the press claims the gate before any await.
   */
  async function save(): Promise<void> {
    if (outcome?.kind !== "offered" || !saveAvailable || !saveGate.begin()) return;
    const epoch = previewEpochRef.current;
    try {
      const result = await exporter.save(outcome.text, host.display.vaultBasePath, nowRef.current);
      announceAbout(epoch, outcome.text, SAVE_NOTICES[result.kind]);
    } catch {
      announceAbout(epoch, outcome.text, SAVE_FAILED);
    } finally {
      saveGate.end();
    }
  }

  /** `Run checks again` (stale line and refusal panel): the owner's press re-runs the read-only checks. */
  async function runChecks(): Promise<void> {
    if (!live || !checkGate.begin()) return;
    describedTextRef.current = null;
    announce(CHECKING_LINE);
    const result = await refreshHealth("gesture", { vaultBasePath: host.display.vaultBasePath });
    checkGate.end();
    if (!mountedRef.current) return;
    if (result.kind === "ok") announce(checkedLine(result.timedOut));
    // An error, or a check the service going away cancelled with no newer fetch to take its place:
    // either way it did not finish, and the line must not stay on `Checking…`.
    else announce(ERROR_HEADING);
  }

  function onPreviewKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    close();
    toggleRef.current?.focus();
  }

  // What the buttons say when they cannot act, and what is shown instead of a preview.
  const offered = open && outcome?.kind === "offered";
  const refused = open && outcome?.kind === "refused";
  const waiting = open && outcome === null && loading;
  const unavailable = open && outcome?.kind === "unavailable";
  const disabledReason = waiting
    ? WAITING_REASON
    : refused
      ? REFUSED_REASON
      : unavailable
        ? UNAVAILABLE_TEXT
        : null;
  // The unavailable sentence is already on screen in place of the preview: describe by that one.
  const reasonTarget = unavailable ? previewId : reasonId;
  // The line under the preview: the stale notice only for a bundle built from an answer we hold.
  const rows = rowsFor(connection, response, vaultCheck);
  const stale = offered && live && response !== null && anyStale(rows, now);
  const serviceLine = offered
    ? !live
      ? SERVICE_AWAY_LINE
      : response === null
        ? CHECK_FAILED_LINE
        : null
    : null;

  return (
    <>
      <h4 className="ccc-settings-group-title">Diagnostic bundle</h4>
      <p>{BUNDLE_INTRO}</p>
      <div className="ccc-health-toolbar">
        <button
          ref={toggleRef}
          type="button"
          className="ccc-connect-button"
          data-variant="secondary"
          aria-expanded={open ? "true" : "false"}
          aria-controls={open ? previewId : undefined}
          onClick={toggle}
        >
          {open ? "Hide bundle preview" : "Show bundle preview"}
        </button>
      </div>

      {waiting && (
        <div id={previewId} aria-busy="true">
          <div className="ccc-skeleton-line" aria-hidden="true" />
          <div className="ccc-skeleton-line" aria-hidden="true" />
          <div className="ccc-skeleton-line" aria-hidden="true" />
        </div>
      )}

      {unavailable && <p id={previewId}>{UNAVAILABLE_TEXT}</p>}

      {refused && outcome?.kind === "refused" && (
        <div id={previewId} className="ccc-setup-callout">
          <h5 ref={headingRef} tabIndex={-1} className="ccc-settings-item-title">
            <span className="ccc-error-glyph" aria-hidden="true">
              ▲
            </span>{" "}
            Bundle not offered
          </h5>
          <p>
            {`The bundle failed a privacy check (${REFUSAL_LABELS[outcome.rule]}), so it can't be copied or saved. Nothing was exported. Run the checks again to rebuild it.`}
          </p>
          {live && (
            <button
              type="button"
              className="ccc-connect-button"
              data-variant="secondary"
              aria-busy={checkGate.busy ? "true" : undefined}
              aria-disabled={checkGate.busy ? "true" : undefined}
              onClick={() => void runChecks()}
            >
              {RUN_CHECKS_LABEL}
            </button>
          )}
        </div>
      )}

      {offered && outcome?.kind === "offered" && (
        <>
          <BundlePreview id={previewId} text={outcome.text} onKeyDown={onPreviewKeyDown} />
          {serviceLine !== null && <p>{serviceLine}</p>}
          {stale && (
            <div className="ccc-health-toolbar">
              <p className="ccc-health-stale">{STALE_LINE}</p>
              <button
                type="button"
                className="ccc-connect-button"
                data-variant="secondary"
                aria-busy={checkGate.busy ? "true" : undefined}
                aria-disabled={checkGate.busy ? "true" : undefined}
                onClick={() => void runChecks()}
              >
                {RUN_CHECKS_LABEL}
              </button>
            </div>
          )}
        </>
      )}

      {open && (
        <div className="ccc-health-toolbar">
          {offered && outcome?.kind === "offered" && <p>{sizeLine(outcome.text)}</p>}
          <button
            type="button"
            className="ccc-connect-button"
            data-variant="secondary"
            aria-busy={copyGate.busy ? "true" : undefined}
            aria-disabled={copyGate.busy || disabledReason !== null ? "true" : undefined}
            aria-describedby={disabledReason !== null ? reasonTarget : undefined}
            onClick={() => void copy()}
          >
            Copy bundle
          </button>
          <button
            type="button"
            className="ccc-connect-button"
            data-variant="secondary"
            aria-busy={saveGate.busy ? "true" : undefined}
            aria-disabled={
              saveGate.busy || disabledReason !== null || (offered && !saveAvailable)
                ? "true"
                : undefined
            }
            aria-describedby={
              disabledReason !== null
                ? reasonId
                : offered && !saveAvailable
                  ? saveReasonId
                  : undefined
            }
            onClick={() => void save()}
          >
            Save bundle
          </button>
          {disabledReason !== null && !unavailable && <p id={reasonId}>{disabledReason}</p>}
          {offered && !saveAvailable && <p id={saveReasonId}>{SAVE_UNAVAILABLE_REASON}</p>}
        </div>
      )}
      <StatusLine message={bundleStatus} region="bundle" />
    </>
  );
}
