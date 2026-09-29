import { HANDSHAKE_PATH, type HandshakeResponse } from "@ccc/domain";
import type { AuthenticatedSocketApiClient, EventClient } from "@ccc/service-api-client";
import {
  createAuthenticatedClient,
  createEventClient,
  createSocketApiClient,
  deleteUsageAnalytics,
  getClaudeIntegration,
  setTranscriptAnalysis,
} from "@ccc/service-api-client";
import { Plugin, type WorkspaceLeaf } from "obsidian";
import { createHostRegistry, createObsidianHost, type HostRegistry } from "./host-registry.js";
import { attachOsMotionPreference } from "./motion.js";
import {
  assertNoCredentialFields,
  type CommandCenterSettings,
  DEFAULT_SETTINGS,
} from "./settings.js";
import { createObsidianVaultSetupUi, registerVaultSetupCommand } from "./setup-command.js";
import { resolveSocketPath } from "./socket-path.js";
import { CommandCenterView, VIEW_TYPE } from "./view/command-center-view.js";
import { openDeleteUsageModal as openDeleteUsageModalDialog } from "./view/delete-usage-modal.js";
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
        // Row 6's confirmation modal (UI-SPEC S4-d). Behind the same seam
        // pattern as every other modal opener in this plugin.
        openDeleteUsageModal: (horizonDate: string | null) =>
          openDeleteUsageModalDialog(this.app, horizonDate),
      }),
    );

    // Vault setup (VAULT-01). Registered through the same seam as
    // everything else, and given the authenticated client — the plugin
    // never reaches the filesystem for this: it hands the service a path
    // and renders the plan the service sends back.
    registerVaultSetupCommand(this.hostRegistry, createObsidianVaultSetupUi(this.app), this.client);
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
    const loaded = (await this.loadData()) as Partial<CommandCenterSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...loaded };
  }

  /** The plugin's only write path to Obsidian's plugin-data storage — always guarded (PLUG-07). */
  async saveSettings(): Promise<void> {
    assertNoCredentialFields(this.settings);
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
