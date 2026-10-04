import type { LaunchAction, ProjectId, ProjectsSnapshot, ProjectView } from "@ccc/domain";
import { compareProjectViews, nextFreeDisplayName } from "@ccc/domain/browser";
import type { EventClient } from "@ccc/service-api-client";
import { type App, FuzzySuggestModal, type Instruction, type Modifier } from "obsidian";
import type { ConnectionState } from "../connection-state.js";
import type { HostRegistry } from "../host-registry.js";
import {
  launchAnnouncement,
  launchErrorNotice,
  launcherDisplayName,
} from "../projects/launch-copy.js";
import { launchStatus, launchStatusKey, setLaunchError } from "../projects/launch-status.js";
import { attachEventClient } from "../service-connection.js";
import type { QuickActionDescriptor } from "../widgets/contract.js";
import {
  CLAUDE_DESKTOP_PHRASE,
  launchPhrase,
  PROJECT_LAUNCH_ACTIONS,
} from "../widgets/launch-toolbar.js";
import { dispatchQuickAction, type QuickActionContext } from "../widgets/quick-actions.js";
import { DESTINATIONS, type DestinationId } from "./destinations.js";

/**
 * The S9 quick-switcher (PROJ-16, D-31 – D-34): Obsidian's own
 * `FuzzySuggestModal` over one flat list of every destination, every
 * registered project, every project × action pair and Claude Desktop.
 *
 * Items carry DATA, never callbacks. A launch item carries the same
 * `launch:*` descriptor the S2 toolbar emits, and choosing it hands that
 * descriptor to {@link dispatchQuickAction} — the one choke point Phase 6's
 * approval check goes into (D-24, T-04-15). Navigation items go to
 * `SwitcherHost.goTo`, which only ever moves the command center between its
 * own destinations.
 *
 * `getItemText` returns plain text; Obsidian renders it as text with its own
 * match highlighting (T-04-12). This is a host-UI file: it may import from
 * `obsidian`, which no widget does.
 */

export const SWITCHER_COMMAND_ID = "search-projects-and-actions";
/** RR-22: avoids Obsidian's own "Quick switcher" name and the word "command". */
const SWITCHER_COMMAND_NAME = "Search projects and actions";

const SWITCHER_PLACEHOLDER = "Search projects, actions and views";
const SWITCHER_INSTRUCTIONS: Instruction[] = [
  { command: "↑↓", purpose: "to navigate" },
  { command: "↵", purpose: "to choose" },
  { command: "esc", purpose: "to dismiss" },
];
const EMPTY_WITH_PROJECTS = "No projects, actions or views match.";
const EMPTY_WITHOUT_PROJECTS = "No projects registered yet. Register one in Projects.";
/** The S9 suffix for a GitHub action with nowhere to go (RR-17). */
const NO_GITHUB_REMOTE_SUFFIX = " — no GitHub remote";

export type SwitcherItem =
  | { readonly kind: "destination"; readonly text: string; readonly destination: DestinationId }
  | { readonly kind: "project"; readonly text: string; readonly projectId: ProjectId }
  | {
      readonly kind: "launch";
      readonly text: string;
      readonly action: LaunchAction;
      /** `null` only for `claude-desktop` (D-06). */
      readonly projectId: ProjectId | null;
      readonly projectName: string | null;
      readonly descriptor: QuickActionDescriptor;
      /** The GitHub action of a project with no GitHub target: listed, never sent (RR-17). */
      readonly noGithubRemote: boolean;
    };

/**
 * What the modal may reach of its host. The plugin builds it once
 * (`main.ts`): `goTo` reveals the command center on a destination,
 * `requestLaunch` is a launch requester whose timers the plugin releases on
 * unload, and `openSwitcher` reopens this modal (for S8's prefill).
 */
export interface SwitcherHost {
  /** The last-good projects, memory only (D-43) — `undefined` before any arrived. */
  snapshot(): ProjectsSnapshot | undefined;
  connection(): ConnectionState;
  notify(message: string): void;
  goTo(destination: DestinationId, focusProjectId?: ProjectId): void;
  requestLaunch(projectId: ProjectId | null, action: LaunchAction): void;
  openSwitcher(prefill: string): void;
}

/**
 * The name each project goes by in the switcher. Display names are not
 * unique — a rename can repeat one — and two identical `Go to` items cannot
 * be told apart. The first project (by ProjectId, whose leading part is its
 * registration time, so pins and opens never reshuffle it) keeps the name;
 * each later one gets the next free ordinal, `name (2)`, `name (3)`, …,
 * skipping any another project already carries. Never a path segment
 * (UI-SPEC privacy rule 1).
 */
export function switcherNames(views: readonly ProjectView[]): Map<ProjectId, string> {
  const taken = new Set(views.map((view) => view.displayName));
  const seen = new Set<string>();
  const names = new Map<ProjectId, string>();
  const byId = [...views].sort((a, b) =>
    a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0,
  );
  for (const view of byId) {
    if (!seen.has(view.displayName)) {
      seen.add(view.displayName);
      names.set(view.projectId, view.displayName);
      continue;
    }
    const name = nextFreeDisplayName(view.displayName, taken);
    taken.add(name);
    names.set(view.projectId, name);
  }
  return names;
}

function projectItems(view: ProjectView, name: string): SwitcherItem[] {
  const items: SwitcherItem[] = [
    { kind: "project", text: `Go to ${name}`, projectId: view.projectId },
  ];
  for (const action of PROJECT_LAUNCH_ACTIONS) {
    const phrase = launchPhrase(action, name);
    // Enabled when the remote's host is github.com or an override link is
    // set (D-13) — both arrive as `kind: "github"`, as in the S2 toolbar.
    const noGithubRemote = action === "github" && view.github.kind !== "github";
    items.push({
      kind: "launch",
      text: noGithubRemote ? `${phrase}${NO_GITHUB_REMOTE_SUFFIX}` : phrase,
      action,
      projectId: view.projectId,
      projectName: name,
      descriptor: {
        id: `launch-${action}`,
        label: phrase,
        capability: `launch:${action}`,
        target: { projectId: view.projectId },
      },
      noGithubRemote,
    });
  }
  return items;
}

const CLAUDE_DESKTOP_ITEM: SwitcherItem = {
  kind: "launch",
  text: CLAUDE_DESKTOP_PHRASE,
  action: "claude-desktop",
  projectId: null,
  projectName: null,
  descriptor: {
    id: "open-claude-desktop",
    label: CLAUDE_DESKTOP_PHRASE,
    capability: "launch:claude-desktop",
  },
  noGithubRemote: false,
};

const DESTINATION_ITEMS: readonly SwitcherItem[] = DESTINATIONS.map((destination) => ({
  kind: "destination",
  text: `Go to ${destination.label}`,
  destination: destination.id,
}));

/**
 * The S9 list in its empty-query order (D-32): each pinned project's
 * `Go to` and four actions (S1 order), then `Open Claude Desktop`, then the
 * eight destinations in `DESTINATIONS` order, then each unpinned project's
 * five. With a query Obsidian's fuzzy score decides and ties keep this order.
 *
 * Pure, and built from whatever is in memory: while disconnected the
 * last-good projects are listed exactly as they were, and with none ever
 * received only the destinations and `Open Claude Desktop` (D-34). The
 * connection decides what a CHOSEN launch does, not what is listed.
 */
export function buildSwitcherItems(snapshot: ProjectsSnapshot | undefined): SwitcherItem[] {
  // The one PROJ-15 comparator S1 and S3 use, so "S1 order" holds here too.
  const views = snapshot === undefined ? [] : [...snapshot.projects].sort(compareProjectViews);
  const names = switcherNames(views);
  const itemsOf = (view: ProjectView): SwitcherItem[] =>
    projectItems(view, names.get(view.projectId) ?? view.displayName);
  return [
    ...views.filter((view) => view.pinned).flatMap(itemsOf),
    CLAUDE_DESKTOP_ITEM,
    ...DESTINATION_ITEMS,
    ...views.filter((view) => !view.pinned).flatMap(itemsOf),
  ];
}

function terminalLabelOf(snapshot: ProjectsSnapshot | undefined): string {
  return snapshot?.launchers["claude-code"].terminalLabel ?? "Terminal";
}

/**
 * What choosing an item does. Navigation goes to the host; a launch goes to
 * the dispatcher. A launch the requester will refuse at once (the service is
 * disconnected) or ignore (the same launch is already in flight) gets no
 * acknowledgement: its own Notice, or the one already posted, is the answer.
 */
export function chooseSwitcherItem(item: SwitcherItem, host: SwitcherHost): void {
  if (item.kind === "destination") {
    host.goTo(item.destination);
    return;
  }
  if (item.kind === "project") {
    host.goTo("projects", item.projectId);
    return;
  }

  const snapshot = host.snapshot();
  const terminal = terminalLabelOf(snapshot);
  const key = launchStatusKey(item.projectId, item.action);

  if (item.noGithubRemote) {
    // Exactly what the S2 GitHub button does with nowhere to go: say why,
    // and send nothing (UI-SPEC S2).
    setLaunchError(key, "no-github-remote");
    host.notify(
      launchErrorNotice("no-github-remote", {
        launcher: launcherDisplayName(item.action),
        terminal,
        project: item.projectName,
      }),
    );
    return;
  }

  const willSend =
    host.connection().kind !== "disconnected" && launchStatus.value.get(key)?.kind !== "opening";
  if (willSend) host.notify(launchAnnouncement(item.action, terminal, item.projectName ?? ""));

  const ctx: QuickActionContext = {
    navigate: (destination) => host.goTo(destination),
    notify: (message) => host.notify(message),
    requestLaunch: (projectId, action) => host.requestLaunch(projectId, action),
    openSwitcher: (prefill) => host.openSwitcher(prefill),
  };
  dispatchQuickAction(item.descriptor, ctx);
}

/**
 * Obsidian's `FuzzySuggestModal`, implementing only `getItems`,
 * `getItemText` and `onChooseItem` (D-31). Items are rebuilt from the
 * in-memory last-good data each time Obsidian asks, synchronously — there is
 * no loading state (S9).
 */
export class ProjectSwitcherModal extends FuzzySuggestModal<SwitcherItem> {
  private readonly host: SwitcherHost;
  private readonly onClosed: (() => void) | undefined;

  /** `onClosed` lets the plugin stop tracking the modal once it closes (wave-7 finding 2). */
  constructor(app: App, host: SwitcherHost, onClosed?: () => void) {
    super(app);
    this.host = host;
    this.onClosed = onClosed;
    this.setPlaceholder(SWITCHER_PLACEHOLDER);
    this.setInstructions(SWITCHER_INSTRUCTIONS);
    this.emptyStateText = EMPTY_WITHOUT_PROJECTS;
  }

  getItems(): SwitcherItem[] {
    const snapshot = this.host.snapshot();
    const items = buildSwitcherItems(snapshot);
    this.emptyStateText =
      snapshot !== undefined && snapshot.projects.length > 0
        ? EMPTY_WITH_PROJECTS
        : EMPTY_WITHOUT_PROJECTS;
    // Every project × action pair stays reachable (D-32): Obsidian scrolls
    // its own list rather than cutting it at the default limit.
    this.limit = items.length;
    return items;
  }

  getItemText(item: SwitcherItem): string {
    return item.text;
  }

  onChooseItem(item: SwitcherItem, _evt: MouseEvent | KeyboardEvent): void {
    chooseSwitcherItem(item, this.host);
  }

  override onClose(): void {
    super.onClose();
    this.onClosed?.();
  }

  /**
   * Opens the modal, then — for S8's `Start Claude Code in ` — writes the
   * query into Obsidian's own input and fires `input`, which is how the
   * modal re-runs its search.
   */
  openWith(prefill: string): void {
    this.open();
    if (prefill === "") return;
    this.inputEl.value = prefill;
    this.inputEl.dispatchEvent(new Event("input"));
  }
}

export interface SwitcherOpenerOptions {
  /** The plugin's one event client, attached lazily on first open (PR-09). */
  readonly eventClient: EventClient;
  /** Passed through to `attachEventClient` — the view passes the same one. */
  readonly onLive?: (() => void) | undefined;
  /** Shows the modal with the given query. */
  readonly show: (prefill: string) => void;
}

/**
 * Every way into the switcher — the command, the view's `Mod+K`, S8's
 * `Start a Claude Code session` — goes through this. It attaches the event
 * client first (idempotent: a still-live subscription is only re-pointed),
 * so a switcher opened from the palette before the command center was ever
 * opened still receives the projects (D-34, PR-09).
 */
export function createSwitcherOpener({
  eventClient,
  onLive,
  show,
}: SwitcherOpenerOptions): (prefill: string) => void {
  return (prefill) => {
    attachEventClient(eventClient, onLive === undefined ? {} : { onLive });
    show(prefill);
  };
}

/**
 * Registers `Search projects and actions` through the host-registry seam,
 * with no default hotkey (D-33, `obsidianmd/commands/no-default-hotkeys`).
 * `lifecycle.test.ts` calls THIS function, not a stand-in.
 */
export function registerSwitcherCommand(
  registry: HostRegistry,
  open: (prefill: string) => void,
): void {
  registry.command({
    id: SWITCHER_COMMAND_ID,
    name: SWITCHER_COMMAND_NAME,
    callback: () => open(""),
  });
}

/** The part of Obsidian's `Scope` this needs (`Scope.register`, obsidian.d.ts). */
export interface SwitcherScope {
  register(modifiers: Modifier[], key: string, func: () => false): unknown;
}

/**
 * Binds `Mod+K` (⌘K on macOS) on the command-center view's OWN scope, so it
 * is live only while the view has focus and is released with the view
 * (D-33). It is not a command hotkey — no default global hotkey exists for
 * any Phase 4 command (`obsidianmd/commands/no-default-hotkeys`). Returning
 * `false` tells Obsidian to prevent the key's default.
 */
export function registerSwitcherScope(scope: SwitcherScope, open: () => void): void {
  scope.register(["Mod"], "k", () => {
    open();
    return false;
  });
}
