import type { GithubTarget, LaunchersSummary, ProjectGitState } from "@ccc/domain";
import type { VNode } from "preact";
import type { DestinationId } from "../view/destinations.js";
import { launchersNeedSetup, SetupCallout } from "../view/setup-callout.js";
import type { WidgetBodyProps, WidgetDefinition } from "./contract.js";
import { ListBody } from "./list-body.js";

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

/** A number shown bare (`output 20`); unavailable reads `unavailable`. */
function amount(n: MaybeCount): string {
  return n === null ? "unavailable" : grouped(n);
}

/** Sentence case for a line assembled from mid-sentence pieces. */
function upperFirst(line: string): string {
  return line.charAt(0).toUpperCase() + line.slice(1);
}

// ---------------------------------------------------------------------------
// 1. Today (PRD §7.1.1) — permission-required behind `google`
// ---------------------------------------------------------------------------

export interface TodayEvent {
  readonly title: string;
  readonly startsAt: string;
}

export interface TodayTask {
  readonly title: string;
  readonly dueAt: string;
}

/**
 * Four independent sources (see `dataKeys`), any of which can be unreachable
 * while the others answer. A `null` list or count is "that source did not
 * say", rendered as unavailable — never an empty list that would read as
 * `0 tasks due` or as no failures.
 */
export interface TodayData {
  readonly nextEvent: TodayEvent | null;
  readonly remainingCount: MaybeCount;
  readonly dueTasks: readonly TodayTask[] | null;
  readonly overdueTasks: readonly TodayTask[] | null;
  readonly unreadSummary: string | null;
  readonly failures: readonly string[] | null;
}

function TodayBody({ data, size, onNavigate }: WidgetBodyProps<TodayData>): VNode {
  return (
    <>
      <p className="ccc-state-body ccc-clamp-2">
        {data.nextEvent === null ? "Nothing else on the calendar today." : data.nextEvent.title}
      </p>
      <p className="ccc-state-body">
        {upperFirst(
          [
            count(
              data.remainingCount,
              "commitment left",
              "commitments left",
              "commitments unavailable",
            ),
            count(data.dueTasks?.length ?? null, "task due", "tasks due", "due tasks unavailable"),
            count(data.overdueTasks?.length ?? null, "overdue task", "overdue tasks"),
          ].join(" · "),
        )}
      </p>
      <ListBody<TodayTask>
        rows={[...(data.overdueTasks ?? []), ...(data.dueTasks ?? [])]}
        size={size}
        keyOf={(task) => `${task.dueAt}-${task.title}`}
        renderPrimary={(task) => task.title}
        renderMeta={(task) => `Due ${task.dueAt}`}
        moreDestination="tasks"
        onMore={onNavigate}
      />
      {data.unreadSummary === null ? null : (
        <p className="ccc-state-body ccc-clamp-2">{data.unreadSummary}</p>
      )}
      {data.failures === null ? (
        <p className="ccc-state-body">Failure status unavailable</p>
      ) : data.failures.length === 0 ? null : (
        <p className="ccc-state-body">
          {count(data.failures.length, "failure needs attention", "failures need attention")}
        </p>
      )}
    </>
  );
}

export const todayWidget: WidgetDefinition<TodayData> = {
  id: "today",
  title: "Today",
  description: "Calendar, tasks, mail and failures for today. Filled in by phases 6 and 7.",
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
  renderEmpty: () => <p className="ccc-state-body">Nothing is scheduled or due today.</p>,
};

// ---------------------------------------------------------------------------
// 2. Active Claude sessions (PRD §7.1.2) — unavailable until Phase 5
// ---------------------------------------------------------------------------

export type SessionStatus =
  | "running"
  | "waiting-for-approval"
  | "recently-completed"
  | "failed"
  | "unknown";

export interface SessionRow {
  readonly id: string;
  readonly project: string;
  readonly name: string;
  readonly model: string | null;
  readonly elapsed: string;
  readonly lastActivity: string;
  readonly status: SessionStatus;
}

export interface ActiveSessionsData {
  readonly rows: readonly SessionRow[];
}

function ActiveSessionsBody({
  data,
  size,
  onNavigate,
}: WidgetBodyProps<ActiveSessionsData>): VNode | null {
  return (
    <ListBody<SessionRow>
      rows={data.rows}
      size={size}
      keyOf={(row) => row.id}
      renderPrimary={(row) => `${row.project} · ${row.name}`}
      renderMeta={(row) => `${row.status} · ${row.elapsed} · ${row.lastActivity}`}
      moreDestination="agent-runs"
      onMore={onNavigate}
    />
  );
}

export const activeSessionsWidget: WidgetDefinition<ActiveSessionsData> = {
  id: "active-sessions",
  title: "Active Claude sessions",
  description: "Running, waiting, completed and failed sessions. Filled in by phase 5.",
  dataKeys: [{ key: "sessions.active", transport: "service", sourceLabel: "Claude Code hooks" }],
  refresh: { kind: "event-driven" },
  minSize: "medium",
  preferredSize: "tall",
  featureFlag: "widget.active-sessions",
  quickActions: [],
  renderBody: ActiveSessionsBody,
  renderEmpty: () => <p className="ccc-state-body">No sessions are running right now.</p>,
};

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
 * copy", Glyph Vocabulary). A failed read appends `◔ Stale` regardless of
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
    segments.push({ glyph: "◔", text: "Stale" });
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
}: WidgetBodyProps<ProjectShortcutsData>): VNode | null {
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
// 4. Claude usage (PRD §7.1.4) — unavailable until Phase 5
// ---------------------------------------------------------------------------

export interface UsageBar {
  readonly label: string;
  readonly used: MaybeCount;
  readonly limit: MaybeCount;
}

export interface UsageTokens {
  readonly input: MaybeCount;
  readonly output: MaybeCount;
  readonly cache: MaybeCount;
}

export interface ClaudeUsageData {
  readonly bars: readonly UsageBar[];
  readonly tokens: UsageTokens;
  /**
   * Always rendered as an ESTIMATE — subscription spend is the plan price.
   * `null` is an estimate that could not be computed, and reads unavailable.
   */
  readonly estimate: string | null;
}

function ClaudeUsageBody({ data }: { readonly data: ClaudeUsageData }): VNode {
  return (
    <>
      <ul className="ccc-list">
        {data.bars.map((bar) => (
          <li className="ccc-list-row" key={bar.label}>
            <p className="ccc-list-primary">{bar.label}</p>
            <p className="ccc-list-meta">
              {/* An unknown limit reads `unavailable`, never zero — the
                  data-integrity rule in the project constraints. */}
              {bar.used === null || bar.limit === null
                ? "Capacity unavailable"
                : `${grouped(bar.used)} of ${grouped(bar.limit)}`}
            </p>
          </li>
        ))}
      </ul>
      <p className="ccc-state-body">
        {`Input ${amount(data.tokens.input)} · output ${amount(data.tokens.output)} · cache ${amount(
          data.tokens.cache,
        )}`}
      </p>
      <p className="ccc-state-body">
        {data.estimate === null
          ? "Estimated API-equivalent cost unavailable"
          : `Estimated API-equivalent cost: ${data.estimate}`}
      </p>
    </>
  );
}

export const claudeUsageWidget: WidgetDefinition<ClaudeUsageData> = {
  id: "claude-usage",
  title: "Claude usage",
  description: "Plan capacity, token activity and an estimated cost. Filled in by phase 5.",
  dataKeys: [{ key: "usage.rollup", transport: "service", sourceLabel: "Claude usage collector" }],
  refresh: { kind: "interval", everyMs: 300_000 },
  minSize: "medium",
  preferredSize: "wide",
  featureFlag: "widget.claude-usage",
  quickActions: [],
  renderBody: ClaudeUsageBody,
  renderEmpty: () => <p className="ccc-state-body">No usage has been recorded yet.</p>,
};

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
// 7. Quick actions (PRD §7.1.7) — unavailable until its actions' phases land
// ---------------------------------------------------------------------------

/**
 * This panel has no body: its content IS its `quickActions`, which the shared
 * frame renders (and which `dispatchQuickAction` refuses to execute in this
 * phase). The descriptors are declared now so Phase 6's approval engine has a
 * capability to classify before there is anything to approve.
 */
export type QuickActionsData = Record<string, never>;

export const quickActionsWidget: WidgetDefinition<QuickActionsData> = {
  id: "quick-actions",
  title: "Quick actions",
  description: "The six PRD §7.1 quick actions. Each is enabled by the phase that owns it.",
  dataKeys: [{ key: "skills.registry", transport: "service", sourceLabel: "Skill registry" }],
  refresh: { kind: "manual" },
  minSize: "small",
  preferredSize: "small",
  featureFlag: "widget.quick-actions",
  quickActions: [
    { id: "run-skill", label: "Run a skill", capability: "skill:run" },
    { id: "start-session", label: "Start a Claude Code session", capability: "session:start" },
    { id: "create-task", label: "Create a task", capability: "task:create" },
    { id: "capture-note", label: "Capture an inbox note", capability: "note:capture" },
    { id: "refresh-data", label: "Refresh selected data", capability: "data:refresh" },
    { id: "open-claude-desktop", label: "Open Claude Desktop", capability: "app:open" },
  ],
  renderBody: () => null,
  renderEmpty: () => null,
};
