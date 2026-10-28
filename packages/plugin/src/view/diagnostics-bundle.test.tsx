import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_PROJECTS_SNAPSHOT, type ProjectView } from "@ccc/domain";
import {
  type BundleRefusalCode,
  buildDiagnosticBundle,
  serialiseBundle,
  verifyAndSerialise,
} from "@ccc/domain/diagnostic-bundle.js";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { ConnectionState } from "../connection-state.js";
import { clearDiagnostics, recordDiagnostic } from "../diagnostics.js";
import { configureHealth } from "../health/api.js";
import {
  assembleBundleInput,
  type BundleSources,
  currentRuntimeFacts,
  type VerifyAndSerialise,
} from "../health/bundle-input.js";
import { nodeExportFileSystem, saveBundle, saveDialogAvailable } from "../health/export.js";
import { bundleExport, configureBundleExport } from "../health/export-port.js";
import {
  clearHealth,
  healthPhase,
  healthResponse as healthSignal,
  healthVaultCheck,
  resetHealthState,
} from "../health/state.js";
import ClaudeCommandCenterPlugin from "../main.js";
import { projectsSnapshot, resetProjectsState } from "../projects/projects-state.js";
import { assertNoPrivatePathValues } from "../settings.js";
import {
  remote,
  type SaveDialogOptions,
  saveDialogOptionsOf,
} from "../test-support/electron-stub.js";
import { allOkHealth, HEALTH_NOW } from "../test-support/health-fixtures.js";
import type { Plugin as StubObsidianPlugin } from "../test-support/obsidian-stub.js";
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

const HEALTH_NOW_ISO = new Date(HEALTH_NOW).toISOString();

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

/** The fixture with some display inputs replaced (the host's `display` is read-only). */
function withDisplay(f: Fixture, patch: Partial<SettingsHost["display"]>): Fixture {
  return { ...f, host: { ...f.host, display: { ...f.host.display, ...patch } } };
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

/** The bundle block's own status line (D-09): the one announcer for bundle actions. */
function bundleLine(): HTMLElement {
  const line = document.querySelector<HTMLElement>('[data-status-region="bundle"]');
  if (line === null) throw new Error("no bundle status line");
  return line;
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
    // D-09: the outcome is announced by the bundle block's own line, never by the destination's.
    expect(bundleLine().getAttribute("role")).toBe("status");
    expect(bundleLine().textContent).toBe("Bundle copied.");
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("Test 2: the bundle line is mounted, empty, before its first message", () => {
    answered();
    const f = fixture();
    renderBlock(f);
    expect(bundleLine().textContent).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Show bundle preview" }));
    expect(bundleLine().textContent).toBe("");
    expect(document.querySelectorAll('[data-status-region="bundle"]')).toHaveLength(1);
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
    expect(f.notify).not.toHaveBeenCalled();
    expect(bundleLine().textContent).toBe(
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

  it("Test 2: the dialog gets the bare default name for the UTC date and a JSON filter, and no overwrite confirmation", async () => {
    let seen: SaveDialogOptions | undefined;
    remote.dialog.showSaveDialog = (...args) => {
      seen = saveDialogOptionsOf(...args);
      return Promise.resolve({ canceled: true });
    };
    const f = vaultFixture();
    openPreview(f);
    await pressSave(f);
    expect(seen?.defaultPath).toBe("claude-command-center-diagnostics-2026-10-22.json");
    expect(seen?.filters).toEqual([{ name: "JSON", extensions: ["json"] }]);
    expect(seen?.properties ?? []).not.toContain("showOverwriteConfirmation");
  });

  it("FIX4B m9 (D-12a): an existing file is never replaced: the status line says so and the file is byte-identical", async () => {
    const target = join(outside, "taken.json");
    writeFileSync(target, "KEEP ME");
    choose(target);
    const f = vaultFixture();
    openPreview(f);
    await pressSave(f);
    expect(f.notify).toHaveBeenLastCalledWith(
      "A file with that name already exists. Choose a new name. Nothing was written.",
    );
    expect(readFileSync(target, "utf8")).toBe("KEEP ME");
    expect(readdirSync(outside)).toEqual(["taken.json"]);
    expect(JSON.stringify(f.notify.mock.calls)).not.toContain(root);
  });

  it("FIX6B: a location with no hard links says it cannot hold the bundle, writes nothing, and the Save gate is released", async () => {
    configureBundleExport({
      saveDialogAvailable,
      save: (text, vaultBase, now) =>
        saveBundle(text, vaultBase, now, {
          ...nodeExportFileSystem,
          link: () => Promise.reject(Object.assign(new Error("exFAT"), { code: "EPERM" })),
        }),
    });
    choose(join(outside, "b.json"));
    const f = vaultFixture();
    openPreview(f);
    await pressSave(f);
    expect(f.notify).toHaveBeenLastCalledWith(
      "This location can't hold the bundle safely. Choose a folder on your Mac's disk.",
    );
    expect(readdirSync(outside)).toEqual([]);
    expect(JSON.stringify(f.notify.mock.calls)).not.toContain(root);
    const save = screen.getByRole("button", { name: "Save bundle" });
    await waitFor(() => expect(save.getAttribute("aria-busy")).toBeNull());
    // The gate is free again: a second press reaches the port.
    await pressSave(f);
    expect(f.notify.mock.calls.length).toBe(2);
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

    // A folder already has that name: the save never replaces anything (D-12a).
    mkdirSync(join(outside, "dir.json"));
    choose(join(outside, "dir.json"));
    await pressSave(f);
    expect(f.notify).toHaveBeenLastCalledWith(
      "A file with that name already exists. Choose a new name. Nothing was written.",
    );
    expect(readdirSync(outside)).toEqual(["dir.json"]);

    // A write that cannot happen (the folder is missing) is the generic failure.
    choose(join(outside, "nope", "b.json"));
    await pressSave(f);
    expect(f.notify).toHaveBeenLastCalledWith("Couldn't save the bundle.");

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
    expect(bundleLine().textContent).toBe("Bundle copied.");
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

const REFUSAL_LABELS = {
  "home-path": "a home folder path",
  "tilde-path": "a path starting with ~/",
  email: "an email address",
  "token-shaped": "a token-shaped string",
  "denylist-project": "a project name",
  "denylist-folder": "a folder name",
  "denylist-github": "a GitHub owner or repository name",
  "denylist-vault": "the vault name",
  "denylist-user": "your macOS user name",
  "schema-invalid": "the bundle format",
  "too-large": "the size limit",
} as const satisfies Record<BundleRefusalCode, string>;

/** A project the owner would not want in a public bug report (invented, harmless). */
function projectView(overrides: Partial<ProjectView> = {}): ProjectView {
  return {
    projectId: "project-1",
    displayName: "Plumcellar Ledger",
    displayPath: "~/code/plumcellar-ledger",
    pinned: false,
    lastOpenedAt: null,
    observedAt: null,
    gitReadFailed: false,
    git: { kind: "pending" },
    github: { kind: "github", label: "github.com/quillowner/quillrepo", source: "remote" },
    ...overrides,
  } as ProjectView;
}

function holdProjects(projects: ProjectView[]): void {
  projectsSnapshot.value = { projects, launchers: EMPTY_PROJECTS_SNAPSHOT.launchers };
}

function refuseWith(rule: BundleRefusalCode): VerifyAndSerialise {
  return () => ({ ok: false, rule });
}

function describedBy(element: HTMLElement): string[] {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "");
}

describe("Task 3, Test 1: a refused bundle is never rendered and names the rule, never the value", () => {
  it.each(Object.entries(REFUSAL_LABELS))(
    "%s: the panel names the rule by its closed label and the preview is not rendered",
    (rule, label) => {
      answered();
      holdProjects([projectView()]);
      const f = fixture();
      const { container } = render(
        <DiagnosticBundleBlock
          host={f.host}
          connection={{ kind: "live" }}
          now={HEALTH_NOW}
          notify={f.notify}
          verify={refuseWith(rule as BundleRefusalCode)}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Show bundle preview" }));

      const heading = screen.getByRole("heading", { level: 5, name: "Bundle not offered" });
      expect(heading.className).toBe("ccc-settings-item-title");
      expect(heading.getAttribute("tabindex")).toBe("-1");
      expect(document.activeElement).toBe(heading);
      expect(
        screen.getByText(
          `The bundle failed a privacy check (${label}), so it can't be copied or saved. Nothing was exported. Run the checks again to rebuild it.`,
        ),
      ).toBeTruthy();
      // No preview, no JSON, and nothing the matched value could have been.
      expect(screen.queryByRole("region", { name: "Diagnostic bundle preview" })).toBeNull();
      expect(container.textContent).not.toContain("bundleVersion");
      for (const private_ of [
        "Plumcellar",
        "plumcellar",
        "quillowner",
        "quillrepo",
        "Marrowvault",
        "zinnia",
      ]) {
        expect(container.textContent, private_).not.toContain(private_);
      }
    },
  );

  it("Copy and Save stay present but aria-disabled with the visible reason, and a press does nothing", async () => {
    answered();
    const f = fixture();
    render(
      <DiagnosticBundleBlock
        host={f.host}
        connection={{ kind: "live" }}
        now={HEALTH_NOW}
        notify={f.notify}
        verify={refuseWith("denylist-project")}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show bundle preview" }));
    for (const name of ["Copy bundle", "Save bundle"]) {
      const button = screen.getByRole("button", { name });
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.hasAttribute("disabled")).toBe(false);
      expect(describedBy(button)).toContain("The bundle was refused by a privacy check.");
      fireEvent.click(button);
    }
    await flush();
    expect(f.copyText).not.toHaveBeenCalled();
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("offers Run checks again, which re-runs the read-only checks as a press and rebuilds", async () => {
    answered();
    const get = vi.fn((_trigger: string) => Promise.resolve(allOkHealth()));
    configureHealth({ api: { get } });
    const f = fixture();
    let refuse = true;
    const verify: VerifyAndSerialise = (bundle, denylist) =>
      refuse ? { ok: false, rule: "email" } : verifyAndSerialise(bundle, denylist);
    render(
      <DiagnosticBundleBlock
        host={f.host}
        connection={{ kind: "live" }}
        now={HEALTH_NOW}
        notify={f.notify}
        verify={verify}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show bundle preview" }));
    refuse = false;
    fireEvent.click(screen.getByRole("button", { name: "Run checks again" }));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Diagnostic bundle preview" })).toBeTruthy(),
    );
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("gesture");
    expect(f.notify).toHaveBeenCalledWith("Checked just now.");
    expect(screen.queryByRole("heading", { name: "Bundle not offered" })).toBeNull();
  });
});

describe("Task 3, Test 2: a hostile registry still yields a verified bundle that contains none of it", () => {
  const HOSTILE_NAMES = [
    // A real-looking home path, assembled at run time so no literal one sits in a tracked file.
    `${"/Use"}rs/alice-example/code/secret`,
    "owner@example.org",
    "Plumcellar Ledger",
    "ünïcödé  Project",
    "a.b(c)[d]*",
    "UPPER lower 日本語",
  ];

  it("offers the bundle, and neither the names, the vault name nor the user name appear in it", () => {
    answered();
    holdProjects([
      ...HOSTILE_NAMES.map((name, index) =>
        projectView({
          projectId: `project-${index}` as ProjectView["projectId"],
          displayName: name.slice(0, 64),
          displayPath: `~/work/${name.replace(/\//g, "-")}`,
          github: {
            kind: "github",
            label: `github.com/owner${index}-x/repo${index}-y`,
            source: "remote",
          },
        }),
      ),
      // Names that look like the bundle's own words or numbers must never block export.
      projectView({
        projectId: "project-w1" as ProjectView["projectId"],
        displayName: "setup",
        displayPath: "~/live",
        github: { kind: "none" },
      }),
      projectView({
        projectId: "project-w2" as ProjectView["projectId"],
        displayName: "2026",
        displayPath: "~/1.13",
        github: { kind: "none" },
      }),
    ]);
    const f = withDisplay(fixture(), { vaultName: "Marrow Vault ☃", userName: "zinnia.example" });
    const { container } = renderBlock(f);
    fireEvent.click(screen.getByRole("button", { name: "Show bundle preview" }));
    const preview = screen.getByRole("region", { name: "Diagnostic bundle preview" });
    expect(screen.queryByRole("heading", { name: "Bundle not offered" })).toBeNull();
    const text = (preview.textContent ?? "").toLowerCase();
    const squashed = text.replace(/[^\p{L}\p{N}]/gu, "");
    for (const name of [...HOSTILE_NAMES, "Marrow Vault ☃", "zinnia.example"]) {
      expect(text, name).not.toContain(name.toLowerCase());
      const flat = name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
      expect(squashed, name).not.toContain(flat);
    }
    expect(container.textContent).not.toContain("alice-example");
  });

  it("a bundle that really contains a project name is refused by the real verifier, naming the rule only", () => {
    // The builder cannot carry a name into the bundle, so this wraps the real verifier and hands it
    // a bundle with the project's name planted in a version field: the second check must catch it.
    answered();
    holdProjects([projectView({ displayName: "ccc-layout-widget" })]);
    const f = fixture();
    const verify: VerifyAndSerialise = (bundle, denylist) => {
      const tainted = {
        ...(bundle as object),
        versions: {
          plugin: "0.1.0",
          service: null,
          obsidian: "ccc-layout-widget",
          electron: null,
          node: null,
          storeSchema: null,
        },
      };
      return verifyAndSerialise(tainted, denylist);
    };
    render(
      <DiagnosticBundleBlock
        host={f.host}
        connection={{ kind: "live" }}
        now={HEALTH_NOW}
        notify={f.notify}
        verify={verify}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show bundle preview" }));
    expect(screen.getByRole("heading", { level: 5, name: "Bundle not offered" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("ccc-layout-widget");
  });
});

describe("Task 3, Test 3: with the service away the bundle is still offered from plugin-local data", () => {
  it("shows the explanatory line and null counts, with the service row failing and the rest unknown", () => {
    const f = fixture();
    renderBlock(f, { kind: "disconnected", reason: "ECONNREFUSED /Users/username/x" });
    fireEvent.click(screen.getByRole("button", { name: "Show bundle preview" }));
    const preview = screen.getByRole("region", { name: "Diagnostic bundle preview" });
    expect(
      screen.getByText(
        "The companion service isn't running, so service versions and counts are left out.",
      ),
    ).toBeTruthy();
    const parsed = JSON.parse(preview.textContent ?? "{}") as {
      counts: Record<string, number | null>;
      versions: Record<string, string | null>;
      subsystems: { id: string; status: string }[];
    };
    expect(parsed.counts.projects).toBeNull();
    expect(parsed.counts.scanFolders).toBeNull();
    expect(parsed.counts.openTasks).toBeNull();
    expect(parsed.counts.reports).toBeNull();
    expect(parsed.versions.service).toBeNull();
    expect(parsed.subsystems.find((row) => row.id === "service")?.status).toBe("failing");
    expect(
      parsed.subsystems
        .filter((row) => row.id !== "service")
        .every((row) => row.status === "unknown"),
    ).toBe(true);
    expect(preview.textContent).not.toContain("ECONNREFUSED");
    expect(
      screen.getByRole("button", { name: "Copy bundle" }).getAttribute("aria-disabled"),
    ).toBeNull();
  });

  it("a held answer from before the disconnect is not used", () => {
    answered();
    const f = fixture();
    renderBlock(f, { kind: "disconnected", reason: "x" });
    fireEvent.click(screen.getByRole("button", { name: "Show bundle preview" }));
    expect(screen.getByRole("region", { name: "Diagnostic bundle preview" }).textContent).toBe(
      expectedText(f, { connection: "disconnected", health: null }),
    );
  });

  it.each([{ kind: "disconnected", reason: "x" } as const, { kind: "connecting" } as const])(
    "FIX6B: with the connection $kind, last-good launcher and transcript values are reported as unknown, not current",
    (connection) => {
      answered();
      claudeIntegration.value = {
        hooks: "not-installed",
        hookRuntimeMissing: false,
        disableAllHooks: null,
        lastEventAt: null,
        telemetry: { kind: "ok" },
        detectedClaudeVersion: null,
        statusLine: "not-installed",
        statusLineReported: false,
        transcriptAnalysis: { enabled: true },
        spoolDropCount: 0,
        unknownEventCount: 0,
        cleanupPeriodDays: 30,
      };
      projectsSnapshot.value = {
        projects: [],
        launchers: { ...EMPTY_PROJECTS_SNAPSHOT.launchers, antigravity: "set-up" as const },
      };
      const f = fixture();
      renderBlock(f, connection);
      fireEvent.click(screen.getByRole("button", { name: "Show bundle preview" }));
      const text = screen.getByRole("region", { name: "Diagnostic bundle preview" }).textContent;
      expect(text).toBe(
        expectedText(f, {
          connection: connection.kind,
          health: null,
          transcriptAnalysis: null,
          launchers: null,
        }),
      );
      const features = (
        JSON.parse(text ?? "{}") as {
          features: { transcriptAnalysis: unknown; launchers: { antigravity: unknown } };
        }
      ).features;
      expect(features.transcriptAnalysis).toBeNull();
      expect(features.launchers.antigravity).toBeNull();
    },
  );

  it("a failed check with the service up says the checks couldn't run and still offers the bundle", () => {
    healthPhase.value = "error";
    const f = fixture();
    renderBlock(f);
    fireEvent.click(screen.getByRole("button", { name: "Show bundle preview" }));
    expect(
      screen.getByText("The checks couldn't run, so service versions and counts are left out."),
    ).toBeTruthy();
    expect(screen.getByRole("region", { name: "Diagnostic bundle preview" })).toBeTruthy();
  });
});

describe("Task 3, Test 4: a preview built from checks older than five minutes says so", () => {
  const STALE_NOW = Date.parse("2026-10-22T09:06:00.000Z");

  it("adds the stale line and a Run checks again action that re-checks as a press", async () => {
    answered();
    const get = vi.fn((_trigger: string) => Promise.resolve(allOkHealth()));
    configureHealth({ api: { get } });
    const f = fixture();
    renderBlock(f, { kind: "live" }, STALE_NOW);
    fireEvent.click(screen.getByRole("button", { name: "Show bundle preview" }));
    expect(screen.getByText("Built from checks older than 5 minutes")).toBeTruthy();
    expect(get).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Run checks again" }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    expect(get).toHaveBeenCalledWith("gesture");
  });

  it("a fresh answer has neither the line nor the action", () => {
    answered();
    const f = fixture();
    renderBlock(f);
    fireEvent.click(screen.getByRole("button", { name: "Show bundle preview" }));
    expect(screen.queryByText("Built from checks older than 5 minutes")).toBeNull();
    expect(screen.queryByRole("button", { name: "Run checks again" })).toBeNull();
  });

  it("the stale line appears when the clock moves on while the preview is open, without a fetch", () => {
    answered();
    const get = vi.fn((_trigger: string) => Promise.resolve(allOkHealth()));
    configureHealth({ api: { get } });
    const f = fixture();
    const { rerender } = renderBlock(f);
    fireEvent.click(screen.getByRole("button", { name: "Show bundle preview" }));
    rerender(
      <DiagnosticBundleBlock
        host={f.host}
        connection={{ kind: "live" }}
        now={STALE_NOW}
        notify={f.notify}
      />,
    );
    expect(screen.getByText("Built from checks older than 5 minutes")).toBeTruthy();
    expect(get).not.toHaveBeenCalled();
  });
});

describe("FIX4B m2: a check the service going away cancels does not leave Checking… on the status line", () => {
  const STALE_NOW = Date.parse("2026-10-22T09:06:00.000Z");

  it("Run checks again posts the error line when its check was superseded", async () => {
    answered();
    let release!: () => void;
    configureHealth({
      api: {
        get: () =>
          new Promise((resolve) => {
            release = () => resolve(allOkHealth());
          }),
      },
    });
    const f = fixture();
    renderBlock(f, { kind: "live" }, STALE_NOW);
    fireEvent.click(screen.getByRole("button", { name: "Show bundle preview" }));
    fireEvent.click(screen.getByRole("button", { name: "Run checks again" }));
    expect(f.notify).toHaveBeenLastCalledWith("Checking…");
    // The service goes away mid-check: the fetch in flight is dropped, no newer one replaces it.
    await act(async () => {
      clearHealth();
    });
    release();
    await flush();
    expect(f.notify).toHaveBeenLastCalledWith("Couldn't run the checks.");
  });
});

describe("FIX4B m6: the open preview rebuilds when any input it is built from changes", () => {
  function preview(): string {
    return screen.getByRole("region", { name: "Diagnostic bundle preview" }).textContent ?? "";
  }

  function open(f: Fixture) {
    answered();
    const view = renderBlock(f);
    fireEvent.click(screen.getByRole("button", { name: "Show bundle preview" }));
    return view;
  }

  it("a changed transcript-analysis flag rebuilds the preview", async () => {
    const f = fixture();
    open(f);
    const before = preview();
    expect(before).toBe(expectedText(f));
    await act(async () => {
      claudeIntegration.value = {
        hooks: "not-installed",
        hookRuntimeMissing: false,
        disableAllHooks: null,
        lastEventAt: null,
        telemetry: { kind: "ok" },
        detectedClaudeVersion: null,
        statusLine: "not-installed",
        statusLineReported: false,
        transcriptAnalysis: { enabled: true },
        spoolDropCount: 0,
        unknownEventCount: 0,
        cleanupPeriodDays: 30,
      };
    });
    expect(preview()).not.toBe(before);
    expect(preview()).toBe(expectedText(f, { transcriptAnalysis: true }));
  });

  it("a changed launcher summary in the projects snapshot rebuilds the preview", async () => {
    const f = fixture();
    open(f);
    const before = preview();
    const launchers = {
      ...EMPTY_PROJECTS_SNAPSHOT.launchers,
      antigravity: "set-up" as const,
    };
    await act(async () => {
      projectsSnapshot.value = { projects: [], launchers };
    });
    expect(preview()).not.toBe(before);
    expect(preview()).toBe(expectedText(f, { launchers }));
  });

  it("a new plugin diagnostic record rebuilds the preview", async () => {
    const f = fixture();
    open(f);
    const before = preview();
    const record = { source: "layout", code: "unknown-widget", message: "x", at: HEALTH_NOW_ISO };
    await act(async () => {
      recordDiagnostic(record);
    });
    expect(preview()).not.toBe(before);
    expect(preview()).toBe(expectedText(f, { diagnostics: [record] }));
  });

  it("a changed host setting (a feature flag) rebuilds the preview on the next render", () => {
    const f = fixture();
    const { rerender } = open(f);
    const before = preview();
    (f.host.settings as { notifyApprovals: boolean }).notifyApprovals = false;
    rerender(
      <DiagnosticBundleBlock
        host={f.host}
        connection={{ kind: "live" }}
        now={HEALTH_NOW}
        notify={f.notify}
      />,
    );
    expect(preview()).not.toBe(before);
    expect(preview()).toBe(expectedText(f));
    const parsed = JSON.parse(preview()) as { features: { notifyApprovals: boolean } };
    expect(parsed.features.notifyApprovals).toBe(false);
  });
});

describe("Task 3: loading and unavailable states", () => {
  it("while the first answer is awaited the preview is skeleton lines and the buttons wait", () => {
    healthPhase.value = "loading";
    const f = fixture();
    const { container } = renderBlock(f);
    fireEvent.click(screen.getByRole("button", { name: "Show bundle preview" }));
    expect(screen.queryByRole("region", { name: "Diagnostic bundle preview" })).toBeNull();
    expect(container.textContent).not.toContain("bundleVersion");
    expect(container.querySelectorAll(".ccc-skeleton-line").length).toBeGreaterThan(0);
    for (const name of ["Copy bundle", "Save bundle"]) {
      const button = screen.getByRole("button", { name });
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(describedBy(button)).toContain("Waiting for the checks.");
    }
  });

  it("builds the preview when the first answer lands", async () => {
    healthPhase.value = "loading";
    const f = fixture();
    renderBlock(f);
    fireEvent.click(screen.getByRole("button", { name: "Show bundle preview" }));
    await act(async () => {
      healthSignal.value = allOkHealth();
      healthPhase.value = "ready";
      healthVaultCheck.value = "match";
    });
    expect(screen.getByRole("region", { name: "Diagnostic bundle preview" }).textContent).toBe(
      expectedText(f),
    );
    expect(
      screen.getByRole("button", { name: "Copy bundle" }).getAttribute("aria-disabled"),
    ).toBeNull();
  });

  it("an unknown or malformed plugin version makes the export unavailable, never an invented version", () => {
    answered();
    const f = withDisplay(fixture(), { pluginVersion: "0.1.0-Plumcellar" });
    renderBlock(f);
    fireEvent.click(screen.getByRole("button", { name: "Show bundle preview" }));
    expect(screen.queryByRole("region", { name: "Diagnostic bundle preview" })).toBeNull();
    expect(screen.getByText("The bundle couldn't be built.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Plumcellar");
    for (const name of ["Copy bundle", "Save bundle"]) {
      expect(screen.getByRole("button", { name }).getAttribute("aria-disabled")).toBe("true");
    }
  });
});

describe("Task 3, Test 5: the bundle is held in memory only", () => {
  it("after Copy and Save the real plugin made no saveData call and its real settings are unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "ccc-bundle-mem-"));
    // The REAL plugin (FIX2B m8 technique): its settings object, its `saveData` and its host are
    // the ones production uses, so a stray write path would show up in `plugin.saved`.
    const plugin = new ClaudeCommandCenterPlugin(
      undefined as never,
      { id: "claude-command-center", version: "9.9.9" } as never,
    ) as ClaudeCommandCenterPlugin & StubObsidianPlugin;
    plugin.stored = null;
    try {
      const vault = join(root, "Vault");
      const outside = join(root, "out");
      mkdirSync(vault);
      mkdirSync(outside);
      await plugin.onload();
      const pluginHost = plugin.settingsHost as SettingsHost;
      expect(pluginHost.settings).toBe(plugin.settings);
      const savesBefore = plugin.saved.length;
      const settingsBefore = JSON.stringify(plugin.settings);
      const keysBefore = Object.keys(plugin.settings).sort();

      // `onload` wired the real export port; the display inputs are the only things replaced.
      expect(bundleExport().saveDialogAvailable()).toBe(true);
      remote.dialog.showSaveDialog = () =>
        Promise.resolve({ canceled: false, filePath: join(outside, "b.json") });
      answered();
      const base = fixture();
      const f: Fixture = {
        ...base,
        host: {
          ...pluginHost,
          copyText: base.copyText,
          display: {
            ...pluginHost.display,
            vaultBasePath: vault,
            pluginVersion: "0.1.0",
            obsidianVersion: "1.13.1",
          },
        },
      };
      renderBlock(f);
      fireEvent.click(screen.getByRole("button", { name: "Show bundle preview" }));
      fireEvent.click(screen.getByRole("button", { name: "Copy bundle" }));
      await flush();
      const before = f.notify.mock.calls.length;
      fireEvent.click(screen.getByRole("button", { name: "Save bundle" }));
      await waitFor(() => expect(f.notify.mock.calls.length).toBeGreaterThan(before));
      expect(f.notify).toHaveBeenLastCalledWith("Bundle saved.");

      // Nothing was handed to the plugin's data storage, and its settings object is untouched.
      expect(plugin.saved).toHaveLength(savesBefore);
      expect(JSON.stringify(plugin.settings)).toBe(settingsBefore);
      expect(Object.keys(plugin.settings).sort()).toEqual(keysBefore);
      expect(Object.keys(plugin.settings).sort()).toEqual([
        "lastOpenedDestination",
        "notifyApprovals",
        "reducedMotion",
        "socketPathOverride",
      ]);
      expect(() => assertNoPrivatePathValues(plugin.settings)).not.toThrow();
      expect(JSON.stringify(plugin.saved)).not.toContain("bundleVersion");
      expect(window.localStorage.length).toBe(0);
      expect(window.sessionStorage.length).toBe(0);
      // The vault received nothing; the only file is the one the owner picked.
      expect(readdirSync(vault)).toEqual([]);
      expect(readdirSync(outside)).toEqual(["b.json"]);
    } finally {
      cleanup();
      plugin.onunload();
      configureBundleExport(null);
      remote.dialog.showSaveDialog = () => Promise.resolve({ canceled: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hiding the preview drops the string from the page", () => {
    answered();
    const { container } = renderBlock(fixture());
    fireEvent.click(screen.getByRole("button", { name: "Show bundle preview" }));
    expect(container.textContent).toContain("bundleVersion");
    fireEvent.click(screen.getByRole("button", { name: "Hide bundle preview" }));
    expect(container.textContent).not.toContain("bundleVersion");
  });
});
