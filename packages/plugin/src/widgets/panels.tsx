import type {
  GithubTarget,
  LaunchersSummary,
  ProjectGitState,
  ProjectId,
  SizeHint,
} from "@ccc/domain";
import type { VNode } from "preact";
import { useContext } from "preact/hooks";
import { launchStatus, launchStatusKey } from "../projects/launch-status.js";
import { UntrustedText } from "../view/approval-text.js";
import type { DestinationId } from "../view/destinations.js";
import { launchersNeedSetup, SetupCallout } from "../view/setup-callout.js";
import type { QuickActionDescriptor, WidgetBodyProps, WidgetDefinition } from "./contract.js";
import { LaunchStatusLine, LaunchToolbar, PROJECT_LAUNCH_ACTIONS } from "./launch-toolbar.js";
import { ListBody } from "./list-body.js";
import { WidgetHostContext } from "./widget-host.js";

/**
 * The seven PRD §7.1 panels, in the PRD's own desktop ordering.
 *
 * None of them is backed by data in this phase — Today and GitHub discoveries
 * render `permission-required`, the other five render `unavailable` (ADR-0023
 * "Panel state assignment"). That is deliberate and structural rather than a
 * placeholder: `widget-data.ts` holds their states as CONSTANTS, so there is
 * no code path through which fixture data could reach a plugin card at all.
 * A card that looks real must be real (`D-17`); fixtures live in the harness
 * and the prototypes only.
 *
 * What each definition DOES carry now is the full UI-04 contract — the data
 * keys the owning phase will resolve, the refresh policy it will honour, the
 * size the grid will lay it out at, and a body typed to a data shape read off
 * PRD §7.1's listed contents. The owning phase (4–7) swaps one constant in
 * `widget-data.ts` for a client-fed signal and the card lights up; it does not
 * touch the frame, the contract or the registry.
 *
 * Nothing here imports `obsidian`, and nothing here imports a fixture.
 */

/**
 * A number whose source can fail on its own. `null` means UNAVAILABLE — the
 * source did not say — and is never the same thing as zero (project
 * constraint "Data integrity": unavailable shows `unavailable`, never zero).
 * Every numeric field below that comes from a source which can be
 * independently unreachable is typed this way, so the compiler forces the
 * body to decide what an unknown value reads as.
 */
export type MaybeCount = number | null;

/**
 * Digit grouping for every number a panel prints (`1,210,000`, never
 * `1210000`). The locale is pinned to en-US on purpose: the product copy is
 * English, and the visual harness pins the same locale, so a card reads the
 * same in the app and in its screenshot baseline.
 */
const GROUPED = new Intl.NumberFormat("en-US", { useGrouping: true, maximumFractionDigits: 0 });

function grouped(n: number): string {
  return GROUPED.format(n);
}

/**
 * `n` with a plural-safe noun: never `1 items` (UI-SPEC zero-one-many row).
 * An unavailable `n` reads `{unavailable}` — by default `{plural} unavailable`
 * — and never a digit, `null` or `0`.
 */
function count(
  n: MaybeCount,
  singular: string,
  plural: string,
  unavailable = `${plural} unavailable`,
): string {
  if (n === null) return unavailable;
  return `${grouped(n)} ${n === 1 ? singular : plural}`;
}

// ---------------------------------------------------------------------------
// 1. Today (PRD §7.1.1) — service-fed, always partial (plan 08-14, D-20)
// ---------------------------------------------------------------------------

/**
 * One task row on the Today card. `meta` is the finished meta line
 * (`Due 5:00 PM`, `Overdue since Oct 18`, `Next due Oct 22`), built by
 * `overview/overview-feeds.ts` from the service's dates and the owner's zone,
 * so this body formats nothing and cannot disagree with the feed.
 */
export interface TodayTask {
  /** The task's note id, so the card can open the task in Tasks (plan 06-18, D-38). */
  readonly taskId: string;
  /** The task's title: owner- or agent-authored vault text, rendered as text only. */
  readonly title: string;
  readonly meta: string;
}

/**
 * The managed-task feed's answer. `rows` is the overdue rows first and then
 * the rows due today. `nextOpen` is set only when `rows` is empty and the
 * service named a next open task; an older service that names none leaves it
 * `null`, which never reads as "no open task" (the empty rule lives in the
 * state mapping, not here).
 */
export interface TodayTasks {
  readonly rows: readonly TodayTask[];
  readonly nextOpen: TodayTask | null;
}

/**
 * `tasks` is `null` when the due-today feed has no answer: the body says
 * `Due tasks unavailable.` and never an empty list that would read as nothing
 * due. Calendar and Gmail are not part of this version and are not data here;
 * the body names them as such.
 */
export interface TodayData {
  readonly tasks: TodayTasks | null;
}

/** The Today card's heading for a section of the body (UI-SPEC S6 block order). */
function TodayHeading({
  children,
  focal,
}: {
  readonly children: string;
  readonly focal?: boolean;
}): VNode {
  return (
    <h4 className="ccc-today-section" data-focal={focal === true ? "true" : undefined}>
      {children}
    </h4>
  );
}

function TodayRows({
  rows,
  size,
  onNavigate,
}: {
  readonly rows: readonly TodayTask[];
  readonly size: SizeHint;
  readonly onNavigate: WidgetBodyProps<TodayData>["onNavigate"];
}): VNode | null {
  return (
    <ListBody<TodayTask>
      rows={rows}
      size={size}
      keyOf={(task) => task.taskId}
      renderPrimary={(task) => task.title}
      renderPrimaryContent={(task) => <UntrustedText text={task.title} />}
      renderMeta={(task) => task.meta}
      renderSelectLabel={(task) => `Open task: ${task.title}, ${task.meta}`}
      onSelectRow={(task) => onNavigate?.("tasks", { taskId: task.taskId })}
      moreDestination="tasks"
      moreLabel="Show more in the tasks view"
      onMore={onNavigate}
    />
  );
}

function TodayBody({ data, size, onNavigate }: WidgetBodyProps<TodayData>): VNode {
  const tasks = data.tasks;
  // The next open task shows only when nothing is due or overdue (D-21, UI-SPEC R-13).
  const nextOpen = tasks !== null && tasks.rows.length === 0 ? tasks.nextOpen : null;
  return (
    <>
      <TodayHeading focal={nextOpen === null}>Due today</TodayHeading>
      {tasks === null ? (
        <p className="ccc-state-body">Due tasks unavailable.</p>
      ) : tasks.rows.length === 0 ? (
        <p className="ccc-state-body">Nothing is due today.</p>
      ) : (
        <TodayRows rows={tasks.rows} size={size} onNavigate={onNavigate} />
      )}
      {nextOpen === null ? null : (
        <>
          <TodayHeading focal>Next open task</TodayHeading>
          <TodayRows rows={[nextOpen]} size={size} onNavigate={onNavigate} />
        </>
      )}
      <TodayNote />
    </>
  );
}

/** The unavailable-sources note: always present, never a zero (D-20, D-48, UI-SPEC R-12). */
function TodayNote(): VNode {
  return (
    <p className="ccc-today-note">
      <span aria-hidden="true">∅</span> Google Calendar and Gmail: not part of this version.
    </p>
  );
}

export const todayWidget: WidgetDefinition<TodayData> = {
  id: "today",
  title: "Today",
  description:
    "Tasks due today and automation failures. Calendar and Gmail aren't part of this version.",
  dataKeys: [
    { key: "calendar.today", transport: "service", sourceLabel: "Google Calendar" },
    { key: "mail.important-unread", transport: "service", sourceLabel: "Gmail" },
    { key: "tasks.due-today", transport: "service", sourceLabel: "Managed task store" },
    { key: "automation.failures", transport: "service", sourceLabel: "Automation runs" },
  ],
  refresh: { kind: "interval", everyMs: 60_000 },
  minSize: "medium",
  preferredSize: "wide",
  featureFlag: "widget.today",
  quickActions: [],
  renderBody: TodayBody,
  ownsEmptyCopy: true,
  renderEmpty: () => (
    <>
      <p className="ccc-state-heading">Nothing here yet</p>
      <p className="ccc-state-body">No open tasks and no automation failures.</p>
      <TodayNote />
    </>
  ),
};

// ---------------------------------------------------------------------------
// 2. Active Claude sessions (PRD §7.1.2) — moved to `active-sessions.tsx`
// (plan 05-06). Re-exported here so `registry.ts` needs no change (PATTERNS
// "Moving them"). This is the ONE line Phase 4's `projectShortcutsWidget`
// region below never has to see move.
// ---------------------------------------------------------------------------

export { type ActiveSessionsData, activeSessionsWidget } from "./active-sessions.js";

// ---------------------------------------------------------------------------
// 3. Project shortcuts (PRD §7.1.3) — unavailable until Phase 4
// ---------------------------------------------------------------------------

export interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly pinned: boolean;
  readonly git: ProjectGitState;
  /** A last-good `git` value whose latest refresh failed (ADR-0002). */
  readonly gitReadFailed: boolean;
  readonly github: GithubTarget;
  /** When `git` was last read; `null` while still `pending`. */
  readonly observedAt: string | null;
  /** Issue/task count from a source that can fail independently of git status. Never populated in Phase 4 (D-15). */
  readonly openItems: MaybeCount;
  /** From Claude Code hooks; unknown when no lifecycle event has arrived. Never populated in Phase 4 (D-15). */
  readonly sessionCount: MaybeCount;
  /** Never populated in Phase 4 (D-15). */
  readonly nextTask: string | null;
}

export interface ProjectShortcutsData {
  readonly projects: readonly ProjectRow[];
  readonly launchers: LaunchersSummary;
}

/** A plain-text rendering of {@link projectMetaSegments}, joined by " · " (Task 3 renders segments). */
function projectMetaLine(row: ProjectRow): string {
  return projectMetaSegments(row)
    .map((segment) => segment.text)
    .join(" · ");
}

/**
 * The S1 row meta content, per git kind (UI-SPEC "S1 Project shortcuts card
 * copy", Glyph Vocabulary). A failed read appends `◷ Stale` regardless of
 * kind (ADR-0002: freshness is stated, never implied).
 */
export function projectMetaSegments(
  row: ProjectRow,
): readonly { readonly glyph?: string; readonly text: string }[] {
  const segments: { readonly glyph?: string; readonly text: string }[] = [];
  const git = row.git;
  switch (git.kind) {
    case "repo":
      // `⎇` pairs only with a branch name or `Detached HEAD` (UI-SPEC Glyph
      // Vocabulary). A branch git could not name while HEAD is attached is
      // not a detached HEAD: it reads unavailable, like every unknown value.
      if (git.detached) segments.push({ glyph: "⎇", text: "Detached HEAD" });
      else if (git.branch === null) segments.push({ text: "Branch unavailable" });
      else segments.push({ glyph: "⎇", text: git.branch });
      segments.push(
        git.dirty ? { glyph: "✱", text: "Uncommitted changes" } : { glyph: "✓", text: "Clean" },
      );
      break;
    case "not-a-repo":
      segments.push({ glyph: "◌", text: "Not a Git repository" });
      break;
    case "git-unavailable":
      segments.push({ glyph: "▲", text: "Git unavailable" });
      break;
    case "folder-missing":
      segments.push({ glyph: "▲", text: "Folder not found" });
      break;
    case "skipped":
      segments.push({ text: "Git status skipped" });
      break;
    case "folder-access-denied":
      segments.push({ glyph: "▲", text: "Folder access blocked by macOS" });
      break;
    case "pending":
      // A pending state whose read already failed was never read at all:
      // it is a failure with nothing stale to qualify, not a check in
      // progress (codex finding 4).
      if (row.gitReadFailed) {
        segments.push({ glyph: "▲", text: "Couldn't read Git status" });
        return segments;
      }
      segments.push({ text: "Checking Git status…" });
      break;
  }
  if (row.gitReadFailed) {
    segments.push({ glyph: "◷", text: "Stale" });
  }
  return segments;
}

/** A pinned row's primary line carries a hidden "Pinned: " prefix plus a visible "★" (UI-SPEC S1, Glyph Vocabulary). */
function projectPrimaryBadge(project: ProjectRow): { hiddenLabel: string; glyph: string } | null {
  return project.pinned ? { hiddenLabel: "Pinned: ", glyph: "★" } : null;
}

function ProjectShortcutsBody({
  data,
  size,
  onNavigate,
  onQuickAction,
}: WidgetBodyProps<ProjectShortcutsData>): VNode | null {
  const terminalLabel = data.launchers["claude-code"].terminalLabel;
  const { openSystemSettings } = useContext(WidgetHostContext);
  // The frame hands `onQuickAction` in only for `ready`/`stale` (RR-05): a
  // disconnected card renders its dimmed rows with no toolbar and no status
  // line, so no launch control — and no danger-coloured line — ever sits
  // inside the 0.55-opacity body.
  const live = onQuickAction !== undefined;
  return (
    <>
      {launchersNeedSetup(data.launchers) && <SetupCallout onNavigate={onNavigate} />}
      <ListBody<ProjectRow>
        rows={data.projects}
        size={size}
        onMore={onNavigate}
        keyOf={(project) => project.id}
        renderPrimary={(project) => project.name}
        renderMeta={projectMetaLine}
        renderMetaSegments={projectMetaSegments}
        primaryBadge={projectPrimaryBadge}
        renderActions={
          live
            ? (project) => (
                <LaunchToolbar
                  // `ProjectRow.id` is a plain string for `ListBody`'s generic
                  // key; it is always a service-issued ProjectId.
                  projectId={project.id as ProjectId}
                  projectName={project.name}
                  github={project.github}
                  onQuickAction={onQuickAction}
                />
              )
            : undefined
        }
        renderStatus={
          live
            ? (project) => (
                <LaunchStatusLine
                  projectId={project.id as ProjectId}
                  projectName={project.name}
                  terminalLabel={terminalLabel}
                  actions={PROJECT_LAUNCH_ACTIONS}
                  onNavigate={onNavigate}
                  openSystemSettings={openSystemSettings}
                  onQuickAction={onQuickAction}
                />
              )
            : undefined
        }
        moreDestination="projects"
      />
    </>
  );
}

/** S1's empty copy (UI-SPEC "Copywriting Contract", RR-27): the frame's own `Nothing here yet` precedes this. */
function ProjectShortcutsEmpty({
  onNavigate,
  data,
}: {
  readonly onNavigate?: ((destination: DestinationId) => void) | undefined;
  readonly data?: ProjectShortcutsData | undefined;
}): VNode {
  return (
    <>
      <p className="ccc-state-body">Register a project in Projects to see it here.</p>
      <button
        type="button"
        className="ccc-connect-button ccc-empty-action"
        onClick={() => onNavigate?.("projects")}
      >
        Go to Projects
      </button>
      {/* The setup state comes from the card's own widget state (RR-27, S10). */}
      {launchersNeedSetup(data?.launchers) && <SetupCallout onNavigate={onNavigate} />}
    </>
  );
}

export const projectShortcutsWidget: WidgetDefinition<ProjectShortcutsData> = {
  id: "project-shortcuts",
  title: "Project shortcuts",
  description: "Pinned projects, their branch state and one-click actions. Filled in by phase 4.",
  dataKeys: [
    { key: "projects.registered", transport: "service", sourceLabel: "Project registry" },
    { key: "projects.git-status", transport: "service", sourceLabel: "Local git status" },
    { key: "launchers.config", transport: "service", sourceLabel: "Launcher settings" },
  ],
  refresh: { kind: "interval", everyMs: 30_000 },
  minSize: "small",
  preferredSize: "medium",
  featureFlag: "widget.project-shortcuts",
  quickActions: [],
  renderBody: ProjectShortcutsBody,
  renderEmpty: ProjectShortcutsEmpty,
};

// ---------------------------------------------------------------------------
// 4. Claude usage (PRD §7.1.4) — moved to `claude-usage.tsx` (plan 05-10).
// Re-exported here so `registry.ts` needs no change (PATTERNS "Moving
// them"), the same move plan 05-06 made for section 2 above.
// ---------------------------------------------------------------------------

export { type ClaudeUsageData, claudeUsageWidget } from "./claude-usage.js";

// ---------------------------------------------------------------------------
// 5. Technology and market intelligence (PRD §7.1.5) — unavailable, Phase 7
// ---------------------------------------------------------------------------

export interface IntelStory {
  readonly id: string;
  readonly headline: string;
  readonly category: string;
  readonly summary: string;
  /**
   * Counted by the research pipeline from the sources it actually collected
   * for this story, so it is always known — a story with no sources is not
   * emitted. Deliberately NOT a {@link MaybeCount}.
   */
  readonly sourceCount: number;
}

export interface TechIntelData {
  readonly stories: readonly IntelStory[];
  readonly marketSummary: string | null;
}

function TechIntelBody({ data, size, onNavigate }: WidgetBodyProps<TechIntelData>): VNode {
  return (
    <>
      <ListBody<IntelStory>
        rows={data.stories}
        size={size}
        onMore={onNavigate}
        keyOf={(story) => story.id}
        renderPrimary={(story) => story.headline}
        renderMeta={(story) =>
          `${story.category} · ${count(story.sourceCount, "source", "sources")}`
        }
        moreDestination="research"
      />
      {data.marketSummary === null ? null : (
        <p className="ccc-state-body ccc-clamp-2">{data.marketSummary}</p>
      )}
    </>
  );
}

export const techIntelWidget: WidgetDefinition<TechIntelData> = {
  id: "tech-intel",
  title: "Technology and market intelligence",
  description: "Top daily stories and a broad market summary. Filled in by phase 7.",
  dataKeys: [{ key: "intel.daily", transport: "service", sourceLabel: "Research pipeline" }],
  refresh: { kind: "manual" },
  minSize: "medium",
  preferredSize: "tall",
  featureFlag: "widget.tech-intel",
  quickActions: [],
  renderBody: TechIntelBody,
  renderEmpty: () => <p className="ccc-state-body">No stories have been collected yet.</p>,
};

// ---------------------------------------------------------------------------
// 6. GitHub discoveries (PRD §7.1.6) — permission-required behind `github`
// ---------------------------------------------------------------------------

export interface DiscoveredRepo {
  readonly id: string;
  readonly name: string;
  /** A star snapshot can fail per repo (rate limit) while the report still lists it. */
  readonly stars: MaybeCount;
  readonly growth: string;
  readonly reason: string;
}

export interface GithubDiscoveriesData {
  readonly repos: readonly DiscoveredRepo[];
}

function GithubDiscoveriesBody({
  data,
  size,
  onNavigate,
}: WidgetBodyProps<GithubDiscoveriesData>): VNode | null {
  return (
    <ListBody<DiscoveredRepo>
      rows={data.repos}
      size={size}
      onMore={onNavigate}
      keyOf={(repo) => repo.id}
      renderPrimary={(repo) => repo.name}
      renderMeta={(repo) =>
        `${count(repo.stars, "star", "stars")} · ${repo.growth} · ${repo.reason}`
      }
      moreDestination="research"
    />
  );
}

export const githubDiscoveriesWidget: WidgetDefinition<GithubDiscoveriesData> = {
  id: "github-discoveries",
  title: "GitHub discoveries",
  description: "Fast-growing repositories and contribution candidates. Filled in by phase 7.",
  dataKeys: [
    { key: "github.weekly-report", transport: "service", sourceLabel: "GitHub weekly report" },
  ],
  refresh: { kind: "manual" },
  minSize: "small",
  preferredSize: "medium",
  featureFlag: "widget.github-discoveries",
  quickActions: [],
  renderBody: GithubDiscoveriesBody,
  renderEmpty: () => <p className="ccc-state-body">The latest report found nothing new.</p>,
};

// ---------------------------------------------------------------------------
// 7. Quick actions (PRD §7.1.7) — two live actions in Phase 4 (D-38)
// ---------------------------------------------------------------------------

/**
 * S8 (D-38, PR-08, PR-12). Two actions are live in Phase 4 — `Start a Claude
 * Code session` opens the quick switcher prefilled, `Open Claude Desktop` is
 * an S2-style launch — and the other four stay honestly unavailable until
 * their phases land. All six stay declared on `quickActions` so Phase 6's
 * approval engine has a capability to classify; `actionsInBody` tells the
 * frame to skip its generic row because this body lays them out itself.
 * Every button still emits a DESCRIPTOR through `onQuickAction` — the one
 * dispatcher — and the frame hands that channel in only for `ready`/`stale`,
 * so nothing here can launch while disconnected (RR-05).
 */
export interface QuickActionsData {
  readonly launchers: LaunchersSummary;
}

const QUICK_ACTIONS: readonly QuickActionDescriptor[] = [
  { id: "run-skill", label: "Run a skill", capability: "skill:run" },
  { id: "start-session", label: "Start a Claude Code session", capability: "switcher:claude-code" },
  { id: "create-task", label: "Create a task", capability: "task:create" },
  { id: "capture-note", label: "Capture an inbox note", capability: "note:capture" },
  { id: "refresh-data", label: "Refresh selected data", capability: "data:refresh" },
  { id: "open-claude-desktop", label: "Open Claude Desktop", capability: "launch:claude-desktop" },
];

function isLive(action: QuickActionDescriptor): boolean {
  return (
    action.capability.startsWith("launch:") ||
    action.capability.startsWith("switcher:") ||
    action.capability === "task:create"
  );
}

/** The live buttons in order: the session, Claude Desktop, then Create a task (UI-SPEC S8, S6). */
const LIVE_QUICK_ACTIONS = ["start-session", "open-claude-desktop", "create-task"].flatMap((id) =>
  QUICK_ACTIONS.filter((action) => action.id === id),
);
const UNAVAILABLE_QUICK_ACTIONS = QUICK_ACTIONS.filter((action) => !isLive(action));

const CLAUDE_DESKTOP_KEY = launchStatusKey(null, "claude-desktop");
const CLAUDE_DESKTOP_ACTIONS = ["claude-desktop"] as const;

function QuickActionsBody({
  data,
  onNavigate,
  onQuickAction,
}: WidgetBodyProps<QuickActionsData>): VNode | null {
  const { switcherAvailable, openSystemSettings } = useContext(WidgetHostContext);
  // The frame hands `onQuickAction` in only for `ready`/`stale` (RR-05). In
  // `disconnected` the card hides its buttons (UI-SPEC S8, the Phase 3 rule)
  // and the Claude Desktop status line with them — like S1's rows, nothing
  // focusable and inert, and no stale error line, sits in the dimmed body.
  if (onQuickAction === undefined) return null;
  const desktopOpening = launchStatus.value.get(CLAUDE_DESKTOP_KEY)?.kind === "opening";
  // `Start a Claude Code session` is live only once the host wires a quick
  // switcher (plan 04-14); until then it takes the unavailable treatment
  // rather than sitting live and doing nothing (wave-5 finding 4).
  const live = LIVE_QUICK_ACTIONS.filter(
    (action) => switcherAvailable || !action.capability.startsWith("switcher:"),
  );
  const unavailable = switcherAvailable
    ? UNAVAILABLE_QUICK_ACTIONS
    : QUICK_ACTIONS.filter((action) => !live.includes(action));
  return (
    <>
      <div className="ccc-card-actions">
        {live.map((action) => {
          const opening = action.capability === "launch:claude-desktop" && desktopOpening;
          return (
            <button
              key={action.id}
              type="button"
              className="ccc-quick-action"
              aria-disabled={opening ? "true" : undefined}
              data-launch-state={opening ? "opening" : undefined}
              onClick={() => {
                // A second press while opening is ignored (UI-SPEC S2).
                if (!opening) onQuickAction(action);
              }}
            >
              {action.label}
            </button>
          );
        })}
      </div>
      <LaunchStatusLine
        projectId={null}
        projectName="Claude Desktop"
        terminalLabel={data.launchers["claude-code"].terminalLabel}
        actions={CLAUDE_DESKTOP_ACTIONS}
        onNavigate={onNavigate}
        openSystemSettings={openSystemSettings}
      />
      <p className="ccc-section-label ccc-section-label--muted">Not available yet</p>
      <div className="ccc-card-actions">
        {unavailable.map((action) => (
          <button
            key={action.id}
            type="button"
            className="ccc-quick-action"
            aria-disabled="true"
            // Still focusable and still dispatched: the dispatcher answers
            // with the existing "{label} isn't available yet." Notice.
            onClick={() => onQuickAction(action)}
          >
            {action.label}
          </button>
        ))}
      </div>
    </>
  );
}

export const quickActionsWidget: WidgetDefinition<QuickActionsData> = {
  id: "quick-actions",
  title: "Quick actions",
  description:
    "The six PRD §7.1 quick actions. Claude Code and Claude Desktop are live; each other action is enabled by the phase that owns it.",
  // RR-18: the skill registry returns with the skill-run phase; until then
  // the Source panel names only what this card actually reads.
  dataKeys: [{ key: "launchers.config", transport: "service", sourceLabel: "Launcher settings" }],
  refresh: { kind: "manual" },
  minSize: "small",
  preferredSize: "small",
  featureFlag: "widget.quick-actions",
  quickActions: QUICK_ACTIONS,
  actionsInBody: true,
  renderBody: QuickActionsBody,
  renderEmpty: () => null,
};
