/**
 * The Settings > Diagnostics items of the Phase 8 UAT (plan 08-20, DIAG-02, DIAG-03, D-09, D-27,
 * D-28, D-35 to D-39, D-49): the fresh-install look, the setup actions, the re-check behaviour, the
 * service stop and every break drill the sandbox can make, each judged by its own reason CODE and
 * the sentence the plugin writes for it. Everything runs inside the run's sandbox: its own runtime
 * folder, Claude config folder, Codex folders, store and throwaway vaults, through the 08-05 drill
 * helpers, with every change undone in `withRestore` or `withMode` (a source scan in
 * health-support.test.ts fails on a mutating call outside them). The service comes from
 * `startResearchEnvironment`, so a gesture check asks about a nonexistent `ccc-uat-` research-key
 * account and never the owner's. No drill launches an app: the launcher drills only save, seed and
 * delete sandbox configuration and watch the process tree. Authored and CI-verified only (D-15); the
 * live behaviour is first seen in the orchestrator's run at the final head (D-30).
 *
 * The cases share one service, so their order matters: the fresh-install look first (no vault is
 * set up, nothing is installed), then the setup actions and the re-check behaviour while the sandbox
 * is still fresh, then the stop and restart, then the drills that change the sandbox.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_HOOK_EVENTS_PATH } from "@ccc/domain";
import { setSecret } from "@ccc/keychain";
import {
  requestVaultSetup,
  saveLauncherConfig,
  setTranscriptAnalysis,
} from "@ccc/service-api-client";
import { browser, expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import { assertSandboxConnected, pollUntil } from "../src/driver.js";
import { deleteUatAccount } from "../src/keychain-cleanup.js";
import { appendLedger } from "../src/ledger.js";
import { loadRunContext } from "../src/spec-context.js";
import { HEALTH_TEXT } from "../src/spec-support/health-copy.js";
import {
  ageFileInRunRoot,
  INSTALLER_CLAUDE_VERSION_LINE,
  makeSecondVault,
  readTextInRunRoot,
  removeFileInRunRoot,
  removeLauncherRow,
  renameInRunRoot,
  replaceFileInRunRoot,
  runHookInstaller,
  seedLauncherRow,
  withMode,
  writeFakeExecutable,
  writeSpoolDrops,
} from "../src/spec-support/health-drill-support.js";
import {
  asHealthBrowser,
  CHECK_CACHE_GAP_MS,
  checkChecked,
  checkFreshInstall,
  checkOffers,
  checkRunChecksPresses,
  checkSchedulerLine,
  checkServiceRestored,
  checkServiceStopped,
  drillFiles,
  ensureServiceRunning,
  expectPart,
  expectRow,
  findRawErrorText,
  HEALTH_DOM_CONFIG,
  installJsonWithNodePath,
  newCheckClock,
  openDiagnostics,
  pressInRow,
  readHealth,
  readModal,
  readSection,
  recheck,
  rendererPressRunChecksTwice,
  reopenCachedWithRetry,
  rowOf,
  settingsWithAllHooksDisabled,
  waitForCheckedAnswer,
  waitForHealth,
  waitForLive,
  withRestore,
} from "../src/spec-support/health-support.js";
import { findLauncherProcesses } from "../src/spec-support/overview-support.js";
import {
  rendererClearSpies,
  rendererInstallSpies,
  rendererReadSpies,
} from "../src/spec-support/research-dom.js";
import {
  type ResearchEnvironment,
  readAllServiceLogs,
  runViaApi,
  sandboxAncestors,
  startResearchEnvironment,
  watchDescendants,
} from "../src/spec-support/research-support.js";
import { installSessionGuard, type SessionGuardHooks } from "../src/spec-support/session-guard.js";
import {
  asTasksBrowser,
  recordResults,
  rendererClick,
  WAIT,
} from "../src/spec-support/tasks-support.js";

const tb = asTasksBrowser(browser);
const hb = asHealthBrowser(browser);

/** A bundle id no Mac has: the saved Antigravity row of the unresolvable-app drill. */
const MISSING_BUNDLE_ID = "com.example.ccc-uat-missing-app";
/** What the throwaway Keychain item of item 36 holds. It is never read. */
const PLACEHOLDER_VALUE = "ccc-uat-placeholder-not-a-key";
const DAY_MS = 24 * 60 * 60 * 1000;

describe("health drills", function () {
  this.timeout(600_000);
  let env: ResearchEnvironment;
  const clock = newCheckClock();

  recordResults(loadRunContext(), (hook) => afterEach(hook as Mocha.Func));
  // A closed Obsidian stops the file with one clear message, not a cascade of timeouts (FIX8).
  installSessionGuard({ beforeEach, afterEach } as unknown as SessionGuardHooks, () =>
    browser.execute(() => true),
  );

  const context = loadRunContext();
  const paths = context.paths;
  const files = drillFiles(paths);

  before(async () => {
    await assertSandboxConnected(tb, { expectedSocketPath: context.socketPath });
    // A fresh sandbox service: no managed vault, no hooks, no launcher, nothing run.
    env = await startResearchEnvironment();
  });

  after(async () => {
    await env?.stop();
  });

  /** Opens Diagnostics (the opening is one gesture check) and starts the answer-cache clock. */
  async function opened() {
    const read = await openDiagnostics(hb);
    clock.lastPressAt = Date.now();
    return read;
  }

  /** Makes a break, then re-checks (a new run, never the cached one) and returns the section. */
  async function checked() {
    return recheck(hb, clock);
  }

  /** After a stop or restart: waits for the plugin to be live again. */
  async function live() {
    clock.lastPressAt = 0;
    return waitForLive(hb);
  }

  const fixtureView = (running: () => boolean) => ({ isRunning: running });

  it("[08-UAT#22] Fresh install: one working, five needing setup, nothing failing", async () => {
    // A real fresh install holds no research key. The runner's service carries the extractive
    // summariser double, and with that test transport the key is never consulted, so the key part
    // reads present and the Scheduler row would read Working (D-38). This look therefore runs on a
    // service without the summariser: the fixture's test-override flag and its nonexistent
    // `ccc-uat-` research account stay set, so the gesture check asks about that empty account and
    // never the owner's key, and it reads missing, as it does on a fresh install.
    await withRestore(
      async () => {
        // Back to the shared service (with the summariser double) that the later cases expect.
        await env.restart();
        await opened();
        await live();
      },
      async () => {
        await env.restart({ summariser: false });
        // The new service has no first answer for the open page: open Diagnostics, wait until the
        // plugin has reconnected, then press Run checks again (an owner gesture, like the opening
        // check of a fresh install) and judge the look that press produces.
        await opened();
        await live();
        await checked();
        // Wait for the settled look, then judge it: a timeout names the problems the page showed last.
        const read = await waitForHealth(
          hb,
          checkFreshInstall,
          "the fresh-install look",
          WAIT.connect,
        );
        expect(checkFreshInstall(read)).toEqual([]);
      },
    );
  });

  it("[08-UAT#29] Setup actions copy, navigate or run the existing vault setup", async () => {
    await opened();
    await hb.execute(rendererInstallSpies);
    await hb.execute(rendererClearSpies);

    // Copy install command puts the repository-relative command on the clipboard and says so.
    await pressInRow(hb, "hooks", HEALTH_TEXT.copyInstall);
    await pollUntil(
      async () =>
        (await hb.execute(rendererReadSpies)).clipboard.at(-1) === HEALTH_TEXT.claudeInstallCommand,
      { ...WAIT.short, describe: "the install command on the clipboard" },
    );
    await waitForHealth(
      hb,
      (read) =>
        read.statusLine === HEALTH_TEXT.claudeInstallCopied
          ? []
          : [`the status line reads "${read.statusLine}"`],
      "the copied notice",
      WAIT.short,
    );

    // A go-to action lands on the named section heading, which takes focus.
    await pressInRow(
      hb,
      "launchers",
      `${HEALTH_TEXT.goToPrefix}launchers${HEALTH_TEXT.goToSuffix}`,
    );
    await pollUntil(
      async () => {
        const section = await readSection(hb);
        return section.navCurrent === HEALTH_TEXT.navLaunchers && section.headingFocused
          ? section
          : null;
      },
      { ...WAIT.short, describe: "the Launchers section heading to take focus" },
    );

    // Set up vault opens the existing confirmation; cancelling it changes nothing.
    await opened();
    await pressInRow(hb, "vault", HEALTH_TEXT.setUpVault);
    await pollUntil(
      async () => {
        const modal = await readModal(hb);
        return modal.title === HEALTH_TEXT.vaultSetupTitle &&
          modal.buttons.includes(HEALTH_TEXT.confirm) &&
          modal.buttons.includes(HEALTH_TEXT.cancel)
          ? modal
          : null;
      },
      { ...WAIT.short, describe: "the vault setup confirmation" },
    );
    expect(await browser.executeObsidian(rendererClick, ".modal button", HEALTH_TEXT.cancel)).toBe(
      true,
    );
    await pollUntil(async () => (await readModal(hb)).title === null, {
      ...WAIT.short,
      describe: "the confirmation to close",
    });
    const after = await checked();
    expect(expectRow(after, "vault", "vault-not-set-up")).toEqual([]);

    // No action installed anything: no Claude settings, no hook bundle in the sandbox.
    expect(existsSync(files.claudeSettings)).toBe(false);
    expect(existsSync(join(paths.runtimeDir, "hooks"))).toBe(false);
  });

  it("[08-UAT#30] Run checks again is busy at once, the second press is ignored and a reopening is cached", async () => {
    await opened();
    await pollUntil(() => Date.now() - clock.lastPressAt >= CHECK_CACHE_GAP_MS, {
      timeoutMs: CHECK_CACHE_GAP_MS + 5_000,
      intervalMs: 50,
      describe: "the previous answer to be older than the answer cache",
    });
    const pressedAt = Date.now();
    const presses = await browser.execute(rendererPressRunChecksTwice, HEALTH_DOM_CONFIG);
    expect(checkRunChecksPresses(presses)).toEqual([]);

    // The line then reads "Checked just now." and the button is free again. The service caches an
    // answer from when its run finished: the clock records both when the page showed it and when the
    // last look without it began (FIX8), which bound the answer's age from either side.
    const first = await waitForCheckedAnswer(hb, clock, checkChecked, {
      pressedAt,
      wait: { timeoutMs: 30_000, intervalMs: 100 },
    });
    expect(checkChecked(first)).toEqual([]);

    // Reopening Diagnostics within two seconds shows the rows as Cached with the same checked time.
    // A reopening that came inside the window must read Cached (no loosening); one that the machine
    // delayed past the window is retried (press, wait out the cache, reopen at once), at most 3 times.
    const reopened = await reopenCachedWithRetry(hb, clock, first, {
      maxAttempts: 3,
      reopenWait: { timeoutMs: 5_000, intervalMs: 100 },
    });
    // Printed so a run shows how close the reopening came to the window and whether it was retried.
    console.log(
      `[FIX8 item 30] reopen attempts=${reopened.attempts} spans(ms from the answer)=${reopened.spansMs.join(",")}`,
    );
    expect(reopened.problems).toEqual([]);
  });

  it("[08-UAT#23] Service stopped and restarted", async () => {
    await opened();
    // Whatever the assertions find, the service comes back, so one failure cannot leave every
    // later case with no socket.
    await withRestore(
      () => ensureServiceRunning(env),
      async () => {
        await env.stopService();
        const down = await waitForHealth(hb, checkServiceStopped, "the stopped look", WAIT.connect);
        expect(checkServiceStopped(down)).toEqual([]);

        // After a restart, Run checks again restores the rows.
        await env.startService();
        await live();
        const up = await checked();
        expect(checkServiceRestored(up)).toEqual([]);
      },
    );
  });

  it("[08-UAT#24] Vault access drills: mismatch, missing, unreadable, read-only and incomplete", async () => {
    await opened();
    const liveVault = obsidianPage.getVaultPath();
    const second = makeSecondVault(paths);
    const away = join(paths.vaultsDir, "second-away");
    const wiki = join(second, "global", "wiki");
    const wikiAway = join(second, "global", "wiki-away");

    // The service is pointed at a different vault than the one Obsidian has open, and every break
    // below is made on that throwaway one, never the open vault. The service is pointed back at the
    // open vault in the finally.
    await withRestore(
      async () => {
        await requestVaultSetup(env.client, liveVault);
      },
      async () => {
        await requestVaultSetup(env.client, second);
        expect(expectRow(await checked(), "vault", "vault-mismatch", { nextStep: true })).toEqual(
          [],
        );

        // The managed vault removed reads missing.
        await withRestore(
          () => {
            if (existsSync(away) && !existsSync(second)) renameInRunRoot(paths, away, second);
          },
          async () => {
            renameInRunRoot(paths, second, away);
            expect(expectRow(await checked(), "vault", "vault-root-missing")).toEqual([]);
          },
        );

        // Made unreadable, then read-only; each mode is restored after its drill.
        await withMode(paths, second, 0o000, async () => {
          expect(expectRow(await checked(), "vault", "vault-root-unreadable")).toEqual([]);
        });
        await withMode(paths, second, 0o555, async () => {
          expect(expectRow(await checked(), "vault", "vault-root-not-writable")).toEqual([]);
        });

        // A managed folder moved away reads incomplete.
        await withRestore(
          () => {
            if (existsSync(wikiAway) && !existsSync(wiki)) renameInRunRoot(paths, wikiAway, wiki);
          },
          async () => {
            renameInRunRoot(paths, wiki, wikiAway);
            expect(expectRow(await checked(), "vault", "managed-tree-incomplete")).toEqual([]);
          },
        );
      },
    );

    // Back on the open vault: the vault row reads ready again.
    expect(expectRow(await checked(), "vault", "vault-ready")).toEqual([]);
  });

  it("[08-UAT#25] Claude Code hooks drills: not installed, no events, disabled, runtime missing", async () => {
    await opened();
    expect(
      expectRow(await checked(), "hooks", "hooks-not-installed", {
        button: HEALTH_TEXT.copyInstall,
        nextStep: true,
      }),
    ).toEqual([]);

    await withRestore(
      () => {
        removeFileInRunRoot(paths, files.claudeSettings);
        removeFileInRunRoot(paths, files.fakeClaude);
      },
      async () => {
        // The real installer, into the scratch Claude config and runtime folders only.
        writeFakeExecutable(paths, "claude", { versionLine: INSTALLER_CLAUDE_VERSION_LINE });
        await runHookInstaller(paths);
        expect(expectRow(await checked(), "hooks", "no-events-yet")).toEqual([]);

        // disableAllHooks reads Degraded.
        const settings = readTextInRunRoot(paths, files.claudeSettings);
        await withRestore(
          () => replaceFileInRunRoot(paths, files.claudeSettings, settings),
          async () => {
            replaceFileInRunRoot(
              paths,
              files.claudeSettings,
              settingsWithAllHooksDisabled(settings),
            );
            expect(expectRow(await checked(), "hooks", "hooks-disabled-in-claude")).toEqual([]);
          },
        );

        // A missing hook runtime reads Failing.
        const record = readTextInRunRoot(paths, files.installJson);
        await withRestore(
          () => replaceFileInRunRoot(paths, files.installJson, record),
          async () => {
            replaceFileInRunRoot(
              paths,
              files.installJson,
              installJsonWithNodePath(record, join(paths.root, "fake-bin", "missing-node")),
            );
            expect(expectRow(await checked(), "hooks", "hook-runtime-missing")).toEqual([]);
          },
        );

        // The hook entries removed read not installed again.
        replaceFileInRunRoot(paths, files.claudeSettings, "{}\n");
        expect(expectRow(await checked(), "hooks", "hooks-not-installed")).toEqual([]);
      },
    );
  });

  it("[08-UAT#26] Usage collectors drills, with Codex as sub-rows", async () => {
    await opened();
    const fresh = await checked();
    // Transcript analysis off and the status line not installed read Needs setup, with a link to Security.
    expect(expectPart(fresh, "collectors", "transcript-analysis", "analysis-off")).toEqual([]);
    expect(expectPart(fresh, "collectors", "status-line", "statusline-not-installed")).toEqual([]);
    expect(
      checkOffers(
        fresh,
        "collectors",
        `${HEALTH_TEXT.goToPrefix}security${HEALTH_TEXT.goToSuffix}`,
      ),
    ).toEqual([]);

    // Turned on, the part reads working; it is turned off again in the finally.
    await withRestore(
      async () => {
        await setTranscriptAnalysis(env.client, false);
      },
      async () => {
        await setTranscriptAnalysis(env.client, true);
        expect(
          expectPart(await checked(), "collectors", "transcript-analysis", "analysis-on"),
        ).toEqual([]);
      },
    );

    // Dropped records read Degraded with a count; a day later they read clean with the count kept.
    await withRestore(
      () => replaceFileInRunRoot(paths, files.spoolDropped, ""),
      async () => {
        writeSpoolDrops(paths, 3);
        const dropped = await checked();
        expect(expectPart(dropped, "collectors", "spool", "spool-dropped-records")).toEqual([]);
        expect(
          rowOf(dropped, "collectors")?.parts.find((p) => p.partId === "spool")?.reasonText,
        ).toContain(": 3,");
        ageFileInRunRoot(paths, files.spoolDropped, DAY_MS + 60 * 60 * 1000);
        expect(expectPart(await checked(), "collectors", "spool", "spool-clean")).toEqual([]);
      },
    );

    // The Codex parts describe the sandbox: nothing installed, no path on any of them.
    const codex = await checked();
    expect(expectPart(codex, "collectors", "codex-install", "codex-not-installed")).toEqual([]);
    expect(expectPart(codex, "collectors", "codex-hooks", "codex-hooks-not-installed")).toEqual([]);
    expect(expectPart(codex, "collectors", "codex-bridge", "codex-bridge-not-installed")).toEqual(
      [],
    );
    for (const part of rowOf(codex, "collectors")?.parts ?? []) {
      if (part.partId.startsWith("codex")) expect(findRawErrorText(part.text)).toEqual([]);
    }

    // A changed event shape reads Degraded. The shape state lives in the service process, so the
    // restore is a restart.
    await withRestore(
      async () => {
        await env.restart();
        await live();
      },
      async () => {
        const answer = await env.client.request({
          method: "POST",
          path: CLAUDE_HOOK_EVENTS_PATH,
          // A SessionStart without its required `source`: a known event whose shape changed.
          body: {
            eventId: randomUUID(),
            observedAt: new Date().toISOString(),
            hook_event_name: "SessionStart",
            session_id: "uat-health-shape",
            cwd: join(paths.tmpDir, "shape-project"),
            env: { CLAUDE_PID: "4242" },
          },
        });
        expect(answer.status).toBe(202);
        expect(
          expectPart(await checked(), "collectors", "telemetry", "telemetry-shape-changed"),
        ).toEqual([]);
      },
    );
  });

  it("[08-UAT#27] Scheduler drills: never run, no key, every source failing, a run stopped mid-way", async () => {
    await opened();

    // A scheduler that never ran, on an install with no research key: the row reads Needs setup, and
    // the key part reads Needs setup with Copy key setup command (and copying it works). Both are
    // read on a service without the summariser double: with that test transport the key is never
    // consulted, so its part would read present and lift the row to Working (D-38).
    await withRestore(
      async () => {
        await env.restart();
        await live();
      },
      async () => {
        await env.restart({ summariser: false });
        await live();
        const noKey = await checked();
        expect(expectRow(noKey, "scheduler", "never-run")).toEqual([]);
        expect(expectPart(noKey, "scheduler", "research-key", "research-key-missing")).toEqual([]);
        expect(checkOffers(noKey, "scheduler", HEALTH_TEXT.copyKeySetup)).toEqual([]);
        expect(checkSchedulerLine(noKey)).toEqual([]);
        await hb.execute(rendererInstallSpies);
        await hb.execute(rendererClearSpies);
        await pressInRow(hb, "scheduler", HEALTH_TEXT.copyKeySetup);
        await pollUntil(
          async () =>
            (await hb.execute(rendererReadSpies)).clipboard.at(-1) === HEALTH_TEXT.keySetupCommand,
          { ...WAIT.short, describe: "the key setup command on the clipboard" },
        );
      },
    );

    // Every source failing reads Degraded.
    await withRestore(
      () => env.prepared.select("base"),
      async () => {
        env.prepared.select("all-failing");
        await runViaApi(env);
        const failed = await checked();
        expect(expectRow(failed, "scheduler", "run-all-sources-failed")).toEqual([]);
        expect(checkSchedulerLine(failed)).toEqual([]);
      },
    );

    // A run stopped mid-way reads Unknown: the service stops while the slow fetch holds the run.
    await withRestore(
      async () => {
        env.prepared.select("base");
        await ensureServiceRunning(env);
      },
      async () => {
        env.prepared.select("slow");
        const started = await env.research.run();
        expect(started.alreadyRunning).toBe(false);
        await pollUntil(async () => (await env.research.status()).inFlight !== null, {
          ...WAIT.short,
          describe: "the run to be in flight",
        });
        await env.stopService();
        await env.startService();
        await live();
        const interrupted = await checked();
        expect(expectRow(interrupted, "scheduler", "run-interrupted")).toEqual([]);
        expect(checkSchedulerLine(interrupted)).toEqual([]);
      },
    );
  });

  it("[08-UAT#28] App launcher drills: not set up, untested, a missing app and a deleted program", async () => {
    await opened();
    const watch = watchDescendants(await sandboxAncestors(context));
    let started: ReturnType<typeof findLauncherProcesses> = [];
    try {
      expect(
        expectRow(await checked(), "launchers", "launcher-not-set-up", {
          nextStep: true,
          button: `${HEALTH_TEXT.goToPrefix}launchers${HEALTH_TEXT.goToSuffix}`,
        }),
      ).toEqual([]);

      await withRestore(
        () => {
          removeFileInRunRoot(paths, files.fakeClaude);
        },
        async () => {
          // Saved but not tested reads Needs setup.
          writeFakeExecutable(paths, "claude", { versionLine: INSTALLER_CLAUDE_VERSION_LINE });
          const saved = await saveLauncherConfig(env.client, {
            launcherId: "claude-code",
            executable: { kind: "path", path: files.fakeClaude },
            args: [],
            terminal: { kind: "terminal-app" },
          });
          expect(saved.ok).toBe(true);
          expect(
            expectPart(await checked(), "launchers", "claude-code", "launcher-untested"),
          ).toEqual([]);

          // A deleted saved program reads Failing.
          removeFileInRunRoot(paths, files.fakeClaude);
          expect(
            expectPart(await checked(), "launchers", "claude-code", "executable-not-found"),
          ).toEqual([]);
        },
      );

      // A saved app that is not on this Mac reads Failing. The row is seeded into the stopped
      // sandbox store (the save route would refuse such a bundle).
      // The row is removed again at the end (FIX6A M2), so the checks of later items do not look
      // up an app that is not on this Mac (that lookup runs mdfind).
      await withRestore(
        async () => {
          await env.stopService();
          await removeLauncherRow(
            paths,
            { launcher: "antigravity", fixtureState: "stopped" },
            { fixture: fixtureView(() => false) },
          );
          await env.startService();
          await live();
        },
        async () => {
          await env.stopService();
          await seedLauncherRow(
            paths,
            { launcher: "antigravity", bundleId: MISSING_BUNDLE_ID, fixtureState: "stopped" },
            { fixture: fixtureView(() => false) },
          );
          await env.startService();
          await live();
          expect(
            expectPart(await checked(), "launchers", "antigravity", "bundle-not-found"),
          ).toEqual([]);
        },
      );
    } finally {
      started = findLauncherProcesses(await watch.stop());
    }
    // No app or program was started by any check.
    expect(started.map((node) => node.command.slice(0, 120))).toEqual([]);
  });

  it("[08-UAT#36] The Keychain presence check reports a ledgered sandbox account present, then absent", async () => {
    await opened();
    const account = env.prepared.keyAccount;
    // The account is ledgered before it exists, so teardown removes it whatever happens here.
    appendLedger(paths.ledgerPath, { kind: "account", account });
    await withRestore(
      async () => {
        await deleteUatAccount(account);
        await env.restart();
        await live();
      },
      async () => {
        // Without the summariser override the service looks the sandbox account up for real
        // (attribute only; the value is never read).
        await env.restart({ summariser: false });
        await live();
        await setSecret(account, PLACEHOLDER_VALUE);
        expect(
          expectPart(await checked(), "scheduler", "research-key", "research-key-present"),
        ).toEqual([]);
        await deleteUatAccount(account);
        expect(
          expectPart(await checked(), "scheduler", "research-key", "research-key-missing"),
        ).toEqual([]);
        // Neither the page nor any service log ever held the stored value.
        expect((await readHealth(hb)).text).not.toContain(PLACEHOLDER_VALUE);
        expect(readAllServiceLogs(context)).not.toContain(PLACEHOLDER_VALUE);
      },
    );
  });
});
