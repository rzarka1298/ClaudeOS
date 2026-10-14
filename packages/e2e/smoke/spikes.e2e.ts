/**
 * Spikes S1 to S5 (05.2-01), throwaway diagnostics the parent orchestrator runs (D-15). Each
 * test prints one parseable line 'SPIKE-RESULT S<n> pass|fail <evidence>' and never throws on a
 * negative finding. The reusable spies are built later in plan 05.2-04; these probes are inline
 * on purpose. S4 is run by the orchestrator outside wdio: this file only prints the region.
 * Everything touches the synthetic vault and the throwaway service only.
 */
import { browser } from "@wdio/globals";
import { SPIKE_DECISIONS } from "../src/spike-decisions.js";
import { decideS1, pollUntil, type S1Evidence } from "../src/spike-s1.js";
import { evaluateSocketIsolation } from "../src/vault-plugin-data.js";
import { readIsolationFacts } from "./isolation-facts.js";
import { refocusWindow, unfocusWindow } from "./window-focus.js";

const PLUGIN_COMMAND = "claude-command-center:open-overview";

/** The plugin delays a test approval by 5 s; wait well beyond it, but never unbounded. */
const S1_WAIT_MS = 15_000;

interface SpyWindow {
  __spikeNotes?: Array<{ title: string; source: string; instance: Notification }>;
  __spikeSource?: string;
}

function result(n: number, verdict: "pass" | "fail" | "manual", evidence: unknown): void {
  console.log(`SPIKE-RESULT S${n} ${verdict} ${JSON.stringify(evidence)}`);
}

function failure(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

describe("spikes S1 to S5 against the sandbox Obsidian", () => {
  before(async () => {
    await browser.executeObsidianCommand(PLUGIN_COMMAND);
  });

  it("S1: an unfocused window, the plugin's own test-approval notification and its click handler", async () => {
    try {
      // Refuse to send a test approval unless the plugin provably talks to the run-root socket
      // (S0 asserts the same fact): otherwise the approval could land in the owner's store.
      const isolation = evaluateSocketIsolation(await readIsolationFacts());
      if (!isolation.ok) {
        result(1, "fail", { refused: "socket isolation not proven", reason: isolation.reason });
        return;
      }

      // Install the spy, then unfocus the window: a focused Obsidian suppresses native approval
      // notifications, and the plugin delays a test approval by 5 s, so both must hold before
      // the button is pressed and the wait below must outlast the delay.
      await browser.executeObsidian(() => {
        const w = window as unknown as SpyWindow;
        const Original = window.Notification;
        w.__spikeNotes = [];
        w.__spikeSource = "plugin";
        class Spy extends Original {
          constructor(title: string, options?: NotificationOptions) {
            super(title, options);
            w.__spikeNotes?.push({ title, source: w.__spikeSource ?? "", instance: this });
          }
        }
        window.Notification = Spy as unknown as typeof Notification;
      });
      const blur = await unfocusWindow();

      const buttonFound = await browser.executeObsidian(({ app }) => {
        const setting = (
          app as unknown as { setting: { open(): void; openTabById(id: string): void } }
        ).setting;
        setting.open();
        setting.openTabById("claude-command-center");
        const item = Array.from(document.querySelectorAll(".setting-item")).find(
          (el) =>
            el.querySelector(".setting-item-name")?.textContent?.trim() === "Send a test approval",
        );
        const button = item?.querySelector("button");
        button?.click();
        return button !== null && button !== undefined;
      });

      const readPlugin = () =>
        browser.executeObsidian(() => {
          const w = window as unknown as SpyWindow;
          const posted = (w.__spikeNotes ?? []).filter((n) => n.source === "plugin");
          return {
            created: posted.length,
            clickHandler: posted.some((n) => typeof n.instance.onclick === "function"),
          };
        });
      const waited = await pollUntil(readPlugin, (seen) => seen.created >= 1, {
        timeoutMs: S1_WAIT_MS,
        intervalMs: 500,
        sleep: (ms) => browser.pause(ms),
      });

      // Direct probe, kept as a control: it shows whether this window can raise a notification at all.
      const control = await browser.executeObsidian(() => {
        const w = window as unknown as SpyWindow;
        w.__spikeSource = "probe";
        const probe = new window.Notification("CCC spike probe", { body: "spike probe" });
        probe.onclick = () => undefined;
        return {
          permission: Notification.permission,
          hasFocus: document.hasFocus(),
          probeCreated: (w.__spikeNotes ?? []).filter((n) => n.source === "probe").length,
        };
      });

      const evidence: S1Evidence = {
        permission: control.permission,
        buttonFound,
        blur,
        waitedMs: waited.waitedMs,
        timedOut: waited.timedOut,
        pluginNotificationsCreated: waited.value.created,
        pluginClickHandlerExists: waited.value.clickHandler,
      };
      const decision = decideS1(evidence);
      result(1, decision.verdict, { ...evidence, ...control, reason: decision.reason });
    } catch (error) {
      result(1, "fail", failure(error));
    } finally {
      await refocusWindow();
    }
  });

  it("S2: document focus and the focus ring before and after window activation", async () => {
    try {
      const probe = () =>
        browser.executeObsidian(() => {
          const control = document.querySelector("button, [tabindex='0']") as HTMLElement | null;
          control?.focus();
          const style = control ? getComputedStyle(control) : null;
          return {
            hasFocus: document.hasFocus(),
            outlineStyle: style?.outlineStyle ?? null,
            outlineWidth: style?.outlineWidth ?? null,
            focusVisible: control?.matches(":focus-visible") ?? false,
          };
        });
      const before = await probe();
      let activated = "none";
      if (SPIKE_DECISIONS.focusActivation === "activate-window") {
        activated = await browser.executeObsidian(({ require }) => {
          try {
            const electron = require("electron") as {
              remote?: { getCurrentWindow(): { focus(): void } };
            };
            electron.remote?.getCurrentWindow().focus();
            return "electron-window-focus";
          } catch {
            return "unavailable";
          }
        });
        await browser.pause(500);
      }
      const after = await probe();
      result(2, after.hasFocus ? "pass" : "fail", { activated, before, after });
    } catch (error) {
      result(2, "fail", failure(error));
    }
  });

  it("S3: the ccc-approval protocol handler reached in process (never the OS URL opener)", async () => {
    try {
      const evidence = await browser.executeObsidian(({ app }) => {
        const handlers = (
          app as unknown as {
            protocolHandlers?: Map<string, (params: Record<string, string>) => unknown>;
          }
        ).protocolHandlers;
        const handler = handlers?.get("ccc-approval");
        const before = app.workspace.activeLeaf?.view.getViewType() ?? null;
        let threw = false;
        if (handler) {
          try {
            handler({ action: "ccc-approval", id: "spike-probe" });
          } catch {
            threw = true;
          }
        }
        return {
          registryFound: handlers !== undefined,
          handlerFound: handler !== undefined,
          threw,
          viewBefore: before,
          viewAfter: app.workspace.activeLeaf?.view.getViewType() ?? null,
          note: "probe id used; request selection not checked",
        };
      });
      result(3, evidence.handlerFound && !evidence.threw ? "pass" : "fail", evidence);
    } catch (error) {
      result(3, "fail", failure(error));
    }
  });

  it("S4: prints the top-right region the orchestrator captures with the OS screen tool", async () => {
    const screen = await browser.executeObsidian(() => ({
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
    }));
    const width = 440;
    const height = 180;
    result(4, "manual", {
      region: `${Math.max(screen.screenWidth - width - 8, 0)},32,${width},${height}`,
      note: "capture while another application is frontmost; view it, then delete it",
    });
  });

  it("S5: prefers-reduced-motion through the WebDriver session and a plugin transition duration", async () => {
    try {
      const read = () =>
        browser.executeObsidian(() => {
          const el = Array.from(document.querySelectorAll("[class*='ccc']")).find(
            (node) => getComputedStyle(node).transitionDuration !== "0s",
          );
          return {
            reduceMatches: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
            transitionDuration: el
              ? getComputedStyle(el).transitionDuration
              : "no-animated-element",
          };
        });
      const before = await read();
      let emulation = "ok";
      try {
        const cdp = (
          browser as unknown as {
            cdp(domain: string, command: string, params: unknown): Promise<unknown>;
          }
        ).cdp;
        await cdp.call(browser, "Emulation", "setEmulatedMedia", {
          features: [{ name: "prefers-reduced-motion", value: "reduce" }],
        });
      } catch (error) {
        emulation = `failed: ${failure(error)}`;
      }
      const after = await read();
      result(5, emulation === "ok" && after.reduceMatches ? "pass" : "fail", {
        emulation,
        before,
        after,
      });
    } catch (error) {
      result(5, "fail", failure(error));
    }
  });
});
