import { HANDSHAKE_PATH, type HandshakeResponse } from "@ccc/domain";
import type { AuthenticatedSocketApiClient, EventClient } from "@ccc/service-api-client";
import {
  createApprovalsClient,
  createAuthenticatedClient,
  createEventClient,
  createSocketApiClient,
  createTasksClient,
  deleteUsageAnalytics,
  getClaudeIntegration,
  refreshProjects,
  setTranscriptAnalysis,
} from "@ccc/service-api-client";
import { Notice, Plugin, TFolder, type WorkspaceLeaf } from "obsidian";
import { wireApprovals } from "./approvals/wiring.js";
import { connectionState } from "./connection-state.js";
import { createHostRegistry, createObsidianHost, type HostRegistry } from "./host-registry.js";
import { attachOsMotionPreference } from "./motion.js";
import { registerSetUpLaunchersCommand } from "./projects/commands.js";
import { createPluginLauncher, type RequestLaunch } from "./projects/plugin-launcher.js";
import {
  combineOnLive,
  refreshProjectsOnConnect,
  startServiceEventsOnLayoutReady,
} from "./service-connection.js";
import {
  assertNoCredentialFields,
  assertNoPrivatePathValues,
  type CommandCenterSettings,
  DEFAULT_SETTINGS,
  mergeSettings,
} from "./settings.js";
import { createObsidianVaultSetupUi, registerVaultSetupCommand } from "./setup-command.js";
import { resolveSocketPath } from "./socket-path.js";
import { taskEditVault } from "./tasks/task-update.js";
import { wireTasks } from "./tasks/wiring.js";
import { listVaultWorkspaces } from "./tasks/workspaces.js";
import { CommandCenterView, VIEW_TYPE } from "./view/command-center-view.js";
import { openDeleteUsageModal as openDeleteUsageModalDialog } from "./view/delete-usage-modal.js";
import { createLaunchConflictChooser } from "./view/launch-conflict-choice.js";
import { configureNotify } from "./view/notify-port.js";
import { createPluginSwitcher } from "./view/plugin-switcher.js";
import {
  createSwitcherOpener,
  ProjectSwitcherModal,
  registerSwitcherCommand,
} from "./view/quick-switcher.js";
import { CommandCenterSettingTab } from "./view/settings-tab.js";
import { startClock } from "./widgets/clock.js";
import { createAdapterLayoutSource, startLayoutPolling } from "./widgets/layout-source.js";

/**
 * Structural markup and Obsidian's own CSS variables only in this phase —
 * the visual direction is selected in Phase 3 (UI-01/UI-02); this shell
 * must not pre-empt that gate. Every registration goes through
 * `hostRegistry` (never `this.registerView`/`addRibbonIcon`/`addCommand`
 * directly) so unload completeness is provable, not just assumed — see
 * `host-registry.ts` and the twenty-cycle proof in `lifecycle.test.ts`.
 */
/**
 * The OS reduced-motion query, written ONCE in the whole of production code
 * (D-19, A11Y-03). Every other module reads the already-resolved `motionMode`
 * signal; `motion.test.ts` walks the real source tree to keep that true as
 * widgets are added.
 */
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export default class ClaudeCommandCenterPlugin extends Plugin {
  settings: CommandCenterSettings = DEFAULT_SETTINGS;
  client!: AuthenticatedSocketApiClient;
  eventClient!: EventClient;
  /**
   * Opens the S9 quick-switcher with a query (PROJ-16). Every way in — the
   * palette command, the view's `Mod+K`, S8's `Start a Claude Code session`
   * — calls this one function, which attaches the event client first.
   */
  openSwitcher: (prefill: string) => void = () => {};
  /**
   * The plugin's one launch requester, shared by every command-center view
   * and the quick-switcher, so a launch outlives the view that started it
   * (codex review 3, finding 1). Built in `onload` before the view type is
   * registered; its timers are released on unload through the seam.
   */
  requestLaunch: RequestLaunch = () => {};
  /**
   * The one hook that runs each time the event stream goes live: projects,
   * approvals (and tasks) refresh together (plan 06-23). Built in `onload`;
   * the view and the switcher both attach the event client with it.
   */
  onServiceLive: () => void = () => {};
  private hostRegistry!: HostRegistry;

  async onload(): Promise<void> {
    await this.loadSettings();

    const socketPath = resolveSocketPath(this.settings.socketPathOverride);
    this.client = createAuthenticatedClient({ socketPath });

    // A separate, unauthenticated client purely for the event stream's own
    // token acquisition: the stream connection is long-lived and
    // hand-managed (ADR-0001), so it mints its own bearer token on every
    // connect/reconnect through the plain handshake route rather than
    // going through the JSON-response-shaped AuthenticatedSocketApiClient.
    const handshakeClient = createSocketApiClient({ socketPath });
    this.eventClient = createEventClient({
      socketPath,
      getToken: async () => {
        const res = await handshakeClient.request<HandshakeResponse>({
          method: "POST",
          path: HANDSHAKE_PATH,
        });
        return res.body.token;
      },
    });

    this.hostRegistry = createHostRegistry(createObsidianHost(this));
    // eventClient.dispose() is not an Obsidian host method at all -- routed
    // through registerRaw directly (host-registry.ts), so the subscription
    // is still torn down on unload regardless of whether the command-center
    // view is currently open.
    this.hostRegistry.registerRaw("eventStream", () => this.eventClient.dispose());

    // The one relative-time clock behind every card footer: a single
    // 60-second interval, registered through the seam so unload releases it
    // (threat T-03-07; counted in lifecycle.test.ts).
    startClock(this.hostRegistry);

    // The Overview's layout override file, watched live (UI-07, D-11): a
    // one-second stat poll of `<configDir>/plugins/<this plugin's id>/layout.json`
    // through the public DataAdapter, registered through the seam so unload
    // releases it (threat T-03-07; counted in lifecycle.test.ts). A file that
    // fails to parse keeps the previous layout rendering (D-13).
    startLayoutPolling({
      registry: this.hostRegistry,
      source: createAdapterLayoutSource(this.app.vault, this.manifest.id),
    });

    // The ONE place the OS reduced-motion query string is written in
    // production code (D-19, A11Y-03). Everything downstream reads the
    // resolved `motionMode` signal, which reaches CSS as a single
    // `data-motion` attribute on the command-center root -- no component
    // ever checks the preference itself. `motion.test.ts` walks the real
    // source tree to keep that true as widgets are added.
    attachOsMotionPreference(
      this.hostRegistry,
      () => this.settings.reducedMotion,
      window.matchMedia(REDUCED_MOTION_QUERY),
    );

    // One launch requester for the whole plugin: views and the switcher
    // share its deadlines and store holds (codex review 3, finding 1).
    this.requestLaunch = createPluginLauncher({
      registry: this.hostRegistry,
      client: this.client,
      notify: (message) => {
        new Notice(message);
      },
      // Start Claude Code shows the same four-choice modal as resume (D-29).
      chooseOnConflict: createLaunchConflictChooser(this.app, this.client),
    });

    this.hostRegistry.view(VIEW_TYPE, (leaf: WorkspaceLeaf) => new CommandCenterView(leaf, this));

    this.hostRegistry.ribbon("layout-dashboard", "Open command center", () => {
      void this.revealView();
    });

    this.hostRegistry.command({
      id: "open-overview",
      name: "Open overview",
      callback: () => {
        void this.revealView();
      },
    });

    // Obsidian's notice function is the one transient-message sink the views
    // reach (plan 06-10); removed again on unload through the registry.
    configureNotify((message) => {
      new Notice(message);
    });
    this.hostRegistry.cleanup(() => configureNotify(null));

    // Approvals (plan 06-23): the client from the authenticated connection,
    // the notifier, the ccc-approval link, the Open approval inbox command and
    // the reconnect refresh, every registration through the registry.
    const approvals = wireApprovals(this.hostRegistry, {
      client: createApprovalsClient(this.client),
      notice: (message) => {
        new Notice(message);
      },
      notifyEnabled: () => this.settings.notifyApprovals,
      appFocused: () => activeDocument.hasFocus(),
      reveal: () => {
        void this.revealView();
      },
      log: (message) => {
        console.warn(`[claude-command-center] ${message}`);
      },
      now: () => Date.now(),
    });
    // Tasks (plan 06-23): the client, the actions port over the Obsidian vault,
    // the vault watcher (after layout-ready), the Create task command and the
    // reconnect rescan, every registration through the registry.
    const editVault = taskEditVault(this.app.vault);
    const tasks = wireTasks(this.hostRegistry, {
      client: createTasksClient(this.client),
      // Explicit forwarding: a spread of the Vault instance would drop its prototype methods.
      vault: {
        process: (file, fn) => editVault.process(file, fn),
        read: (file) => editVault.read(file),
        getFileByPath: (path) => this.app.vault.getFileByPath(path),
      },
      openNote: (path) => {
        void this.app.workspace.openLinkText(path, "", false);
      },
      reveal: () => {
        void this.revealView();
      },
      now: () => Date.now(),
      listWorkspaces: () =>
        listVaultWorkspaces({
          folderChildren: (path) =>
            (this.app.vault.getFolderByPath(path)?.children ?? []).map((child) => ({
              name: child.name,
              isFolder: child instanceof TFolder,
            })),
          displayName: (indexPath) => {
            const file = this.app.vault.getFileByPath(indexPath);
            if (file === null) return undefined;
            const name: unknown =
              this.app.metadataCache.getFileCache(file)?.frontmatter?.displayName;
            return name;
          },
        }),
      log: (className) => {
        console.warn(`[claude-command-center] task watcher flush failed: ${className}`);
      },
    });
    this.onServiceLive = combineOnLive(
      refreshProjectsOnConnect(() => refreshProjects(this.client)),
      approvals.onLive,
      tasks.onLive,
    );

    // Subscribe to the service event stream at load (after layout-ready), not
    // only when a view opens, so approval notifications are live on cold start.
    // The stop function is released through the registry; the stream itself is
    // disposed by the "eventStream" registration above.
    this.hostRegistry.registerRaw(
      "eventStream",
      startServiceEventsOnLayoutReady({
        client: this.eventClient,
        onLive: this.onServiceLive,
        whenReady: (cb) => this.app.workspace.onLayoutReady(cb),
      }),
    );

    // The Settings tab, through the same seam as everything else so its
    // release on unload is counted rather than assumed (threat T-03-07).
    this.hostRegistry.settingTab(
      new CommandCenterSettingTab(this.app, this, {
        settings: this.settings,
        saveSettings: () => this.saveSettings(),
        mql: window.matchMedia(REDUCED_MOTION_QUERY),
        // The Claude section's service seam (UI-SPEC S5). Built from the
        // existing authenticated client -- the tab never reaches the
        // service any other way, and nothing here touches plugin settings.
        claude: {
          getIntegration: () => getClaudeIntegration(this.client),
          setTranscriptAnalysis: (enabled: boolean) => setTranscriptAnalysis(this.client, enabled),
          deleteUsageAnalytics: () => deleteUsageAnalytics(this.client),
          copyText: (text: string) => navigator.clipboard.writeText(text),
        },
        // The Approvals group: Send a test approval and its availability.
        approvals: {
          sendTestApproval: () => approvals.testAction.press(),
          serviceAvailable: () => connectionState.value.kind !== "disconnected",
        },
        // The Tasks group: Rebuild task index and its availability.
        tasks: {
          rebuildTaskIndex: () => tasks.rebuild(),
          serviceAvailable: () => connectionState.value.kind !== "disconnected",
        },
        // Row 6's confirmation modal (UI-SPEC S4-d). Behind the same seam
        // pattern as every other modal opener in this plugin.
        openDeleteUsageModal: (horizonDate: string | null, analysisOn: boolean) =>
          openDeleteUsageModalDialog(this.app, horizonDate, analysisOn),
      }),
    );

    // Vault setup (VAULT-01). Registered through the same seam as
    // everything else, and given the authenticated client — the plugin
    // never reaches the filesystem for this: it hands the service a path
    // and renders the plan the service sends back.
    registerVaultSetupCommand(this.hostRegistry, createObsidianVaultSetupUi(this.app), this.client);

    // The quick-switcher (PROJ-16, D-31 – D-34), from the palette with no
    // default hotkey (D-33). Opening it attaches the event client lazily, so
    // it lists the last-good projects even before the view was opened.
    // Its launches share the plugin launcher above (whose timers are
    // released on unload); a modal still open is closed through the seam,
    // after which a late choice does nothing (PLUG-03).
    const switcher = createPluginSwitcher({
      registry: this.hostRegistry,
      client: this.client,
      notify: (message) => {
        new Notice(message);
      },
      reveal: () => {
        void this.revealView();
      },
      openSwitcher: (prefill) => this.openSwitcher(prefill),
      requestLaunch: this.requestLaunch,
      openModal: (host, prefill, onClosed) => {
        const modal = new ProjectSwitcherModal(this.app, host, onClosed);
        modal.openWith(prefill);
        return modal;
      },
    });
    this.openSwitcher = createSwitcherOpener({
      eventClient: this.eventClient,
      onLive: this.onServiceLive,
      show: switcher.show,
    });
    registerSwitcherCommand(this.hostRegistry, this.openSwitcher);

    // Reruns launcher onboarding anytime: Settings › Launchers, focused (D-30).
    registerSetUpLaunchersCommand(this.hostRegistry, () => {
      void this.revealView();
    });
  }

  /**
   * Does not detach leaves — Obsidian's developer policy forbids it
   * because it discards the user's workspace layout. `disposeAll()`
   * returns this plugin's own registration bookkeeping to zero (Obsidian's
   * own `register*` sweep, which every `hostRegistry` call also triggers
   * internally, runs independently at the same moment) and also tears down
   * the event-stream subscription; `invalidateToken()` drops the cached
   * bearer token rather than leaving it live in memory past this plugin
   * instance's lifetime.
   */
  onunload(): void {
    this.hostRegistry.disposeAll();
    this.client.invalidateToken();
  }

  private async loadSettings(): Promise<void> {
    this.settings = mergeSettings(await this.loadData());
  }

  /** The plugin's only write path to Obsidian's plugin-data storage — always guarded (PLUG-07, D-43). */
  async saveSettings(): Promise<void> {
    assertNoCredentialFields(this.settings);
    assertNoPrivatePathValues(this.settings);
    await this.saveData(this.settings);
  }

  /**
   * The single entry point both the ribbon icon and the palette command
   * call — reveals an existing leaf of `VIEW_TYPE` if one exists, creating
   * one only when none does, so the two entry points can never produce two
   * views (PLUG-01).
   */
  async revealView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
  }
}
