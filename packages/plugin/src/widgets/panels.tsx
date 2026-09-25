import type { VNode } from "preact";
import type { WidgetDefinition } from "./contract.js";

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

/** `n` with a plural-safe noun: never `1 items` (UI-SPEC zero-one-many row). */
function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
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

export interface TodayData {
  readonly nextEvent: TodayEvent | null;
  readonly remainingCount: number;
  readonly dueTasks: readonly TodayTask[];
  readonly overdueTasks: readonly TodayTask[];
  readonly unreadSummary: string | null;
  readonly failures: readonly string[];
}

function TodayBody({ data }: { readonly data: TodayData }): VNode {
  return (
    <>
      <p className="ccc-state-body ccc-clamp-2">
        {data.nextEvent === null ? "Nothing else on the calendar today." : data.nextEvent.title}
      </p>
      <p className="ccc-state-body">
        {count(data.remainingCount, "commitment left", "commitments left")} ·{" "}
        {count(data.dueTasks.length, "task due", "tasks due")} ·{" "}
        {count(data.overdueTasks.length, "overdue task", "overdue tasks")}
      </p>
      {data.unreadSummary === null ? null : (
        <p className="ccc-state-body ccc-clamp-2">{data.unreadSummary}</p>
      )}
      {data.failures.length === 0 ? null : (
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

function ActiveSessionsBody({ data }: { readonly data: ActiveSessionsData }): VNode {
  return (
    <ul className="ccc-list">
      {data.rows.map((row) => (
        <li className="ccc-list-row" key={row.id}>
          <p className="ccc-list-primary ccc-clamp-2">{`${row.project} · ${row.name}`}</p>
          <p className="ccc-list-meta">{`${row.status} · ${row.elapsed} · ${row.lastActivity}`}</p>
        </li>
      ))}
    </ul>
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
  readonly branch: string;
  readonly dirty: boolean;
  readonly openItems: number;
  readonly sessionCount: number;
  readonly nextTask: string | null;
}

export interface ProjectShortcutsData {
  readonly projects: readonly ProjectRow[];
}

function ProjectShortcutsBody({ data }: { readonly data: ProjectShortcutsData }): VNode {
  return (
    <ul className="ccc-list">
      {data.projects.map((project) => (
        <li className="ccc-list-row" key={project.id}>
          <p className="ccc-list-primary ccc-clamp-2">{project.name}</p>
          <p className="ccc-list-meta">
            {`${project.branch}${project.dirty ? " · uncommitted changes" : ""} · ${count(
              project.openItems,
              "open item",
              "open items",
            )}`}
          </p>
        </li>
      ))}
    </ul>
  );
}

export const projectShortcutsWidget: WidgetDefinition<ProjectShortcutsData> = {
  id: "project-shortcuts",
  title: "Project shortcuts",
  description: "Pinned projects, their branch state and one-click actions. Filled in by phase 4.",
  dataKeys: [
    { key: "projects.registered", transport: "service", sourceLabel: "Project registry" },
    { key: "projects.git-status", transport: "service", sourceLabel: "Local git status" },
  ],
  refresh: { kind: "interval", everyMs: 30_000 },
  minSize: "small",
  preferredSize: "medium",
  featureFlag: "widget.project-shortcuts",
  quickActions: [],
  renderBody: ProjectShortcutsBody,
  renderEmpty: () => <p className="ccc-state-body">No projects are registered yet.</p>,
};

// ---------------------------------------------------------------------------
// 4. Claude usage (PRD §7.1.4) — unavailable until Phase 5
// ---------------------------------------------------------------------------

export interface UsageBar {
  readonly label: string;
  readonly used: number;
  readonly limit: number | null;
}

export interface UsageTokens {
  readonly input: number;
  readonly output: number;
  readonly cache: number;
}

export interface ClaudeUsageData {
  readonly bars: readonly UsageBar[];
  readonly tokens: UsageTokens;
  /** Always rendered as an ESTIMATE — subscription spend is the plan price. */
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
              {bar.limit === null ? "Capacity unavailable" : `${bar.used} of ${bar.limit}`}
            </p>
          </li>
        ))}
      </ul>
      <p className="ccc-state-body">
        {`Input ${data.tokens.input} · output ${data.tokens.output} · cache ${data.tokens.cache}`}
      </p>
      {data.estimate === null ? null : (
        <p className="ccc-state-body">{`Estimated API-equivalent cost: ${data.estimate}`}</p>
      )}
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
  readonly sourceCount: number;
}

export interface TechIntelData {
  readonly stories: readonly IntelStory[];
  readonly marketSummary: string | null;
}

function TechIntelBody({ data }: { readonly data: TechIntelData }): VNode {
  return (
    <>
      <ul className="ccc-list">
        {data.stories.map((story) => (
          <li className="ccc-list-row" key={story.id}>
            <p className="ccc-list-primary ccc-clamp-2">{story.headline}</p>
            <p className="ccc-list-meta">
              {`${story.category} · ${count(story.sourceCount, "source", "sources")}`}
            </p>
          </li>
        ))}
      </ul>
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
  readonly stars: number;
  readonly growth: string;
  readonly reason: string;
}

export interface GithubDiscoveriesData {
  readonly repos: readonly DiscoveredRepo[];
}

function GithubDiscoveriesBody({ data }: { readonly data: GithubDiscoveriesData }): VNode {
  return (
    <ul className="ccc-list">
      {data.repos.map((repo) => (
        <li className="ccc-list-row" key={repo.id}>
          <p className="ccc-list-primary ccc-clamp-2">{repo.name}</p>
          <p className="ccc-list-meta">
            {`${count(repo.stars, "star", "stars")} · ${repo.growth} · ${repo.reason}`}
          </p>
        </li>
      ))}
    </ul>
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
