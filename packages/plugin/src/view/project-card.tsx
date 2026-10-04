import type { Freshness, Partiality, ProjectId } from "@ccc/domain";
import type { Ref, VNode } from "preact";
import { useState } from "preact/hooks";
import type { ConnectionState } from "../connection-state.js";
import { LAUNCH_ERROR_COPY } from "../projects/launch-copy.js";
import type { ProjectsActions } from "../projects/projects-actions.js";
import type { QuickActionDescriptor } from "../widgets/contract.js";
import { WidgetFooter } from "../widgets/footer.js";
import {
  LaunchStatusLine,
  LaunchToolbar,
  PROJECT_LAUNCH_ACTIONS,
} from "../widgets/launch-toolbar.js";
import { type ProjectRow, projectMetaSegments } from "../widgets/panels.js";
import type { FooterModel, FooterSource } from "../widgets/presentation.js";
import { formatRelativeTime } from "../widgets/relative-time.js";
import type { DestinationId } from "./destinations.js";
import { ProjectManageToolbar } from "./project-manage-toolbar.js";

/**
 * The complete S3 project card (Task 3: git detail, remote, recent commits,
 * the later-phase fields line, the manage toolbar and the per-project
 * `WidgetFooter`). Task 1 built the name/path/meta anatomy; this task fills
 * in everything below it. Plan 04-10 mounts the S2 launch toolbar and its
 * status line between the remote row and "Recent commits" (UI-SPEC S3 card
 * anatomy) — or after the git lines for a folder with no repository, which
 * can still be opened.
 */
export interface ProjectCardProps {
  readonly row: ProjectRow;
  /** Home-abbreviated (`~/…`); never the raw absolute path (D-43). */
  readonly displayPath: string;
  readonly now: number;
  readonly connection: ConnectionState;
  readonly actions: ProjectsActions;
  /** Called after this project is removed, so the caller can move focus and announce it (Task 3, projects-view.tsx). */
  readonly onRemoved: (projectId: string, projectName: string) => void;
  /**
   * Attached to the card's name heading (`tabindex="-1"`) so a caller can
   * move focus there after a register, pin, unpin or removal.
   */
  readonly headingRef?: Ref<HTMLHeadingElement> | undefined;
  /** The one dispatcher every launch passes through (D-24). */
  readonly onQuickAction?: ((descriptor: QuickActionDescriptor) => void) | undefined;
  /** The Claude Code terminal's display label (UI-SPEC `{Terminal}`). */
  readonly terminalLabel?: string | undefined;
  readonly onNavigate?: ((destination: DestinationId) => void) | undefined;
  readonly openSystemSettings?: ((pane: "automation" | "privacy-security") => void) | undefined;
}

/** How long a project's own git read stays `live` after `observedAt` (D-12) — the same window `projects-state.ts` uses for the S1 card. */
const LIVE_WINDOW_MS = 60_000;

/** A pinned card's visible `★` plus a visually hidden `Pinned: ` prefix (UI-SPEC S3, Glyph Vocabulary). */
function PinnedMarker(): VNode {
  return (
    <p className="ccc-section-label ccc-section-label--muted">
      <span className="ccc-meta-glyph" aria-hidden="true">
        ★
      </span>{" "}
      Pinned
    </p>
  );
}

function MetaSegments({ row }: { readonly row: ProjectRow }): VNode {
  const segments = projectMetaSegments(row);
  return (
    <p className="ccc-list-meta ccc-meta-segments">
      {segments.map((segment, index) => (
        // Index keys are safe: segments are a fixed-order render output for one card, never reordered independently.
        <span key={index}>
          {index > 0 ? " · " : ""}
          {segment.glyph === undefined ? null : (
            <span className="ccc-meta-glyph" aria-hidden="true">
              {segment.glyph}
            </span>
          )}
          {segment.glyph === undefined ? "" : " "}
          {segment.text}
        </span>
      ))}
    </p>
  );
}

/**
 * The S3 "GitHub link override row" (UI-SPEC S3, RR-12): the `GitHub link`
 * label plus the owner-set `github.com/owner/repo`. Only an owner-set
 * override gets this row — a link derived from the git remote is already
 * shown by the remote row, so repeating it here would state it twice.
 */
function GithubLinkRow({ row }: { readonly row: ProjectRow }): VNode | null {
  if (row.github.kind !== "github" || row.github.source !== "override") return null;
  return (
    <p className="ccc-list-meta ccc-github-link-row">
      <span className="ccc-mono-label">GitHub link</span> {row.github.label}
    </p>
  );
}

/** The S3g git detail block: branch/dirty (or the error/pending states), remote and recent commits. */
function GitDetail({
  row,
  now,
  launch,
}: {
  readonly row: ProjectRow;
  readonly now: number;
  /** The S2 toolbar plus status line, or `null` while disconnected (RR-05). */
  readonly launch: VNode | null;
}): VNode {
  const git = row.git;

  // The very first read timed out or failed: the collector keeps `pending`
  // (there is no last-good value to show) and sets `gitReadFailed`. That is
  // a failure, not a load in progress, so it must never render the loading
  // skeleton (ADR-0002: never imply a state git has not reported).
  if (git.kind === "pending" && row.gitReadFailed) {
    return (
      <>
        <MetaSegments row={row} />
        <p className="ccc-state-body">Choose Refresh git status to try again.</p>
        <GithubLinkRow row={row} />
        {launch}
      </>
    );
  }

  if (git.kind === "pending") {
    return (
      <>
        <div aria-busy="true">
          <span className="ccc-visually-hidden">Loading git status…</span>
          <p className="ccc-skeleton-line" />
          <p className="ccc-skeleton-line" />
        </div>
        <GithubLinkRow row={row} />
        {launch}
      </>
    );
  }

  return (
    <>
      <MetaSegments row={row} />
      {git.kind === "git-unavailable" && (
        <p className="ccc-state-body">
          Install Apple's command line developer tools, then choose Refresh git status.
        </p>
      )}
      {git.kind === "folder-missing" && (
        <p className="ccc-state-body">Restore the folder, or remove the project.</p>
      )}
      {git.kind === "folder-access-denied" && (
        // PR-11: the launch error's own next step, true whether macOS
        // refused silently or asked first — one string, two surfaces.
        <p className="ccc-state-body">{LAUNCH_ERROR_COPY["folder-access-denied"].nextStep}</p>
      )}
      {git.kind !== "repo" && (
        <>
          <GithubLinkRow row={row} />
          {launch}
        </>
      )}
      {git.kind === "repo" && (
        <>
          <p className="ccc-list-meta">
            {git.remote === null ? "No remote" : `Remote ${git.remote.host}/${git.remote.path}`}
          </p>
          <GithubLinkRow row={row} />
          {launch}
          {git.commits.length === 0 ? (
            <p className="ccc-state-body">No commits yet</p>
          ) : (
            <>
              <p className="ccc-section-label">Recent commits</p>
              <ul className="ccc-commit-list">
                {git.commits.slice(0, 5).map((commit) => (
                  <li key={commit.hash} className="ccc-commit-row">
                    <p className="ccc-state-body ccc-clamp-2">{commit.subject}</p>
                    <p className="ccc-mono-label">
                      {`${commit.hash.slice(0, 7)} · ${formatRelativeTime(commit.committedAt, now)}`}
                    </p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </>
  );
}

/** The per-project footer model (D-12, D-16): freshness from `observedAt`, the independent Partial chip from `gitReadFailed`, and the two sources this card observes. */
export function projectFooterModel(
  row: ProjectRow,
  connection: ConnectionState,
  nowMs: number,
): FooterModel {
  const sources: FooterSource[] = [
    {
      label: "Project registry",
      status: connection.kind === "disconnected" ? "disconnected" : "ok",
    },
    {
      label: "Local git status",
      status:
        connection.kind === "disconnected"
          ? "disconnected"
          : row.gitReadFailed
            ? "missing"
            : row.observedAt === null
              ? "missing"
              : "ok",
    },
  ];

  if (connection.kind === "disconnected") {
    return {
      observedAt: row.observedAt,
      freshness: "unavailable",
      partiality: { partial: false },
      sources,
    };
  }
  if (row.observedAt === null) {
    // Never read successfully. A failed first read is still Partial: the
    // Local git status source is missing, and there is no time to show.
    const partiality: Partiality = row.gitReadFailed
      ? { partial: true, missingSources: ["Local git status"] }
      : { partial: false };
    return { observedAt: null, freshness: null, partiality, sources };
  }

  const freshness: Freshness =
    nowMs - Date.parse(row.observedAt) <= LIVE_WINDOW_MS ? "live" : "stale";
  const partiality: Partiality = row.gitReadFailed
    ? { partial: true, missingSources: ["Local git status"] }
    : { partial: false };
  return { observedAt: row.observedAt, freshness, partiality, sources };
}

function noHeadingRef(): void {}

export function ProjectCard({
  row,
  displayPath,
  now,
  connection,
  actions,
  onRemoved,
  headingRef = noHeadingRef,
  onQuickAction,
  terminalLabel = "Terminal",
  onNavigate,
  openSystemSettings,
}: ProjectCardProps): VNode {
  const headingId = `ccc-project-card-${row.id}`;
  const [status, setStatus] = useState("");
  // `ProjectRow.id` is a plain string for `ListBody`'s generic key; it is
  // always a service-issued ProjectId.
  const projectId = row.id as ProjectId;
  // Hidden while disconnected — the banner says why (RR-05, UI-SPEC S3).
  const launch =
    connection.kind === "disconnected" ? null : (
      <>
        <LaunchToolbar
          projectId={projectId}
          projectName={row.name}
          github={row.github}
          onQuickAction={onQuickAction}
        />
        <LaunchStatusLine
          projectId={projectId}
          projectName={row.name}
          terminalLabel={terminalLabel}
          actions={PROJECT_LAUNCH_ACTIONS}
          inProjects
          onNavigate={onNavigate}
          openSystemSettings={openSystemSettings}
        />
      </>
    );

  return (
    <article className="ccc-card ccc-project-card" aria-labelledby={headingId}>
      {row.pinned && <PinnedMarker />}
      <h4
        id={headingId}
        ref={headingRef}
        // Focusable so registration, pin/unpin and removal can move focus to
        // this card's own name (UI-SPEC S4 step 4, S3 "Pin project", RR-10) —
        // it gains no other role or interaction.
        tabIndex={-1}
        className="ccc-project-card-name ccc-clamp-2"
        title={row.name}
      >
        {row.name}
      </h4>
      <p className="ccc-display-path ccc-mono-label">{displayPath}</p>
      <GitDetail row={row} now={now} launch={launch} />
      <p role="status" className="ccc-state-body">
        {status}
      </p>
      <p className="ccc-later-fields">
        Issues and PRs unavailable · Sessions unavailable · Next task unavailable
      </p>
      {connection.kind !== "disconnected" && (
        <ProjectManageToolbar
          row={row}
          actions={actions}
          onRemoved={onRemoved}
          onStatus={setStatus}
        />
      )}
      <WidgetFooter
        model={projectFooterModel(row, connection, now)}
        panelTitle={row.name.toLowerCase()}
        now={now}
      />
    </article>
  );
}
