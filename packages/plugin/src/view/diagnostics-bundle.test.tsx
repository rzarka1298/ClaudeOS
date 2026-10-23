import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDiagnosticBundle, serialiseBundle } from "@ccc/domain/diagnostic-bundle.js";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { ConnectionState } from "../connection-state.js";
import { clearDiagnostics } from "../diagnostics.js";
import { configureHealth } from "../health/api.js";
import {
  assembleBundleInput,
  type BundleSources,
  currentRuntimeFacts,
} from "../health/bundle-input.js";
import { saveBundle, saveDialogAvailable } from "../health/export.js";
import { configureBundleExport } from "../health/export-port.js";
import {
  healthPhase,
  healthResponse as healthSignal,
  healthVaultCheck,
  resetHealthState,
} from "../health/state.js";
import { resetProjectsState } from "../projects/projects-state.js";
import { remote } from "../test-support/electron-stub.js";
import { allOkHealth, HEALTH_NOW } from "../test-support/health-fixtures.js";
import { claudeIntegration } from "../widgets/session-signals.js";
import { DiagnosticBundleBlock } from "./diagnostics-bundle.js";
import { createLaunchersSession } from "./launchers-settings.js";
import { SettingsDestination } from "./settings-destination.js";
import { createInertSettingsHost, type SettingsHost } from "./settings-host.js";
import { resetPendingActions } from "./settings-pending.js";
import { requestSettingsSection, takeSettingsSectionRequest } from "./settings-sections.js";

/**
 * The diagnostic bundle block (plan 08-16; D-10 to D-13, 08-UI-SPEC S4, R-16, R-F5). HIGH RISK:
 * these tests pin that the preview, Copy and Save use one verified string and that the bundle
 * never leaves except by the owner's own gesture.
 */

const INTRO =
  "A bundle lists versions, the status of each subsystem with its reason code, counts and setting flags. It never contains file paths, names of projects, sessions, tasks or reports, log lines, email addresses or tokens. Read the preview before you share it.";

interface Fixture {
  readonly host: SettingsHost;
  readonly notify: Mock<(message: string) => void>;
  readonly copyText: Mock<(text: string) => Promise<void>>;
}

function fixture(copy?: () => Promise<void>): Fixture {
  const copyText = vi.fn<(text: string) => Promise<void>>(copy ?? (() => Promise.resolve()));
  const base = createInertSettingsHost();
  const host: SettingsHost = {
    ...base,
    copyText,
    display: {
      ...base.display,
      pluginVersion: "0.1.0",
      obsidianVersion: "1.13.1",
      vaultName: "Marrowvault",
      userName: "zinnia-example",
      vaultBasePath: null,
    },
  };
  return { host, notify: vi.fn<(message: string) => void>(), copyText };
}

/** The sources the block builds from, as the test knows them (live connection, all-ok answer). */
function sourcesFor(f: Fixture, overrides: Partial<BundleSources> = {}): BundleSources {
  return {
    now: HEALTH_NOW,
    connection: "live",
    health: allOkHealth(),
    vaultCheck: "match",
    runtime: currentRuntimeFacts(f.host.display.obsidianVersion),
    pluginVersion: f.host.display.pluginVersion,
    settings: {
      reducedMotion: f.host.settings.reducedMotion,
      notifyApprovals: f.host.settings.notifyApprovals,
    },
    transcriptAnalysis: null,
    launchers: null,
    diagnostics: [],
    ...overrides,
  };
}

function expectedText(f: Fixture, overrides: Partial<BundleSources> = {}): string {
  return serialiseBundle(buildDiagnosticBundle(assembleBundleInput(sourcesFor(f, overrides))));
}

/** A live service whose first answer has landed. */
function answered(): void {
  healthSignal.value = allOkHealth();
  healthPhase.value = "ready";
  healthVaultCheck.value = "match";
}

function renderBlock(f: Fixture, connection: ConnectionState = { kind: "live" }, now = HEALTH_NOW) {
  return render(
    <DiagnosticBundleBlock host={f.host} connection={connection} now={now} notify={f.notify} />,
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  resetHealthState();
  resetProjectsState();
  clearDiagnostics();
  resetPendingActions();
  claudeIntegration.value = null;
  takeSettingsSectionRequest();
});

afterEach(() => {
  cleanup();
  resetHealthState();
  configureHealth(null);
  claudeIntegration.value = null;
  takeSettingsSectionRequest();
});

describe("Task 1 (tracer): Show bundle preview builds, verifies and shows the exact string Copy bundle copies", () => {
  it("Test 1: the preview text equals the serialised domain bundle, and Copy bundle passes exactly that text", async () => {
    answered();
    const f = fixture();
    renderBlock(f);

    expect(screen.getByRole("heading", { level: 4, name: "Diagnostic bundle" }).className).toBe(
      "ccc-settings-group-title",
    );
    expect(screen.getByText(INTRO)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show bundle preview" }));
    const preview = screen.getByRole("region", { name: "Diagnostic bundle preview" });
    expect(preview.tagName).toBe("PRE");
    expect(preview.getAttribute("tabindex")).toBe("0");
    const expected = expectedText(f);
    expect(preview.textContent).toBe(expected);

    fireEvent.click(screen.getByRole("button", { name: "Copy bundle" }));
    await flush();
    expect(f.copyText).toHaveBeenCalledTimes(1);
    expect(f.copyText).toHaveBeenCalledWith(expected);
    expect(f.copyText.mock.calls[0]?.[0]).toBe(preview.textContent);
    expect(f.notify).toHaveBeenCalledWith("Bundle copied.");
  });

  it("shows the size line as {size} · {n} lines for the same string", () => {
    answered();
    const f = fixture();
    renderBlock(f);
    fireEvent.click(screen.getByRole("button", { name: "Show bundle preview" }));
    const expected = expectedText(f);
    const bytes = new TextEncoder().encode(expected).length;
    const lines = expected.split("\n").length;
    const size = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
    expect(
      screen.getByText(`${size} · ${new Intl.NumberFormat("en").format(lines)} lines`),
    ).toBeTruthy();
  });

  it("a rejected clipboard write says so and leaves the preview in place to select by hand", async () => {
    answered();
    const f = fixture(() => Promise.reject(new Error("blocked")));
    renderBlock(f);
    fireEvent.click(screen.getByRole("button", { name: "Show bundle preview" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy bundle" }));
    await flush();
    expect(f.notify).toHaveBeenCalledTimes(1);
    expect(f.notify).toHaveBeenCalledWith(
      "Couldn't copy the bundle. Select the text in the preview and copy it by hand.",
    );
    expect(screen.getByRole("region", { name: "Diagnostic bundle preview" }).textContent).toBe(
      expectedText(f),
    );
  });

  it("a second press while the clipboard write is pending is ignored", async () => {
    answered();
    let release!: () => void;
    const f = fixture(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    renderBlock(f);
    fireEvent.click(screen.getByRole("button", { name: "Show bundle preview" }));
    const copy = screen.getByRole("button", { name: "Copy bundle" });
    fireEvent.click(copy);
    fireEvent.click(copy);
    expect(f.copyText).toHaveBeenCalledTimes(1);
    expect(copy.getAttribute("aria-busy")).toBe("true");
    expect(copy.hasAttribute("disabled")).toBe(false);
    await act(async () => {
      release();
      await Promise.resolve();
    });
    expect(copy.getAttribute("aria-busy")).toBeNull();
  });

  it("Test 3: the toggle reads Hide bundle preview when open; Escape collapses and returns focus to it; collapsed holds no JSON", () => {
    answered();
    const f = fixture();
    const { container } = renderBlock(f);

    // Collapsed by default: the toggle is closed and no JSON is in the DOM (UI-SPEC G13 empty).
    const toggle = screen.getByRole("button", { name: "Show bundle preview" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "Diagnostic bundle preview" })).toBeNull();
    expect(container.textContent).not.toContain("bundleVersion");
    // Nothing to copy before the preview is read: what you see is what leaves.
    expect(screen.queryByRole("button", { name: "Copy bundle" })).toBeNull();

    fireEvent.click(toggle);
    const open = screen.getByRole("button", { name: "Hide bundle preview" });
    expect(open.getAttribute("aria-expanded")).toBe("true");
    const controls = open.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    const preview = screen.getByRole("region", { name: "Diagnostic bundle preview" });
    expect(preview.id).toBe(controls);
    expect(container.textContent).toContain("bundleVersion");

    preview.focus();
    fireEvent.keyDown(preview, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Diagnostic bundle preview" })).toBeNull();
    expect(container.textContent).not.toContain("bundleVersion");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Show bundle preview" }),
    );
  });

  it("the bundle is rebuilt, not reused, when the preview is opened again", () => {
    answered();
    const f = fixture();
    renderBlock(f);
    fireEvent.click(screen.getByRole("button", { name: "Show bundle preview" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide bundle preview" }));
    healthSignal.value = allOkHealth({ version: "0.2.0" });
    fireEvent.click(screen.getByRole("button", { name: "Show bundle preview" }));
    expect(screen.getByRole("region", { name: "Diagnostic bundle preview" }).textContent).toBe(
      expectedText(f, { health: allOkHealth({ version: "0.2.0" }) }),
    );
  });

  it("mounts at the end of the Diagnostics section under its own h4", async () => {
    configureHealth({ api: { get: () => Promise.resolve(allOkHealth()) } });
    const f = fixture();
    const noop = (): Promise<never> => new Promise<never>(() => {});
    requestSettingsSection("diagnostics");
    render(
      <SettingsDestination
        settingsHost={f.host}
        launchersActions={{
          detect: noop,
          getConfigs: noop,
          save: vi.fn(),
          test: vi.fn(),
          markTested: vi.fn(),
          openSystemSettings: vi.fn(),
          codexDoctor: vi.fn(),
        }}
        launchersSession={createLaunchersSession()}
        projectsActions={{
          register: noop,
          remove: noop,
          rename: noop,
          pin: noop,
          setGithubLink: noop,
          refresh: noop,
        }}
        pickFolder={() => Promise.resolve({ kind: "unavailable" })}
        connection={{ kind: "live" }}
        now={HEALTH_NOW}
      />,
    );
    await flush();
    const content = document.querySelector(".ccc-settings-content") as HTMLElement;
    const headings = [...content.querySelectorAll("h3, h4")].map((el) => el.textContent);
    expect(headings.slice(-1)).toEqual(["Diagnostic bundle"]);
    expect(within(content).getByRole("button", { name: "Show bundle preview" })).toBeTruthy();
    expect(content.textContent).not.toContain("bundleVersion");
  });
});

describe("Task 2: Save bundle through the typed dialog, 0600, never inside the vault", () => {
  const SAVE_UNAVAILABLE = "The save dialog isn't available here. Use Copy bundle instead.";
  let root: string;
  let vault: string;
  let outside: string;

  /** The fixture with a real vault folder behind `display.vaultBasePath`. */
  function vaultFixture(copy?: () => Promise<void>): Fixture {
    const f = fixture(copy);
    return {
      ...f,
      host: { ...f.host, display: { ...f.host.display, vaultBasePath: vault } },
    };
  }

  function choose(path: string | undefined, canceled = false): void {
    remote.dialog.showSaveDialog = () => Promise.resolve({ canceled, filePath: path });
  }

  /**
   * Presses Save and waits for its status-line outcome. A save does real file I/O, which finishes
   * in later macrotasks than the microtasks `flush` drains, so it waits on the observable result.
   */
  async function pressSave(f: Fixture): Promise<void> {
    const before = f.notify.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Save bundle" }));
    await waitFor(() => expect(f.notify.mock.calls.length).toBeGreaterThan(before));
  }

  function openPreview(f: Fixture) {
    answered();
    const view = renderBlock(f);
    fireEvent.click(screen.getByRole("button", { name: "Show bundle preview" }));
    return view;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ccc-bundle-ui-"));
    vault = join(root, "Vault");
    outside = join(root, "out");
    mkdirSync(vault);
    mkdirSync(outside);
    choose(undefined, true);
    configureBundleExport({ saveDialogAvailable, save: saveBundle });
  });

  afterEach(() => {
    configureBundleExport(null);
    choose(undefined, true);
    rmSync(root, { recursive: true, force: true });
  });

  it("Test 1: writes the preview string byte for byte with mode 0600 and says Bundle saved. without the path", async () => {
    const target = join(outside, "diagnostics.json");
    choose(target);
    const f = vaultFixture();
    openPreview(f);
    const previewText = screen.getByRole("region", {
      name: "Diagnostic bundle preview",
    }).textContent;

    await pressSave(f);

    expect(readFileSync(target, "utf8")).toBe(previewText);
    expect(readFileSync(target, "utf8")).toBe(expectedText(f));
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(f.notify).toHaveBeenCalledTimes(1);
    expect(f.notify).toHaveBeenCalledWith("Bundle saved.");
    // The path is never printed: not in the status line, not anywhere in the page.
    expect(JSON.stringify(f.notify.mock.calls)).not.toContain(root);
    expect(document.body.textContent).not.toContain(root);
    expect(readdirSync(outside)).toEqual(["diagnostics.json"]);
    expect(readdirSync(vault)).toEqual([]);
  });

  it("the preview, Copy and Save use one string", async () => {
    const target = join(outside, "same.json");
    choose(target);
    const f = vaultFixture();
    openPreview(f);
    fireEvent.click(screen.getByRole("button", { name: "Copy bundle" }));
    await flush();
    await pressSave(f);
    const preview = screen.getByRole("region", { name: "Diagnostic bundle preview" }).textContent;
    expect(f.copyText.mock.calls[0]?.[0]).toBe(preview);
    expect(readFileSync(target, "utf8")).toBe(preview);
  });

  it("Test 2: the dialog gets the bare default name for the UTC date, a JSON filter and overwrite confirmation", async () => {
    let seen: Parameters<typeof remote.dialog.showSaveDialog>[0] | undefined;
    remote.dialog.showSaveDialog = (options) => {
      seen = options;
      return Promise.resolve({ canceled: true });
    };
    const f = vaultFixture();
    openPreview(f);
    await pressSave(f);
    expect(seen?.defaultPath).toBe("claude-command-center-diagnostics-2026-10-22.json");
    expect(seen?.filters).toEqual([{ name: "JSON", extensions: ["json"] }]);
    expect(seen?.properties).toContain("showOverwriteConfirmation");
  });

  it("Test 3: a path inside the vault is refused with the fixed sentence and nothing is written", async () => {
    choose(join(vault, "diagnostics.json"));
    const f = vaultFixture();
    openPreview(f);
    await pressSave(f);
    expect(f.notify).toHaveBeenCalledWith(
      "That location is inside your vault. Choose a folder outside the vault.",
    );
    expect(readdirSync(vault)).toEqual([]);
    expect(JSON.stringify(f.notify.mock.calls)).not.toContain(root);
  });

  it("a cancelled dialog says nothing was written; a failed write says it couldn't save", async () => {
    const f = vaultFixture();
    openPreview(f);
    choose(undefined, true);
    await pressSave(f);
    expect(f.notify).toHaveBeenLastCalledWith("Save cancelled. Nothing was written.");

    mkdirSync(join(outside, "dir.json"));
    choose(join(outside, "dir.json"));
    await pressSave(f);
    expect(f.notify).toHaveBeenLastCalledWith("Couldn't save the bundle.");
    expect(readdirSync(outside)).toEqual(["dir.json"]);

    choose(join(outside, "not-json.txt"));
    await pressSave(f);
    expect(f.notify).toHaveBeenLastCalledWith("Couldn't save the bundle.");
    expect(readdirSync(outside)).toEqual(["dir.json"]);
  });

  it("Test 4: with no save dialog the button is aria-disabled with the visible reason, and Copy still works", async () => {
    // @ts-expect-error test double: simulate a renderer with no showSaveDialog
    remote.dialog.showSaveDialog = undefined;
    const f = vaultFixture();
    openPreview(f);
    const save = screen.getByRole("button", { name: "Save bundle" });
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(save.hasAttribute("disabled")).toBe(false);
    const reason = (save.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "");
    expect(reason).toContain(SAVE_UNAVAILABLE);

    fireEvent.click(save);
    await flush();
    expect(f.notify).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Copy bundle" }));
    await flush();
    expect(f.copyText).toHaveBeenCalledTimes(1);
    expect(f.notify).toHaveBeenCalledWith("Bundle copied.");
  });

  it("an unconfigured export port reads as no dialog: Save is aria-disabled and writes nothing", async () => {
    configureBundleExport(null);
    choose(join(outside, "x.json"));
    const f = vaultFixture();
    openPreview(f);
    const save = screen.getByRole("button", { name: "Save bundle" });
    expect(save.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(save);
    await flush();
    expect(readdirSync(outside)).toEqual([]);
  });

  it("a second press while the dialog is open is ignored", async () => {
    let calls = 0;
    remote.dialog.showSaveDialog = () => {
      calls += 1;
      return new Promise(() => {});
    };
    const f = vaultFixture();
    openPreview(f);
    const save = screen.getByRole("button", { name: "Save bundle" });
    fireEvent.click(save);
    fireEvent.click(save);
    await flush();
    expect(calls).toBe(1);
    expect(save.getAttribute("aria-busy")).toBe("true");
  });

  it("offers no Save while the preview is collapsed", () => {
    answered();
    renderBlock(vaultFixture());
    expect(screen.queryByRole("button", { name: "Save bundle" })).toBeNull();
  });
});
