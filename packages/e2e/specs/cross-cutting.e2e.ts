/**
 * Cross-cutting UAT items of Phase 6 (05.2-08): the privacy check (25). Later tasks add 23, 12,
 * 20 and 22 ahead of it; 25 stays LAST so the service log has content to search.
 *
 * Authored and CI-checked only (D-15): typecheck, lint and the static guard run in CI; the live
 * run is the orchestrator's baseline in plan 05.2-09. Everything touches the synthetic vault and
 * the throwaway service inside the run root.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { browser, expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import {
  assertSandboxConnected,
  type DriverBrowser,
  parseCountInWords,
  pollUntil,
  runPluginCommand,
} from "../src/driver.js";
import { installConsoleCapture } from "../src/renderer-spies.js";
import { installResultRecorder, type RecorderOptions } from "../src/results.js";
import { loadRunContext, type RunContext, serviceFixtureFor } from "../src/spec-context.js";
import {
  commandId,
  PLUGIN_ID,
  SEND_TEST_APPROVAL_NAME,
  SETUP_CONFIRM_LABEL,
  SYNTHETIC_MARKERS,
} from "../src/spec-support/cross-copy.js";
import { checkPluginDataKeys, countOccurrences } from "../src/spec-support/cross-support.js";

const asDriver = (): DriverBrowser => browser as unknown as DriverBrowser;

let context: RunContext;
const service = (() => {
  let fixture: ReturnType<typeof serviceFixtureFor> | undefined;
  return {
    get(): ReturnType<typeof serviceFixtureFor> {
      if (fixture === undefined) fixture = serviceFixtureFor(context);
      return fixture;
    },
  };
})();

/** Presses a tab of the command center by its destination id. */
async function openDestination(id: string): Promise<void> {
  await pollUntil(
    () => browser.execute((tab: string) => document.getElementById(`ccc-tab-${tab}`) !== null, id),
    { timeoutMs: 15_000, intervalMs: 250, describe: `the ${id} tab` },
  );
  await browser.execute((tab: string) => {
    (document.getElementById(`ccc-tab-${tab}`) as HTMLElement).click();
  }, id);
}

/** Opens the plugin's settings tab and presses the named row's button; false when there is none. */
async function pressSettingsButton(name: string): Promise<boolean> {
  return browser.executeObsidian(({ app }, rowName: string) => {
    const setting = (app as unknown as { setting: { open(): void; openTabById(id: string): void } })
      .setting;
    setting.open();
    setting.openTabById("claude-command-center");
    const row = Array.from(document.querySelectorAll(".setting-item")).find(
      (el) => el.querySelector(".setting-item-name")?.textContent?.trim() === rowName,
    );
    const button = row?.querySelector("button") ?? null;
    button?.click();
    return button !== null;
  }, name);
}

/** Closes the settings dialog so the command-center view is the page. */
async function closeSettings(): Promise<void> {
  await browser.executeObsidian(({ app }) => {
    (app as unknown as { setting: { close(): void } }).setting.close();
  });
}

before(async function startRun() {
  context = loadRunContext();
  installResultRecorder({
    afterEach: afterEach as unknown as RecorderOptions["afterEach"],
    resultsPath: context.paths.resultsPath,
  });
  await service.get().start({ kind: "normal" });
  await assertSandboxConnected(asDriver(), { expectedSocketPath: context.socketPath });
  await browser.execute(installConsoleCapture);
  await runPluginCommand(asDriver(), commandId("open-overview"));
});

after(async function stopRun() {
  await service.get().stop();
});

describe("cross-cutting items", () => {
  // Item 25 runs last: its meaning depends on activity having happened (a test approval sent,
  // the managed vault set up with the live-check notes).
  it("[06-UAT#25] The service log and the settings file hold no request or task text", async () => {
    expect(await pressSettingsButton(SEND_TEST_APPROVAL_NAME)).toBe(true);
    await closeSettings();
    await runPluginCommand(asDriver(), commandId("set-up-managed-vault"));
    await pollUntil(
      () =>
        browser.execute((label: string) => {
          const button = Array.from(document.querySelectorAll(".modal button")).find(
            (el) => el.textContent?.trim() === label,
          );
          if (button === undefined) return false;
          (button as HTMLElement).click();
          return true;
        }, SETUP_CONFIRM_LABEL),
      { timeoutMs: 20_000, intervalMs: 250, describe: "the setup confirmation" },
    );
    await openDestination("tasks");
    await pollUntil(
      async () => {
        const name = await browser.execute(
          () => document.querySelector('[data-filter="all"]')?.getAttribute("aria-label") ?? "",
        );
        const parsed = parseCountInWords(name);
        return parsed !== null && parsed.count > 0;
      },
      { timeoutMs: 60_000, intervalMs: 500, describe: "the Tasks count after setup" },
    );

    const logPath = join(context.paths.runtimeDir, "logs", "service.log");
    expect(existsSync(logPath)).toBe(true);
    const log = readFileSync(logPath, "utf8");
    for (const marker of SYNTHETIC_MARKERS) {
      expect(countOccurrences(log, marker)).toBe(0);
    }

    const configDir = await obsidianPage.getConfigDir();
    const data = JSON.parse(
      await obsidianPage.read(`${configDir}/plugins/${PLUGIN_ID}/data.json`),
    ) as unknown;
    expect(checkPluginDataKeys(data, { socketPath: context.socketPath })).toEqual([]);
  });
});
