import { isDisplayPath, toDisplayPath } from "@ccc/domain/display-path.js";
import type { VNode } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import {
  healthPhase,
  healthResponse,
  refreshHealth,
  registerHealthView,
  shownFreshness,
} from "../health/state.js";
import { ERROR_HEADING } from "./diagnostics-copy.js";
import { FreshnessBadge } from "./diagnostics-row.js";
import { SERVICE_AWAY_REASON } from "./settings-controls.js";
import type { SettingsHost } from "./settings-host.js";

/**
 * The Paths section (plan 08-18 Task 1; 08-UI-SPEC S2 Paths and R-F5, D-15, D-16, T-08-46): where
 * the command center keeps things, read-only.
 *
 * Every value is a display path (`~/...`, or `.../<parent>/<name>` outside the home folder),
 * selectable mono text, never an `input`, never an absolute path or a user name. The vault and the
 * data folder come from the shared health answer (the same one Diagnostics and Security read,
 * fetched once when this section opens and refreshed by the shared reconnect hook; there is no
 * second fetch path and no timer). The socket is the plugin's own resolved path, turned into a
 * display path here. Nothing is stored: the strings live in component state for the life of the
 * view, so `data.json` and `assertNoPrivatePathValues` are untouched.
 *
 * A value is `Unknown`, with the reason, whenever the service is not live, the last check failed,
 * or the answer has no such path; it is never guessed. An answer older than five minutes carries
 * the Stale badge on the service-owned rows (R-F5).
 */

export const PATHS_DESCRIPTION =
  "Where the command center keeps things. These locations are managed by the companion service and can't be changed here.";
export const NO_VAULT_REASON = "No managed vault is set up yet.";
export const SOCKET_UNKNOWN_REASON = "The plugin couldn't work out the socket location.";

/** What one path row can be showing. */
type PathView =
  | { readonly kind: "loading" }
  | { readonly kind: "path"; readonly display: string; readonly stale: boolean }
  | { readonly kind: "unknown"; readonly reason: string };

export interface PathsSectionProps {
  readonly host: SettingsHost;
  /** Read during render so the section follows the service coming and going. */
  readonly connection: ConnectionState;
  readonly now: number;
  /** The destination's status line; this section has no outcome to post. */
  readonly notify: (message: string) => void;
}

/** A display path the answer carries, or `null` when it is not one (never rendered as given). */
function checkedDisplayPath(value: string | null): string | null {
  return value !== null && isDisplayPath(value) ? value : null;
}

function PathFact({ name, view }: { readonly name: string; readonly view: PathView }): VNode {
  return (
    <>
      <dt>{name}</dt>
      <dd>
        {view.kind === "loading" && <div className="ccc-skeleton-line" aria-hidden="true" />}
        {view.kind === "path" && (
          <p>
            <code className="ccc-setting-path">{view.display}</code>
            {view.stale && (
              <>
                {" "}
                <FreshnessBadge freshness="stale" />
              </>
            )}
          </p>
        )}
        {view.kind === "unknown" && (
          <>
            <p className="ccc-setting-unknown">Unknown</p>
            <p>{view.reason}</p>
          </>
        )}
      </dd>
    </>
  );
}

export function PathsSection({ host, connection, now }: PathsSectionProps): VNode {
  const live = connection.kind === "live";
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

  function serviceOwned(pick: "vault" | "runtimeDir"): PathView {
    if (!live) return { kind: "unknown", reason: SERVICE_AWAY_REASON };
    if (response === null) {
      return phase === "error" ? { kind: "unknown", reason: ERROR_HEADING } : { kind: "loading" };
    }
    const display = checkedDisplayPath(response.paths[pick]);
    if (display === null) {
      return {
        kind: "unknown",
        reason: pick === "vault" && response.paths.vault === null ? NO_VAULT_REASON : ERROR_HEADING,
      };
    }
    const stale =
      shownFreshness({ checkedAt: response.generatedAt, freshness: "live" }, now) === "stale";
    return { kind: "path", display, stale };
  }

  function socketView(): PathView {
    const { socketPath, homeDir } = host.display;
    const display = socketPath === null ? null : toDisplayPath(socketPath, homeDir);
    // The plugin owns this value, so it needs neither the service nor an answer to age.
    return display === null
      ? { kind: "unknown", reason: SOCKET_UNKNOWN_REASON }
      : { kind: "path", display, stale: false };
  }

  const vaultView = serviceOwned("vault");
  const folderView = serviceOwned("runtimeDir");

  return (
    <>
      <h3 tabIndex={-1} className="ccc-settings-section-title">
        Paths
      </h3>
      <p>{PATHS_DESCRIPTION}</p>
      <dl
        className="ccc-detail-fields"
        aria-busy={
          vaultView.kind === "loading" || folderView.kind === "loading" ? "true" : undefined
        }
      >
        <PathFact name="Managed vault" view={vaultView} />
        <PathFact name="Service data folder" view={folderView} />
        <PathFact name="Service socket" view={socketView()} />
      </dl>
    </>
  );
}
