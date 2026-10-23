/**
 * The diagnostic bundle items of the Phase 8 UAT (plan 08-20, DIAG-04, D-10 to D-14, D-27): the
 * preview equals the copied text byte for byte and is clean, a hostile registry still yields an
 * offered, verified bundle, and a stubbed save dialog writes the preview's bytes with mode 600
 * outside the vault and writes nothing when cancelled. Everything runs inside the run's sandbox:
 * its own runtime folder and service (from `startResearchEnvironment`, so a gesture check asks about
 * a nonexistent `ccc-uat-` research-key account), projects registered from folders of the run root,
 * and files written only below the run root. Nothing is sent anywhere.
 *
 * The runner cannot drive the native save sheet, so the save cases replace `showSaveDialog` in the
 * renderer (`installSaveDialogStub`, restored in a finally) and answer a path in the run root's
 * scratch folder. The stub is never aimed at the vault: a Save into the vault is covered by the
 * plugin's own export tests and by the owner's item 35, and is not made here (contract note 08-16).
 * Authored and CI-verified only (D-15); the live behaviour is first seen in the orchestrator's run
 * at the final head (D-30).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, join } from "node:path";
import type { ProjectId } from "@ccc/domain";
import { registerProject, removeProject, renameProject } from "@ccc/service-api-client";
import { browser, expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import { isSameOrInside } from "../src/canonical-path.js";
import { assertSandboxConnected, pollUntil } from "../src/driver.js";
import {
  installSaveDialogStub,
  readSaveDialogCalls,
  restoreSaveDialog,
  type SaveDialogAnswer,
} from "../src/renderer-spies.js";
import { loadRunContext } from "../src/spec-context.js";
import { HEALTH_TEXT } from "../src/spec-support/health-copy.js";
import {
  makeDirInRunRoot,
  removeEmptyDirInRunRoot,
  removeFileInRunRoot,
} from "../src/spec-support/health-drill-support.js";
import {
  asHealthBrowser,
  type BundleLeakFacts,
  type BundleRead,
  bundleButton,
  bundleTextsEqual,
  checkBundleClean,
  checkBundleClosed,
  checkBundleOffered,
  checkSaveButton,
  checkSaveDialogCall,
  checkSavedFile,
  checkSettled,
  findRawErrorText,
  hostileProjectNames,
  newCheckClock,
  openBundlePreview,
  openDiagnostics,
  pressBundleButton,
  readBundle,
  readHealth,
  recheck,
  reopenDiagnostics,
  waitForBundle,
  waitForHealth,
  withRestore,
} from "../src/spec-support/health-support.js";
import {
  rendererClearSpies,
  rendererInstallSpies,
  rendererReadSpies,
} from "../src/spec-support/research-dom.js";
import {
  type ResearchEnvironment,
  startResearchEnvironment,
} from "../src/spec-support/research-support.js";
import { asTasksBrowser, recordResults, WAIT } from "../src/spec-support/tasks-support.js";

const tb = asTasksBrowser(browser);
const hb = asHealthBrowser(browser);

describe("bundle export", function () {
  this.timeout(300_000);
  let env: ResearchEnvironment;
  const clock = newCheckClock();

  recordResults(loadRunContext(), (hook) => afterEach(hook as Mocha.Func));

  const context = loadRunContext();
  const paths = context.paths;
  /** Where saved bundles go: a folder of the run root's scratch space, never the vault. */
  const outDir = join(paths.tmpDir, "bundle-out");
  const hostile = hostileProjectNames();

  before(async () => {
    await assertSandboxConnected(tb, { expectedSocketPath: context.socketPath });
    env = await startResearchEnvironment();
  });

  after(async () => {
    await env?.stop();
  });

  /** What the bundle must keep out, from the run's own facts and the hostile names. */
  function leakFacts(
    extra: { projectNames?: string[]; folderBasenames?: string[] } = {},
  ): BundleLeakFacts {
    return {
      runRoot: paths.root,
      homeFolder: homedir(),
      userName: userInfo().username,
      vaultName: basename(obsidianPage.getVaultPath()),
      projectNames: extra.projectNames ?? [],
      folderBasenames: extra.folderBasenames ?? [],
    };
  }

  /** Opens Diagnostics, waits for a settled answer and returns the block with its preview open. */
  async function offered(): Promise<BundleRead> {
    await openDiagnostics(hb);
    // Leaving and coming back mounts the block again, so its preview starts closed.
    await reopenDiagnostics(hb);
    clock.lastPressAt = Date.now();
    await waitForHealth(hb, checkSettled, "the first answer", WAIT.connect);
    const closed = await waitForBundle(
      hb,
      checkBundleClosed,
      "the closed bundle block",
      WAIT.short,
    );
    expect(checkBundleClosed(closed)).toEqual([]);
    return openBundlePreview(hb);
  }

  /** Presses Copy bundle and returns the text the clipboard spy recorded. */
  async function copied(): Promise<string> {
    await hb.execute(rendererInstallSpies);
    await hb.execute(rendererClearSpies);
    await pressBundleButton(hb, HEALTH_TEXT.copyBundle);
    await pollUntil(async () => (await readHealth(hb)).statusLine === HEALTH_TEXT.bundleCopied, {
      ...WAIT.short,
      describe: "the copied notice",
    });
    const text = (await hb.execute(rendererReadSpies)).clipboard.at(-1);
    if (text === undefined) throw new Error("Copy bundle wrote nothing to the clipboard.");
    return text;
  }

  /** Presses Save bundle with the dialog stubbed to `answer`; restores the dialog in a finally. */
  async function saveWith(answer: SaveDialogAnswer, notice: string) {
    return withRestore(
      async () => {
        await hb.execute(restoreSaveDialog);
      },
      async () => {
        const installed = await hb.execute(installSaveDialogStub, answer);
        if (!installed.installed) {
          throw new Error(
            `The save dialog stub was not installed (${installed.reason ?? "no reason"}).`,
          );
        }
        const block = await readBundle(hb);
        const save = bundleButton(block, HEALTH_TEXT.saveBundle);
        if (save === undefined || save.disabled) {
          throw new Error(
            `Save bundle is missing or disabled (${save?.reason ?? "no reason given"}).`,
          );
        }
        const preview = block.preview?.text;
        if (preview === undefined) throw new Error("There is no preview to save.");
        await pressBundleButton(hb, HEALTH_TEXT.saveBundle);
        await pollUntil(async () => (await readHealth(hb)).statusLine === notice, {
          ...WAIT.short,
          describe: `the status line to read "${notice}"`,
        });
        return { preview, calls: await hb.execute(readSaveDialogCalls) };
      },
    );
  }

  it("[08-UAT#31] The bundle preview equals what is copied and is clean", async () => {
    const block = await offered();
    expect(checkBundleOffered(block)).toEqual([]);
    // Save is there; when it is disabled it says why (the native sheet is the owner's item 35).
    expect(checkSaveButton(block)).toEqual([]);

    const preview = block.preview?.text ?? "";
    const text = await copied();
    expect(bundleTextsEqual(preview, text)).toEqual([]);
    // The preview did not move under the copy.
    const after = await readBundle(hb);
    expect(bundleTextsEqual(after.preview?.text ?? "", text)).toEqual([]);

    // Versions, subsystem statuses with reason codes, counts and setting flags; no path, project,
    // vault or user name, address or token.
    expect(checkBundleClean(text, leakFacts())).toEqual([]);
    expect(findRawErrorText(text)).toEqual([]);
    const bundle = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(bundle)).toEqual(
      expect.arrayContaining(["versions", "subsystems", "counts", "features"]),
    );
  });

  it("[08-UAT#32] A hostile registry still yields a clean bundle", async () => {
    const made: string[] = [];
    const registered: ProjectId[] = [];
    await withRestore(
      async () => {
        for (const projectId of registered) {
          await removeProject(env.client, { projectId });
        }
        for (const folder of made.reverse()) removeEmptyDirInRunRoot(paths, folder);
      },
      async () => {
        const base = join(paths.tmpDir, "hostile");
        makeDirInRunRoot(paths, base);
        made.push(base);
        for (const name of hostile.folders) {
          const folder = join(base, name);
          makeDirInRunRoot(paths, folder);
          made.push(folder);
          const answer = await registerProject(env.client, folder);
          if (answer.kind !== "registered") {
            throw new Error("The service did not register a folder of the run root.");
          }
          registered.push(answer.projectId);
        }
        // Display names that look like a home path and an email address.
        for (const [index, displayName] of hostile.displayNames.entries()) {
          const projectId = registered[index];
          if (projectId !== undefined) {
            await renameProject(env.client, { projectId, displayName });
          }
        }

        // A new check, so the counts include the projects; then the preview is rebuilt.
        await openDiagnostics(hb);
        await reopenDiagnostics(hb);
        clock.lastPressAt = Date.now();
        await recheck(hb, clock);
        const block = await openBundlePreview(hb);
        expect(checkBundleOffered(block)).toEqual([]);

        const text = await copied();
        expect(bundleTextsEqual(block.preview?.text ?? "", text)).toEqual([]);
        const facts = leakFacts({
          projectNames: [...hostile.projectNames, ...hostile.displayNames],
          folderBasenames: [...hostile.folderBasenames, ...hostile.folders],
        });
        expect(checkBundleClean(text, facts)).toEqual([]);
        const counts = (JSON.parse(text) as { counts: { projects: number | null } }).counts;
        expect(counts.projects).toBe(registered.length);
      },
    );
  });

  it("[08-UAT#33] Save writes the preview's bytes, mode 600, outside the vault, and a cancel writes nothing", async () => {
    const vault = obsidianPage.getVaultPath();
    const target = join(outDir, "saved-bundle.json");
    // The stub only ever answers a path of the run root's scratch folder, outside the vault.
    expect(isSameOrInside(vault, target)).toBe(false);
    expect(isSameOrInside(paths.root, target)).toBe(true);

    await withRestore(
      () => {
        removeFileInRunRoot(paths, target);
        removeEmptyDirInRunRoot(paths, outDir);
      },
      async () => {
        makeDirInRunRoot(paths, outDir);
        await offered();

        const saved = await saveWith({ kind: "picked", path: target }, HEALTH_TEXT.bundleSaved);
        const bytes = readFileSync(target);
        expect(checkSavedFile(saved.preview, bytes, statSync(target).mode)).toEqual([]);
        // The line says "Bundle saved." and never the path; no temporary file was left behind.
        const line = (await readHealth(hb)).statusLine;
        expect(line).toBe(HEALTH_TEXT.bundleSaved);
        expect(findRawErrorText(line)).toEqual([]);
        expect(readdirSync(outDir)).toEqual(["saved-bundle.json"]);

        // Cancelling writes nothing: the folder and the saved file are exactly as they were.
        const before = statSync(target).mtimeMs;
        const cancelled = await saveWith({ kind: "cancelled" }, HEALTH_TEXT.saveCancelled);
        expect(cancelled.calls).toHaveLength(1);
        expect(readdirSync(outDir)).toEqual(["saved-bundle.json"]);
        expect(statSync(target).mtimeMs).toBe(before);
        expect(readFileSync(target).equals(bytes)).toBe(true);
      },
    );
    // The test left the saved file in the run root only; the run root's teardown removes it.
  });

  it("[08-UAT#35] The stubbed save dialog receives a bare default file name and the written bytes equal the preview", async () => {
    const target = join(outDir, "second-bundle.json");
    expect(isSameOrInside(obsidianPage.getVaultPath(), target)).toBe(false);
    await withRestore(
      () => {
        removeFileInRunRoot(paths, target);
        removeEmptyDirInRunRoot(paths, outDir);
      },
      async () => {
        makeDirInRunRoot(paths, outDir);
        await offered();
        const saved = await saveWith({ kind: "picked", path: target }, HEALTH_TEXT.bundleSaved);
        // The dialog was asked for a dated file name with no folder, a json filter and the
        // overwrite confirmation, once.
        expect(saved.calls).toHaveLength(1);
        expect(checkSaveDialogCall(saved.calls[0])).toEqual([]);
        expect(checkSavedFile(saved.preview, readFileSync(target), statSync(target).mode)).toEqual(
          [],
        );
      },
    );
  });
});
