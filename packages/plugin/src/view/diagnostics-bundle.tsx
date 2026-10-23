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
import { healthPhase, healthResponse, healthVaultCheck } from "../health/state.js";
import { projectsSnapshot } from "../projects/projects-state.js";
import { claudeIntegration } from "../widgets/session-signals.js";
import type { SettingsHost } from "./settings-host.js";
import { useActionGate } from "./settings-pending.js";

/**
 * The diagnostic bundle block (plan 08-16; D-10 to D-13, 08-UI-SPEC S4). Placeholder for the
 * tracer commit: intro, toggle, preview, size line and Copy.
 */

export const BUNDLE_INTRO =
  "A bundle lists versions, the status of each subsystem with its reason code, counts and setting flags. " +
  "It never contains file paths, names of projects, sessions, tasks or reports, log lines, email addresses or tokens. " +
  "Read the preview before you share it.";

export interface DiagnosticBundleBlockProps {
  readonly host: SettingsHost;
  readonly connection: ConnectionState;
  readonly now: number;
  readonly notify: (message: string) => void;
  readonly verify?: VerifyAndSerialise | undefined;
}

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
  notify,
  verify,
}: DiagnosticBundleBlockProps): VNode {
  const response = healthResponse.value;
  const vaultCheck = healthVaultCheck.value;
  const kind = connection.kind;
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<BundleOutcome | null>(null);
  const previewId = useId();
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const nowRef = useRef(now);
  nowRef.current = now;
  const openRef = useRef(false);
  openRef.current = open;
  const copyGate = useActionGate("bundle:copy");

  /** Builds from the values as they are at this moment (signals read with `peek`). */
  function build(): BundleOutcome | null {
    if (healthPhase.peek() === "loading" && healthResponse.peek() === null && kind === "live") {
      return null;
    }
    const snapshot = projectsSnapshot.peek();
    const sources: BundleSources = {
      now: nowRef.current,
      connection: kind,
      health: healthResponse.peek(),
      vaultCheck: healthVaultCheck.peek(),
      runtime: currentRuntimeFacts(host.display.obsidianVersion),
      pluginVersion: host.display.pluginVersion,
      settings: {
        reducedMotion: host.settings.reducedMotion,
        notifyApprovals: host.settings.notifyApprovals,
      },
      transcriptAnalysis: claudeIntegration.peek()?.transcriptAnalysis.enabled ?? null,
      launchers: snapshot?.launchers ?? null,
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

  // A new answer while the preview is open rebuilds it, so the preview never shows an older answer
  // than the one the section holds. The string is replaced as a whole: preview and Copy move together.
  useEffect(() => {
    if (openRef.current) setOutcome(build());
  }, [response, kind, vaultCheck]);

  function toggle(): void {
    if (open) {
      setOpen(false);
      setOutcome(null);
      return;
    }
    setOutcome(build());
    setOpen(true);
  }

  async function copy(): Promise<void> {
    if (outcome?.kind !== "offered" || !copyGate.begin()) return;
    try {
      await host.copyText(outcome.text);
      notify("Bundle copied.");
    } catch {
      notify("Couldn't copy the bundle. Select the text in the preview and copy it by hand.");
    } finally {
      copyGate.end();
    }
  }

  function onPreviewKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    setOpen(false);
    setOutcome(null);
    toggleRef.current?.focus();
  }

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
      {open && outcome?.kind === "offered" && (
        <>
          <BundlePreview id={previewId} text={outcome.text} onKeyDown={onPreviewKeyDown} />
          <div className="ccc-health-toolbar">
            <p>{sizeLine(outcome.text)}</p>
            <button
              type="button"
              className="ccc-connect-button"
              data-variant="secondary"
              aria-busy={copyGate.busy ? "true" : undefined}
              aria-disabled={copyGate.busy ? "true" : undefined}
              onClick={() => void copy()}
            >
              Copy bundle
            </button>
          </div>
        </>
      )}
    </>
  );
}
