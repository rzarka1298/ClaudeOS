/**
 * Spike S0 (05.2-01): does the installed Obsidian start in a private profile, load the
 * built plugin, open the generated vault and report what the renderer can see? Orchestrator
 * run only (D-15). It touches the synthetic vault only, writes one page screenshot into the
 * screenshot folder, prints key names (never values) and never prints note content.
 */
import { join } from "node:path";
import { browser } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import { evaluateSocketIsolation } from "../src/vault-plugin-data.js";
import { readIsolationFacts } from "./isolation-facts.js";

interface RendererFacts {
  pluginId: string | null;
  pluginVersion: string | null;
  commandIds: string[];
  socketPathSeenByRenderer: string | null;
  hasFocus: boolean;
  notificationPermission: string;
}

const PLUGIN_ID = "claude-command-center";

describe("S0 smoke: sandbox launch with the installed app", () => {
  it("prints the plugin, the commands and the renderer facts and writes a page screenshot", async () => {
    try {
      const facts: RendererFacts = await browser.executeObsidian(({ app, plugins }) => {
        const plugin = plugins.claudeCommandCenter;
        const registry = (
          app as unknown as { commands: { listCommands(): Array<{ id: string }> } }
        ).commands.listCommands();
        return {
          pluginId: plugin?.manifest.id ?? null,
          pluginVersion: plugin?.manifest.version ?? null,
          commandIds: registry
            .map((c) => c.id)
            .filter((id) => id.startsWith("claude-command-center:")),
          socketPathSeenByRenderer:
            typeof process === "undefined" ? null : (process.env.CCC_SOCKET_PATH ?? null),
          hasFocus: document.hasFocus(),
          notificationPermission: Notification.permission,
        };
      });

      const configDir = await obsidianPage.getConfigDir();
      let dataJsonKeys: string[] | string = "missing";
      try {
        const raw = await obsidianPage.read(`${configDir}/plugins/${PLUGIN_ID}/data.json`);
        dataJsonKeys = Object.keys(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        dataJsonKeys = "missing";
      }

      // Fail loudly unless the plugin provably talks to the run-root socket: the renderer must see
      // CCC_SOCKET_PATH equal to it and the persisted socketPathOverride must not differ.
      const isolation = evaluateSocketIsolation(await readIsolationFacts());
      if (!isolation.ok) {
        throw new Error(`Socket isolation not proven: ${isolation.reason}.`);
      }

      const shotsDir = process.env.CCC_UAT_SHOTS_DIR ?? "";
      const shotPath = join(shotsDir, "s0-page.png");
      await browser.saveScreenshot(shotPath);

      const evidence = {
        ...facts,
        appVersion: browser.getObsidianVersion(),
        installerVersion: browser.getObsidianInstallerVersion(),
        dataJsonKeys,
        socketIsolation: isolation.reason,
        screenshot: shotPath,
      };
      console.log(`SPIKE-RESULT S0 pass ${JSON.stringify(evidence)}`);
    } catch (error) {
      console.log(
        `SPIKE-RESULT S0 fail ${error instanceof Error ? error.message : "unknown error"}`,
      );
      throw error;
    }
  });
});
