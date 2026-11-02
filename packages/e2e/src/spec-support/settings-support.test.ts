import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../repo-paths.js";
import type { ThemeReading } from "./contrast-probe.js";
import type { MotionSample } from "./cross-support.js";
import { findUnguardedMutations, MUTATING_HELPERS } from "./health-support.js";
import { SETTINGS_CLASSES, SETTINGS_SECTION_IDS, SETTINGS_TEXT } from "./settings-copy.js";
import {
  assertNoAbsolutePath,
  COPY_ACTIONS,
  checkAccountsRows,
  checkAnalysisStored,
  checkContrastReading,
  checkCopied,
  checkDataJson,
  checkDeleteDialog,
  checkDeleted,
  checkDetectionSettled,
  checkFocusNotMoved,
  checkIntegrationsNotSetUp,
  checkKeyboardWalk,
  checkLauncherSaved,
  checkLaunchersListed,
  checkNavigation,
  checkNoCredentialControl,
  checkNotifyApprovals,
  checkPaths,
  checkPending,
  checkRebuilt,
  checkReducedMotion,
  checkRegistered,
  checkSameReducedMotion,
  checkScanFolderListed,
  checkSchedules,
  checkSectionFocused,
  checkSectionSettled,
  checkSecurityFacts,
  checkServiceAway,
  checkSnapshotUnchanged,
  checkTranscriptSwitch,
  checkUsageEmptied,
  contrastSubjects,
  type DialogRead,
  dataJsonKeys,
  describeLogScan,
  type FocusStop,
  findAbsolutePathProblems,
  findInstallerProcesses,
  motionSelectOf,
  OVERVIEW_CONTRAST_SUBJECTS,
  openSection,
  readDataJson,
  readSettingsNav,
  rendererFocusNavItem,
  rendererReadReducedMotion,
  restoreSystemMotion,
  SETTINGS_DOM_CONFIG,
  SETTINGS_MUTATING_HELPERS,
  type SettingsButtonRead,
  type SettingsChipRead,
  type SettingsControlRead,
  type SettingsExtras,
  type SettingsFactRead,
  type SettingsRead,
  type SettingsRowRead,
  scanLogForPrivateText,
  snapshotDir,
  syntheticTranscriptLine,
  totalUsageRows,
  USAGE_COUNTS_SQL,
  USAGE_TABLES,
  walkTabStops,
  withBase,
} from "./settings-support.js";

/**
 * Plan 08-22 Task 1: the renderer reader of the Settings destination, run the way wdio runs it
 * (compiled by esbuild with keepNames as tsx does, sent as text, defined in a clean context that
 * has no `__name`) against a synthetic DOM that mirrors what the plugin's SettingsDestination and
 * SecuritySection render; the nav and focus verdicts; the click path that opens a section; and the
 * absolute-path finder that backs the privacy items.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
/** The users folder, built from parts so the privacy scan sees no home path in this file. */
const USERS = ["", "Users"].join("/");
const FIXTURE = join(HERE, "settings-dom-fixtures", "sections.html");
const SOURCE = readFileSync(join(HERE, "settings-support.ts"), "utf8");
const BASE_HTML = readFileSync(FIXTURE, "utf8");

interface EsbuildLike {
  transformSync(
    code: string,
    options: { loader: string; keepNames: boolean; format: string; target: string },
  ): { code: string };
}

function loadEsbuild(): EsbuildLike {
  const here = createRequire(import.meta.url);
  const vitePath = createRequire(here.resolve("vitest/package.json")).resolve("vite");
  return createRequire(vitePath)("esbuild") as EsbuildLike;
}

interface JsdomWindow extends Record<string, unknown> {
  document: {
    querySelector(selector: string): { focus(): void } | null;
  };
}

function loadJsdom(): { JSDOM: new (html: string) => { window: JsdomWindow } } {
  return createRequire(join(REPO_ROOT, "packages", "plugin", "package.json"))("jsdom");
}

function declarationOf(name: string): string {
  const start = SOURCE.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, "m"));
  if (start < 0) throw new Error(`no declaration of ${name}`);
  const end = SOURCE.indexOf("\n}\n", start);
  return SOURCE.slice(start, end + 2);
}

/** The text wdio would send for a renderer function: compiled with keepNames, then toString(). */
function rendererText(name: string): string {
  const compiled = loadEsbuild().transformSync(declarationOf(name), {
    loader: "ts",
    keepNames: true,
    format: "cjs",
    target: "es2022",
  }).code;
  const loader = {
    __name: (fn: unknown) => fn,
    module: { exports: {} },
    exports: {},
    out: undefined as unknown,
  };
  vm.runInNewContext(`${compiled}\nout = ${name};`, loader);
  return String(loader.out);
}

/** Reads `html` with the renderer reader; `focus` names a selector to focus first. */
function readSettingsFrom(html: string, focus?: string): SettingsRead {
  const { JSDOM } = loadJsdom();
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
  const window = dom.window;
  if (focus !== undefined) window.document.querySelector(focus)?.focus();
  const context = vm.createContext({
    document: window.document,
    window,
    getComputedStyle: (window.getComputedStyle as (n: unknown) => unknown).bind(window),
  });
  const text = rendererText("rendererReadSettings");
  const out = vm.runInContext(
    `(${text}).apply(null, ${JSON.stringify([SETTINGS_DOM_CONFIG])})`,
    context,
  );
  return JSON.parse(JSON.stringify(out)) as SettingsRead;
}

const base = readSettingsFrom(BASE_HTML);

describe("rendererReadSettings (Test 2)", () => {
  it("never mentions the keepNames helper in the text it sends to the renderer", () => {
    expect(rendererText("rendererReadSettings")).not.toContain("__name");
  });

  it("reads the frame: mounted, heading, description and the quiet status line", () => {
    expect(base.mounted).toBe(true);
    expect(base.heading).toBe("Settings");
    expect(base.description).toBe("Plugin configuration and diagnostics.");
    expect(base.statusLine).toBe("");
    expect(base.statusRole).toBe("status");
  });

  it("reads the nine nav items in order with the current one and the roving tab stop", () => {
    expect(base.nav.map((item) => item.label)).toEqual([
      "Projects",
      "Launchers",
      "Integrations",
      "Approvals and tasks",
      "Paths",
      "Visual",
      "Security",
      "Schedules",
      "Diagnostics",
    ]);
    expect(base.nav.filter((item) => item.current).map((item) => item.label)).toEqual(["Security"]);
    expect(base.nav.filter((item) => item.tabIndex === "0").map((item) => item.label)).toEqual([
      "Security",
    ]);
    expect(base.nav.every((item) => !item.focused)).toBe(true);
  });

  it("reads the section heading and whether it holds focus", () => {
    expect(base.section.heading).toBe("Security");
    expect(base.section.headingTabIndex).toBe("-1");
    expect(base.section.headingFocused).toBe(false);
    const focused = readSettingsFrom(BASE_HTML, ".ccc-settings-content h3");
    expect(focused.section.headingFocused).toBe(true);
    expect(focused.focus?.isSectionHeading).toBe(true);
    expect(focused.focus?.inContent).toBe(true);
  });

  it("reads which nav item holds focus", () => {
    const onNav = readSettingsFrom(BASE_HTML, '[aria-current="page"]');
    expect(onNav.nav.findIndex((item) => item.focused)).toBe(6);
    expect(onNav.focus?.inNav).toBe(true);
    expect(onNav.focus?.label).toBe("Security");
  });

  it("reads the label and value facts with their chips, code, buttons and loading state", () => {
    expect(base.facts.map((fact) => fact.name)).toEqual([
      "Service connection",
      "Network listener",
      "Connection tokens",
      "Install secret in keychain",
      "Research key in keychain",
      "Approval presence check",
      "Always allow",
    ]);
    const install = base.facts.find((fact) => fact.name === "Install secret in keychain");
    expect(install?.chips).toEqual([{ status: "ok", word: "Present" }]);
    expect(install?.stale).toBe(false);
    const research = base.facts.find((fact) => fact.name === "Research key in keychain");
    expect(research?.chips).toEqual([{ status: "setup-needed", word: "Needs setup" }]);
    expect(research?.code).toEqual(["node scripts/research-key-setup.mjs"]);
    expect(research?.buttons).toEqual(["Copy key setup command"]);
    const presence = base.facts.find((fact) => fact.name === "Approval presence check");
    expect(presence?.chips).toEqual([{ status: "failing", word: "Unavailable" }]);
    expect(presence?.text).toContain("Approvals for connectors need Touch ID or your password");
    expect(base.facts.every((fact) => !fact.loading && !fact.unknown)).toBe(true);
    expect(base.facts.find((fact) => fact.name === "Always allow")?.text).toBe(
      "No always-allow control exists. Every consequential action asks you each time.",
    );
  });

  it("reads the setting rows: a switch, a button with a result line, and a pointer button", () => {
    expect(base.rows.map((row) => row.name)).toEqual([
      "Transcript analysis",
      "Delete cached usage analytics",
      "Approval notifications",
    ]);
    const analysis = base.rows[0];
    expect(analysis?.control).toMatchObject({
      kind: "switch",
      checked: false,
      disabled: false,
      busy: false,
      label: "Off",
    });
    const remove = base.rows[1];
    expect(remove?.control.kind).toBe("button");
    expect(remove?.control.label).toBe("Delete cached usage analytics");
    expect(remove?.results).toEqual([
      { key: "delete-usage", text: "Cached usage analytics deleted." },
    ]);
    const pointer = base.rows[2];
    expect(pointer?.control.label).toBe("Go to the approvals and tasks section");
    expect(pointer?.control.describedText).toEqual([
      "Approval notifications are in the approvals and tasks section.",
    ]);
  });

  it("lists every button of the section and counts no input", () => {
    expect(base.buttons.map((button) => button.label)).toEqual([
      "Copy key setup command",
      "Off",
      "Delete cached usage analytics",
      "Go to the approvals and tasks section",
    ]);
    expect(base.inputs).toBe(0);
    expect(base.results).toEqual([
      { key: "delete-usage", text: "Cached usage analytics deleted." },
    ]);
  });

  it("reads a service-away section: aria-disabled controls with the reason they are described by", () => {
    const away = BASE_HTML.replace(
      '<button type="button" role="switch" class="ccc-switch" aria-checked="false" aria-labelledby="row-analysis" aria-describedby="desc-analysis">',
      '<button type="button" role="switch" class="ccc-switch" aria-checked="false" aria-labelledby="row-analysis" aria-describedby="desc-analysis reason-analysis" aria-disabled="true">',
    ).replace(
      '<p id="desc-analysis">Count tokens from Claude Code\'s local transcripts.</p>',
      '<p id="desc-analysis">Count tokens from Claude Code\'s local transcripts.</p><p id="reason-analysis">The companion service isn\'t running.</p>',
    );
    const read = readSettingsFrom(away);
    const control = read.rows[0]?.control;
    expect(control?.disabled).toBe(true);
    expect(control?.describedText).toEqual([
      "Count tokens from Claude Code's local transcripts.",
      "The companion service isn't running.",
    ]);
  });

  it("reads the display paths, the unknown marker and the inputs of a Paths-like section", () => {
    const paths = BASE_HTML.replace(
      /<dl class="ccc-detail-fields">[\s\S]*?<\/dl>/,
      `<dl class="ccc-detail-fields">
        <dt>Managed vault</dt><dd><p><code class="ccc-setting-path">…/vaults/live</code></p></dd>
        <dt>Service data folder</dt><dd><p class="ccc-setting-unknown">Unknown</p><p>No managed vault is set up yet.</p></dd>
        <dt>Service socket</dt><dd><p><code class="ccc-setting-path">~/socket/svc.sock</code></p></dd>
      </dl><input type="text" value="x">`,
    );
    const read = readSettingsFrom(paths);
    expect(read.paths).toEqual(["…/vaults/live", "~/socket/svc.sock"]);
    expect(read.facts.map((fact) => [fact.name, fact.unknown])).toEqual([
      ["Managed vault", false],
      ["Service data folder", true],
      ["Service socket", false],
    ]);
    expect(read.inputs).toBe(1);
  });

  it("reads nothing as mounted when the destination is not on the page", () => {
    const empty = readSettingsFrom("<div></div>");
    expect(empty.mounted).toBe(false);
    expect(empty.nav).toEqual([]);
    expect(empty.facts).toEqual([]);
  });
});

describe("readSettingsNav and checkNavigation (Test 2)", () => {
  it("projects the read into nine items with label, current and tab stop", () => {
    const nav = readSettingsNav(base);
    expect(nav).toHaveLength(9);
    expect(nav[6]).toEqual({ label: "Security", current: true, tabStop: true, focused: false });
    expect(nav.filter((item) => item.tabStop)).toHaveLength(1);
  });

  it("accepts the nine items with one current item that is the one tab stop", () => {
    expect(checkNavigation(base)).toEqual([]);
  });

  it("flags a missing item, a second current item and a second tab stop", () => {
    const missing = { ...base, nav: base.nav.filter((item) => item.label !== "Paths") };
    expect(checkNavigation(missing).join(" ")).toContain("nine");
    const two = {
      ...base,
      nav: base.nav.map((item) => (item.label === "Paths" ? { ...item, current: true } : item)),
    };
    expect(checkNavigation(two).join(" ")).toContain("current");
    const stops = {
      ...base,
      nav: base.nav.map((item) => (item.label === "Paths" ? { ...item, tabIndex: "0" } : item)),
    };
    expect(checkNavigation(stops).join(" ")).toContain("tab stop");
  });

  it("flags a nav that is not in the destination", () => {
    expect(checkNavigation(readSettingsFrom("<div></div>"))).toEqual([
      "the Settings destination is not on the page",
    ]);
  });

  it("flags items in the wrong order", () => {
    const swapped = { ...base, nav: [...base.nav].reverse() };
    expect(checkNavigation(swapped).join(" ")).toContain("order");
  });
});

describe("checkSectionFocused and checkFocusNotMoved (Test 2)", () => {
  it("accepts a section whose heading reads the label and holds focus", () => {
    const focused = readSettingsFrom(BASE_HTML, ".ccc-settings-content h3");
    expect(checkSectionFocused(focused, "Security")).toEqual([]);
  });

  it("flags a heading that does not hold focus and one that names another section", () => {
    expect(checkSectionFocused(base, "Security")).toEqual([
      "the Security heading does not hold keyboard focus",
    ]);
    const focused = readSettingsFrom(BASE_HTML, ".ccc-settings-content h3");
    expect(checkSectionFocused(focused, "Paths")).toEqual([
      'the section heading reads "Security", not "Paths"',
    ]);
  });

  it("accepts a Settings tab opened without moving focus into the destination", () => {
    expect(checkFocusNotMoved(base)).toEqual([]);
    const onNav = readSettingsFrom(BASE_HTML, '[aria-current="page"]');
    expect(checkFocusNotMoved(onNav).join(" ")).toContain("moved");
    const onHeading = readSettingsFrom(BASE_HTML, ".ccc-settings-content h3");
    expect(checkFocusNotMoved(onHeading).join(" ")).toContain("moved");
  });
});

/** Runs a renderer function over `html` the way wdio does and returns its result. */
function runRenderer(name: string, html: string, args: unknown[]): unknown {
  const { JSDOM } = loadJsdom();
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
  const window = dom.window;
  const context = vm.createContext({
    document: window.document,
    window,
    getComputedStyle: (window.getComputedStyle as (n: unknown) => unknown).bind(window),
  });
  const out = vm.runInContext(
    `(${rendererText(name)}).apply(null, ${JSON.stringify(args)})`,
    context,
  );
  const reread = vm.runInContext(
    "document.activeElement && document.activeElement.textContent",
    context,
  );
  return { out, active: reread };
}

describe("rendererFocusNavItem (Test 2)", () => {
  it("focuses the nav item with the given label and reports whether focus landed", () => {
    const found = runRenderer("rendererFocusNavItem", BASE_HTML, [
      SETTINGS_CLASSES.settingsNav,
      SETTINGS_CLASSES.settingsNavItem,
      "Schedules",
    ]) as { out: boolean; active: string };
    expect(found.out).toBe(true);
    expect(found.active).toBe("Schedules");
  });

  it("returns false for a label the nav does not hold", () => {
    const missing = runRenderer("rendererFocusNavItem", BASE_HTML, [
      SETTINGS_CLASSES.settingsNav,
      SETTINGS_CLASSES.settingsNavItem,
      "Nowhere",
    ]) as { out: boolean };
    expect(missing.out).toBe(false);
  });

  it("never mentions the keepNames helper in the text it sends to the renderer", () => {
    expect(typeof rendererFocusNavItem).toBe("function");
    expect(rendererText("rendererFocusNavItem")).not.toContain("__name");
  });
});

describe("openSection (Test 2)", () => {
  it("builds the click path: the Settings tab, then the section's nav item by its label", () => {
    expect(openSection("diagnostics")).toEqual([
      { selector: "#ccc-tab-settings", text: null },
      {
        selector: 'nav[aria-label="Settings sections"] button.ccc-settings-nav-item',
        text: "Diagnostics",
      },
    ]);
    expect(openSection("approvals-tasks")[1]?.text).toBe("Approvals and tasks");
  });

  it("reads the tab id and the nav label from the mirrored copy", () => {
    expect(openSection("visual")[0]?.selector).toBe(`#ccc-tab-${SETTINGS_TEXT.settingsTabId}`);
  });
});

describe("findAbsolutePathProblems and assertNoAbsolutePath (Test 2)", () => {
  const facts = {
    runRoot: "/private/var/folders/xx/T/ccc-uat.AbC123",
    homeDir: `${USERS}/janedoe`,
    userName: "janedoe",
  };

  it("flags a macOS home path, a Linux home path, the run root, the home folder and the user name", () => {
    expect(findAbsolutePathProblems(`see ${USERS}/janedoe/code/app`, facts)).toEqual(
      expect.arrayContaining(["a macOS home path", "the home folder", "the user name"]),
    );
    expect(findAbsolutePathProblems("at /home/someone/x", facts)).toEqual(["a Linux home path"]);
    expect(findAbsolutePathProblems(`socket ${facts.runRoot}/rt/svc.sock`, facts)).toContain(
      "the run root",
    );
  });

  it("accepts display paths, the documented placeholder and prose", () => {
    expect(
      findAbsolutePathProblems("~/Notes and …/vaults/live and /Users/USERNAME/code", facts),
    ).toEqual([]);
    expect(findAbsolutePathProblems("Managed vault is ready.", facts)).toEqual([]);
  });

  it("does not treat a short or common user name as a leak", () => {
    expect(findAbsolutePathProblems("I am to blame", { ...facts, userName: "to" })).toEqual([]);
    expect(findAbsolutePathProblems("", facts)).toEqual([]);
  });

  it("throws with the categories only, never the text found", () => {
    expect(() => assertNoAbsolutePath(`a ${USERS}/janedoe/secret-project/x b`, facts)).toThrow(
      /macOS home path/,
    );
    try {
      assertNoAbsolutePath(`a ${USERS}/janedoe/secret-project/x b`, facts);
    } catch (error) {
      expect(String(error)).not.toContain("secret-project");
      expect(String(error)).not.toContain("janedoe");
    }
    expect(() => assertNoAbsolutePath("~/fine", facts)).not.toThrow();
  });
});

// ===========================================================================
// Plan 08-22 Task 2: items 10 to 18 and 34

const AWAY = SETTINGS_TEXT.serviceAway;

const BLANK: SettingsRead = {
  mounted: true,
  heading: "Settings",
  description: "",
  statusLine: "",
  statusRole: "status",
  nav: [],
  section: { heading: "", headingFocused: false, headingTabIndex: null },
  focus: null,
  facts: [],
  rows: [],
  buttons: [],
  inputs: 0,
  paths: [],
  results: [],
  subheads: [],
  paragraphs: [],
  statusTexts: [],
  text: "",
  busy: false,
};

function fact(name: string, over: Partial<SettingsFactRead> = {}): SettingsFactRead {
  return {
    name,
    text: "",
    lines: [],
    chips: [],
    stale: false,
    code: [],
    unknown: false,
    loading: false,
    buttons: [],
    ...over,
  };
}

function control(over: Partial<SettingsControlRead> = {}): SettingsControlRead {
  return {
    kind: "button",
    label: "",
    checked: null,
    value: null,
    options: [],
    disabled: false,
    busy: false,
    describedText: [],
    ...over,
  };
}

function row(name: string, over: Partial<SettingsControlRead> = {}): SettingsRowRead {
  return {
    name,
    paragraphs: [],
    control: control({ label: name, ...over }),
    results: [],
    chips: [],
  };
}

function button(label: string, disabled = false): SettingsButtonRead {
  return { label, name: null, disabled, busy: false };
}

function section(over: Partial<SettingsRead>): SettingsRead {
  return { ...BLANK, ...over };
}

/** Runs a renderer function over `html` with `setup` run on the document first. */
function runWith(
  name: string,
  html: string,
  args: unknown[],
  setup: (window: JsdomWindow) => void = () => {},
): unknown {
  const { JSDOM } = loadJsdom();
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
  const window = dom.window;
  setup(window);
  const context = vm.createContext({
    document: window.document,
    window,
    Event: window.Event,
    getComputedStyle: (window.getComputedStyle as (n: unknown) => unknown).bind(window),
  });
  return JSON.parse(
    JSON.stringify(
      vm.runInContext(`(${rendererText(name)}).apply(null, ${JSON.stringify(args)})`, context) ??
        null,
    ),
  );
}

describe("renderer helpers of the section cases (Test 2)", () => {
  const PANELS = `<div class="ccc-settings-content">
    <h3 tabindex="-1">Launchers</h3>
    <p class="ccc-list-meta">1 of 3 launchers set up</p>
    <button type="button" class="ccc-connect-button">Detect apps</button>
    <p class="ccc-launch-status">Detected 2 minutes ago</p>
    <section class="ccc-card ccc-launcher-panel"><h4 class="ccc-section-label">Antigravity</h4>
      <span class="ccc-badge" data-launcher-badge="not-set-up">Not set up</span>
      <button type="button" class="ccc-connect-button" aria-disabled="true">Save launcher</button></section>
    <section class="ccc-card ccc-launcher-panel"><h4 class="ccc-section-label">Claude Code</h4>
      <span class="ccc-badge" data-launcher-badge="set-up">Set up</span>
      <label for="p">Path to claude</label><input id="p" type="text">
      <button type="button" class="ccc-connect-button">Save launcher</button></section>
    <ul><li class="ccc-scan-folder-row"><p class="ccc-display-path">…/tmp/scan-root</p><p class="ccc-list-meta">Not scanned yet</p></li></ul>
    <article class="ccc-card ccc-project-card"><h4 class="ccc-project-card-name">alpha-demo</h4></article>
  </div>`;

  it("presses the nth button of a scope with the given label, or reports it absent", () => {
    const pressed: string[] = [];
    const setup = (window: JsdomWindow): void => {
      const list = window.document as unknown as {
        querySelectorAll(s: string): ArrayLike<{
          addEventListener(t: string, l: () => void): void;
          textContent: string;
        }>;
      };
      const all = list.querySelectorAll("button");
      for (let i = 0; i < all.length; i += 1) {
        all[i]?.addEventListener("click", () => pressed.push(`${i}`));
      }
    };
    const scoped = (heading: string | null, label: string, nth: number) =>
      runWith(
        "rendererPressButton",
        PANELS,
        [{ scope: "section.ccc-launcher-panel", heading, label, nth }],
        setup,
      );
    expect(scoped("Claude Code", "Save launcher", 0)).toBe(true);
    expect(pressed).toEqual(["2"]);
    expect(scoped("Nowhere", "Save launcher", 0)).toBe(false);
    expect(scoped("Claude Code", "Save launcher", 1)).toBe(false);
    expect(scoped(null, "Save launcher", 1)).toBe(true);
    expect(pressed).toEqual(["2", "2"]);
  });

  it("types into the field a label names and tells the form's own handlers", () => {
    const seen: string[] = [];
    const typed = runWith(
      "rendererTypeByLabel",
      PANELS,
      ["Path to claude", "/some/place"],
      (window) => {
        (
          window.document as unknown as {
            querySelector(s: string): {
              addEventListener(t: string, l: (e: unknown) => void): void;
            };
          }
        )
          .querySelector("#p")
          .addEventListener("input", () => seen.push("input"));
      },
    );
    expect(typed).toBe(true);
    expect(seen).toEqual(["input"]);
    expect(runWith("rendererTypeByLabel", PANELS, ["No such label", "x"])).toBe(false);
  });

  it("chooses a select option by its visible text and fires change, or reports it absent", () => {
    const html = `<div class="ccc-settings-content"><div class="ccc-setting-row" role="group"><div class="ccc-setting-row-text"><span>Reduced motion</span></div><div class="ccc-setting-row-control"><span class="ccc-select-wrap"><select class="ccc-select"><option value="auto">System</option><option value="reduced">Always reduced</option></select></span></div></div></div>`;
    const changes: string[] = [];
    const setup = (window: JsdomWindow): void => {
      (
        window.document as unknown as {
          querySelector(s: string): {
            addEventListener(t: string, l: () => void): void;
            value: string;
          };
        }
      )
        .querySelector("select")
        .addEventListener("change", () => changes.push("change"));
    };
    const choose = (row: string, option: string) =>
      runWith("rendererChooseOption", html, [SETTINGS_DOM_CONFIG, row, option], setup);
    expect(choose("Reduced motion", "Always reduced")).toBe(true);
    expect(changes).toEqual(["change"]);
    expect(choose("Reduced motion", "Nope")).toBe(false);
    expect(choose("Other row", "System")).toBe(false);
  });

  it("presses the control of the named setting row", () => {
    const pressed: string[] = [];
    const setup = (window: JsdomWindow): void => {
      (
        window.document as unknown as {
          querySelector(s: string): { addEventListener(t: string, l: () => void): void };
        }
      )
        .querySelector('[role="switch"]')
        .addEventListener("click", () => pressed.push("switch"));
    };
    const press = (row: string) =>
      runWith("rendererPressRowControl", BASE_HTML, [SETTINGS_DOM_CONFIG, row], setup);
    expect(press("Transcript analysis")).toBe(true);
    expect(pressed).toEqual(["switch"]);
    expect(press("No such row")).toBe(false);
  });

  it("reads scan folders, launcher panels, the set-up line and project cards", () => {
    const extras = runWith("rendererReadExtras", PANELS, [
      {
        content: "ccc-settings-content",
        scanRow: "ccc-scan-folder-row",
        displayPath: "ccc-display-path",
        listMeta: "ccc-list-meta",
        panel: "ccc-launcher-panel",
        panelTitle: "ccc-section-label",
        launchStatus: "ccc-launch-status",
        projectCardName: "ccc-project-card-name",
        attrBadge: "data-launcher-badge",
        attrDisabled: "aria-disabled",
      },
    ]) as SettingsExtras;
    expect(extras.scanFolders).toEqual([{ path: "…/tmp/scan-root", meta: "Not scanned yet" }]);
    expect(extras.panels.map((panel) => [panel.title, panel.badge])).toEqual([
      ["Antigravity", "not-set-up"],
      ["Claude Code", "set-up"],
    ]);
    expect(extras.panels[0]?.buttons).toEqual([{ label: "Save launcher", disabled: true }]);
    expect(extras.setUpLine).toBe("1 of 3 launchers set up");
    expect(extras.detectLine).toBe("Detected 2 minutes ago");
    expect(extras.projectCards).toEqual(["alpha-demo"]);
  });

  it("returns the section markup, and nothing when the destination is absent", () => {
    const markup = runWith("rendererReadMarkup", BASE_HTML, [SETTINGS_CLASSES.settings]) as string;
    expect(markup.startsWith("<section")).toBe(true);
    expect(markup).toContain("Transcript analysis");
    expect(runWith("rendererReadMarkup", "<div></div>", [SETTINGS_CLASSES.settings])).toBe("");
  });

  it("lists the focusable controls of a section in tab order, hiding collapsed ones and collapsing radios", () => {
    const html = `<div class="ccc-settings-content"><h3 tabindex="-1">X</h3>
      <button type="button">First</button>
      <button type="button" aria-label="Second named" aria-disabled="true">Second</button>
      <div style="display:none"><button type="button">Hidden</button></div>
      <button type="button" tabindex="-1">Not a stop</button>
      <input type="radio" name="g" id="r1"><input type="radio" name="g" id="r2" checked>
      <input type="text" aria-label="Typed field">
      <select aria-label="Pick"><option>a</option></select></div>`;
    const list = runWith("rendererListFocusables", html, ["ccc-settings-content"]) as {
      label: string;
      tag: string;
    }[];
    expect(list.map((entry) => `${entry.tag}:${entry.label}`)).toEqual([
      "button:First",
      "button:Second named",
      "input:input",
      "input:Typed field",
      "select:Pick",
    ]);
  });

  it("reads the focused element as a tab stop with its ring facts", () => {
    const stop = runWith(
      "rendererReadFocusStop",
      `<div class="ccc-settings-content"><button type="button" id="b">Go</button></div>`,
      ["ccc-settings-content"],
      (window) => {
        (window.document as unknown as { querySelector(s: string): { focus(): void } })
          .querySelector("#b")
          .focus();
      },
    ) as FocusStop;
    expect(stop).toMatchObject({ label: "Go", tag: "button", inContent: true });
    expect(runWith("rendererReadFocusStop", "<div></div>", ["ccc-settings-content"])).toBeNull();
  });

  it("never mentions the keepNames helper in any renderer function it sends", () => {
    for (const name of [
      "rendererPressButton",
      "rendererTypeByLabel",
      "rendererChooseOption",
      "rendererPressRowControl",
      "rendererReadExtras",
      "rendererReadMarkup",
      "rendererListFocusables",
      "rendererReadFocusStop",
      "rendererOsPrefersReduced",
      "rendererReadReducedMotion",
      "rendererFocusNavItem",
    ]) {
      expect(rendererText(name), name).not.toContain("__name");
    }
  });
});

describe("the sandbox data file (Test 2, item 18)", () => {
  function runRoot(): string {
    return mkdtempSync(join("/tmp", "ccc-uat."));
  }

  it("reads the key set of a data file inside the run root", () => {
    const root = runRoot();
    try {
      const file = join(root, "data.json");
      writeFileSync(
        file,
        JSON.stringify({
          socketPathOverride: "x",
          lastOpenedDestination: "overview",
          reducedMotion: "auto",
          notifyApprovals: true,
        }),
      );
      expect(dataJsonKeys(file, root)).toEqual([
        "lastOpenedDestination",
        "notifyApprovals",
        "reducedMotion",
        "socketPathOverride",
      ]);
      expect(readDataJson(file, root).reducedMotion).toBe("auto");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a path outside the run root, a link and a file that is not an object", () => {
    const root = runRoot();
    const other = runRoot();
    try {
      const outside = join(other, "data.json");
      writeFileSync(outside, "{}");
      expect(() => dataJsonKeys(outside, root)).toThrow(/outside the run root/);
      const link = join(root, "link.json");
      symlinkSync(outside, link);
      expect(() => dataJsonKeys(link, root)).toThrow();
      const list = join(root, "list.json");
      writeFileSync(list, "[1]");
      expect(() => dataJsonKeys(list, root)).toThrow(/not a JSON object/);
      expect(() => dataJsonKeys(join(root, "missing.json"), root)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("accepts exactly the four keys with plain values and names every deviation", () => {
    const good = {
      socketPathOverride: "/tmp/ccc-uat.x/rt/svc.sock",
      lastOpenedDestination: "settings",
      reducedMotion: "auto",
      notifyApprovals: true,
    };
    expect(checkDataJson(good)).toEqual([]);
    expect(checkDataJson({ ...good, extra: 1 })).toEqual(["the data file holds the key extra"]);
    const { notifyApprovals: _gone, ...fewer } = good;
    expect(checkDataJson(fewer)).toEqual(["the data file lacks the key notifyApprovals"]);
    expect(checkDataJson({ ...good, reducedMotion: "maybe" })).toEqual([
      "reducedMotion holds an unknown value",
    ]);
    expect(checkDataJson({ ...good, notifyApprovals: "yes" })).toEqual([
      "notifyApprovals is not a boolean",
    ]);
    expect(checkDataJson({ ...good, token: "x" }).join(" ")).toContain("token");
  });
});

describe("scanLogForPrivateText (Test 3, item 18)", () => {
  const facts = {
    runRoot: "/tmp/ccc-uat.AbC123",
    homeDir: `${USERS}/janedoe`,
    userName: "janedoe",
    projectNames: ["alpha-demo"],
  };

  it("reports nothing for a log of event names and ids", () => {
    const log = [
      '{"level":30,"msg":"listening","socketPath":"/tmp/ccc-uat.AbC123/rt/svc.sock"}',
      '{"level":30,"msg":"request","route":"/api/v1/health","status":200}',
      '{"level":30,"msg":"proposal","proposalId":"prop-0001","state":"pending"}',
    ].join("\n");
    expect(scanLogForPrivateText(log, facts)).toEqual({});
  });

  it("counts a home path, the run root outside the startup line, a project name and a token shape by category", () => {
    const log = [
      '{"msg":"listening","socketPath":"/tmp/ccc-uat.AbC123/rt/svc.sock"}',
      `{"msg":"scan","path":"${USERS}/janedoe/code/x"}`,
      '{"msg":"open","path":"/tmp/ccc-uat.AbC123/vaults/live"}',
      '{"msg":"register","name":"alpha-demo"}',
      '{"msg":"auth","header":"Bearer abcdefghijklmnopqrstuvwxyz0123456789"}',
      '{"msg":"key","value":"sk-ant-abcdefgh12345678"}',
    ].join("\n");
    expect(scanLogForPrivateText(log, facts)).toEqual({
      "home path": 1,
      "run root": 1,
      "project name": 1,
      "token shape": 2,
    });
  });

  it("does not take a UUID or a plain hash for a token", () => {
    const log =
      '{"msg":"run","runId":"123e4567-e89b-12d3-a456-426614174000","etag":"abcdef0123456789"}';
    expect(scanLogForPrivateText(log, facts)).toEqual({});
  });

  it("describes a finding without the text found", () => {
    expect(describeLogScan({ "home path": 2, "token shape": 1 })).toEqual([
      "the log holds 2 home path lines",
      "the log holds 1 token shape line",
    ]);
    expect(describeLogScan({})).toEqual([]);
  });
});

describe("the project and scan folder verdicts (Test 2, item 10)", () => {
  it("accepts a registered project that the status line, the store and the destination agree on", () => {
    expect(
      checkRegistered({
        statusLine: "Registered alpha-demo.",
        name: "alpha-demo",
        storeNames: ["alpha-demo"],
        cardNames: ["alpha-demo", "other"],
      }),
    ).toEqual([]);
  });

  it("names each place that disagrees", () => {
    const problems = checkRegistered({
      statusLine: "Registering…",
      name: "alpha-demo",
      storeNames: [],
      cardNames: [],
    });
    expect(problems).toHaveLength(3);
    expect(problems.join(" ")).toContain("status line");
    expect(problems.join(" ")).toContain("store");
    expect(problems.join(" ")).toContain("Projects destination");
  });

  it("accepts a listed scan folder with a display path and a store row", () => {
    expect(
      checkScanFolderListed({
        rows: [{ path: "~/code/settings-scan", meta: "Not scanned yet" }],
        folderName: "settings-scan",
        storeRoots: 1,
      }),
    ).toEqual([]);
  });

  it("accepts an outside-home folder shown as it is: Phase 4 shows only the home folder as ~", () => {
    // The sandbox scan folder lives under /tmp. The service's project display rule returns an
    // outside-home path unchanged, and such a path carries no user segment, so it leaks nothing.
    expect(
      checkScanFolderListed({
        rows: [{ path: "/tmp/ccc-uat.AbC123/settings-scan", meta: "Not scanned yet" }],
        folderName: "settings-scan",
        storeRoots: 1,
        facts: { homeDir: "/Users/username", userName: "username" },
      }),
    ).toEqual([]);
  });

  it("flags a row that shows the home folder or the user name", () => {
    const facts = { homeDir: "/Users/username", userName: "username" };
    for (const path of [
      "/Users/username/code/settings-scan",
      "/Volumes/username-backup/settings-scan",
    ]) {
      const problems = checkScanFolderListed({
        rows: [{ path, meta: "" }],
        folderName: "settings-scan",
        storeRoots: 1,
        facts,
      });
      expect(problems.join(" "), path).toContain("private location");
    }
  });

  it("flags a missing row, a home path and an empty store", () => {
    const problems = checkScanFolderListed({
      rows: [{ path: `${USERS}/someone/settings-scan`, meta: "" }],
      folderName: "other",
      storeRoots: 0,
    });
    expect(problems.join(" ")).toContain("no scan folder row");
    expect(problems.join(" ")).toContain("private location");
    expect(problems.join(" ")).toContain("store holds no scan folder");
  });
});

describe("the launcher verdicts (Test 2, item 11)", () => {
  const extras = (over: Partial<SettingsExtras> = {}): SettingsExtras => ({
    scanFolders: [],
    panels: [
      {
        title: "Antigravity",
        badge: "not-set-up",
        buttons: [{ label: "Save launcher", disabled: false }],
      },
      {
        title: "Claude Code",
        badge: "not-set-up",
        buttons: [{ label: "Save launcher", disabled: false }],
      },
      {
        title: "Claude Desktop",
        badge: "not-set-up",
        buttons: [{ label: "Save launcher", disabled: false }],
      },
    ],
    setUpLine: "0 of 3 launchers set up",
    detectLine: "Detected just now",
    projectCards: [],
    ...over,
  });

  it("accepts the three configurable panels with a detect line and a set-up count", () => {
    expect(checkLaunchersListed(extras())).toEqual([]);
  });

  it("reads a detection still running as not settled, and a finished or failed one as settled", () => {
    // The Detect apps control is aria-disabled while it runs, so a contrast reading taken then
    // cannot measure it (disabled controls are exempt).
    expect(checkDetectionSettled(extras({ detectLine: "Detecting apps…" }))).toEqual([
      "the app detection is still running",
    ]);
    expect(checkDetectionSettled(extras({ detectLine: "" }))).toEqual([
      "the app detection is still running",
    ]);
    expect(checkDetectionSettled(extras())).toEqual([]);
    expect(checkDetectionSettled(extras({ detectLine: "Couldn't detect apps." }))).toEqual([]);
  });

  it("flags a missing panel, a missing count and a detection that failed", () => {
    const problems = checkLaunchersListed(
      extras({ panels: [], setUpLine: "", detectLine: "Couldn't detect apps." }),
    );
    expect(problems.join(" ")).toContain("Claude Code");
    expect(problems.join(" ")).toContain("set-up count");
    expect(problems.join(" ")).toContain("detection");
  });

  it("accepts a Claude Code launcher saved with the Set up badge and a count of one", () => {
    const saved = extras({
      setUpLine: "1 of 3 launchers set up",
      panels: [
        { title: "Claude Code", badge: "set-up", buttons: [] },
        { title: "Antigravity", badge: "not-set-up", buttons: [] },
      ],
    });
    expect(checkLauncherSaved(saved, "Claude Code")).toEqual([]);
    expect(checkLauncherSaved(extras(), "Claude Code").join(" ")).toContain("Set up");
  });
});

describe("the Paths verdict (Test 2, item 12)", () => {
  const good = section({
    facts: [
      fact("Managed vault", { code: ["…/vaults/live"] }),
      fact("Service data folder", { code: ["…/rt"] }),
      fact("Service socket", { code: ["~/sock/svc.sock"] }),
    ],
  });

  it("accepts three display paths and no input", () => {
    expect(checkPaths(good)).toEqual([]);
  });

  it("flags an absolute path, an Unknown value, a loading value, an input and a wrong set of rows", () => {
    const bad = section({
      inputs: 1,
      facts: [
        fact("Managed vault", { code: ["/tmp/ccc-uat.x/vaults/live"] }),
        fact("Service data folder", { unknown: true, lines: ["No managed vault is set up yet."] }),
        fact("Service socket", { loading: true }),
      ],
    });
    const joined = checkPaths(bad).join(" ");
    expect(joined).toContain("not a display path");
    expect(joined).toContain("reads Unknown");
    expect(joined).toContain("still loading");
    expect(joined).toContain("input");
    expect(checkPaths(section({ facts: [] })).join(" ")).toContain("Managed vault");
  });
});

describe("the Security and Schedules verdicts (Test 2, item 14)", () => {
  const chip = (word: string, status: string): SettingsChipRead => ({ status, word });
  const security = section({
    facts: [
      fact("Service connection", { text: "A local socket that only you can read (mode 0600)." }),
      fact("Network listener", {
        text: "None. The companion service doesn't listen on any network port.",
      }),
      fact("Connection tokens", {
        text: "Each lasts 1 hour. The plugin asks for a new one when it expires.",
      }),
      fact("Install secret in keychain", { chips: [chip("Present", "ok")] }),
      fact("Research key in keychain", { chips: [chip("Unknown", "unknown")] }),
      fact("Approval presence check", { chips: [chip("Unavailable", "failing")] }),
      fact("Always allow", {
        text: "No always-allow control exists. Every consequential action asks you each time.",
      }),
    ],
    buttons: [
      button("Off"),
      button("Delete cached usage analytics"),
      button("Go to the approvals and tasks section"),
    ],
    rows: [row("Transcript analysis", { kind: "switch", label: "Off", checked: false })],
  });

  it("accepts the seven facts, the Present install chip, an honest research chip and an honest presence chip", () => {
    expect(checkSecurityFacts(security)).toEqual([]);
    for (const word of ["Available", "Unavailable", "Unknown"]) {
      const withWord = section({
        ...security,
        facts: security.facts.map((entry) =>
          entry.name === "Approval presence check"
            ? fact(entry.name, { chips: [chip(word, "x")] })
            : entry,
        ),
      });
      expect(checkSecurityFacts(withWord), word).toEqual([]);
    }
  });

  it("flags a missing Approval presence check fact and a chip word outside Available, Unavailable and Unknown", () => {
    const without = section({
      ...security,
      facts: security.facts.filter((entry) => entry.name !== "Approval presence check"),
    });
    expect(checkSecurityFacts(without).join(" ")).toContain("Approval presence check");
    const odd = section({
      ...security,
      facts: security.facts.map((entry) =>
        entry.name === "Approval presence check"
          ? fact(entry.name, { chips: [chip("Present", "ok")] })
          : entry,
      ),
    });
    expect(checkSecurityFacts(odd).join(" ")).toContain(
      'the Approval presence check chip reads "Present"',
    );
  });

  it("flags a missing fact, a wrong chip and a research chip that claims more than the service said", () => {
    const wrong = section({
      ...security,
      facts: security.facts.map((entry) =>
        entry.name === "Install secret in keychain"
          ? fact(entry.name, { chips: [chip("Missing", "failing")] })
          : entry,
      ),
    });
    expect(checkSecurityFacts(wrong).join(" ")).toContain("Install secret");
    expect(checkSecurityFacts(section({ facts: [] })).join(" ")).toContain("Service connection");
  });

  it("finds no credential control among the buttons of Security", () => {
    expect(checkNoCredentialControl(security)).toEqual([]);
  });

  it("flags a control that stores, rotates or deletes a credential, or allows always, and any input", () => {
    for (const label of [
      "Store key",
      "Rotate secret",
      "Delete token",
      "Always allow",
      "Remove credential",
      "Set API key",
    ]) {
      expect(
        checkNoCredentialControl(section({ buttons: [button(label)] })).join(" "),
        label,
      ).toContain(label);
    }
    expect(checkNoCredentialControl(section({ inputs: 1 })).join(" ")).toContain("input");
  });

  const schedules = section({
    facts: [
      fact("Topic", { text: "Research sources" }),
      fact("Sources", { lines: ["2 sources configured"], code: ["one.example", "two.example"] }),
      fact("Scheduling", { text: "Manual trigger only in this version." }),
    ],
    buttons: [button("Open the research view")],
  });

  it("accepts a manual-only Schedules section whose sources match the service", () => {
    expect(checkSchedules(schedules, { count: 2, hosts: ["one.example", "two.example"] })).toEqual(
      [],
    );
  });

  it("flags a count or host mismatch, a timer control and a missing manual-only line", () => {
    expect(
      checkSchedules(schedules, { count: 3, hosts: ["one.example", "two.example"] }).join(" "),
    ).toContain("3");
    const timer = section({
      ...schedules,
      buttons: [button("Open the research view"), button("Run every day")],
    });
    expect(checkSchedules(timer).join(" ")).toContain("Run every day");
    const noLine = section({ ...schedules, facts: schedules.facts.slice(0, 2) });
    expect(checkSchedules(noLine).join(" ")).toContain("Scheduling");
    const zero = section({
      facts: [
        fact("Topic", {}),
        fact("Sources", {
          lines: [
            "0 sources configured",
            "No sources are configured. A run would fail with no source to fetch.",
          ],
        }),
        fact("Scheduling", { text: "Manual trigger only in this version." }),
      ],
      buttons: [button("Open the research view")],
    });
    expect(checkSchedules(zero, { count: 0, hosts: [] })).toEqual([]);
  });
});

describe("the reduced motion verdicts (Test 2, items 13 and 34)", () => {
  const moving: MotionSample = {
    transitionDuration: "0.2s",
    animationDuration: "0s",
    animationName: "none",
  };
  const still: MotionSample = {
    transitionDuration: "0s",
    animationDuration: "0s",
    animationName: "none",
  };
  const good = {
    osPrefersReduced: false,
    baselineRoot: "full",
    reducedRoot: "reduced",
    restoredRoot: "full",
    baselineSamples: [moving],
    reducedSamples: [still],
    selectAfterReduced: "Always reduced",
    selectAfterSystem: "System",
    savedAfterReduced: "reduced",
    savedAfterSystem: "auto",
  };

  it("accepts a switch to reduced that stops the motion, persists, and a switch back", () => {
    expect(checkReducedMotion(good)).toEqual([]);
  });

  it("flags motion that continues, a value that was not saved and a baseline that proves nothing", () => {
    expect(checkReducedMotion({ ...good, reducedSamples: [moving] }).join(" ")).toContain(
      "still moves",
    );
    expect(checkReducedMotion({ ...good, savedAfterReduced: "auto" }).join(" ")).toContain(
      "data file",
    );
    expect(checkReducedMotion({ ...good, baselineSamples: [still] }).join(" ")).toContain(
      "baseline",
    );
    expect(checkReducedMotion({ ...good, reducedRoot: "full" }).join(" ")).toContain("root");
    expect(checkReducedMotion({ ...good, restoredRoot: "reduced" }).join(" ")).toContain(
      "restored",
    );
  });

  it("skips the baseline when the operating system already asks for reduced motion", () => {
    expect(
      checkReducedMotion({
        ...good,
        osPrefersReduced: true,
        baselineRoot: "reduced",
        baselineSamples: [still],
        restoredRoot: "reduced",
      }),
    ).toEqual([]);
  });

  it("accepts one reducedMotion value held by the Visual write, the native tab's host and the files", () => {
    const same = { memory: "reduced", host: "reduced", saved: "reduced", disk: "reduced" };
    expect(checkSameReducedMotion(same, "reduced")).toEqual([]);
    expect(checkSameReducedMotion({ ...same, host: "auto" }, "reduced")).toEqual([
      "the native tab's host holds auto, not reduced",
    ]);
    expect(checkSameReducedMotion({ ...same, disk: "auto" }, "reduced")).toEqual([
      "the data file holds auto, not reduced",
    ]);
  });
});

describe("the service-away verdicts (Test 2, item 15)", () => {
  const away = "Status unavailable — the companion service isn't running.";

  it("accepts a Projects section with its note and every registering control inert", () => {
    const read = section({
      paragraphs: [SETTINGS_TEXT.serviceOwnedAway, AWAY],
      buttons: [
        button("Register a project", true),
        button("Type a path instead", true),
        button("Add a scan folder", true),
        button("Type a path instead", true),
        button("Go to the projects view"),
      ],
    });
    expect(checkServiceAway("projects", read)).toEqual([]);
    expect(
      checkServiceAway("projects", {
        ...read,
        buttons: [button("Register a project", false)],
      }).join(" "),
    ).toContain("Register a project");
  });

  it("accepts Integrations with the unavailable sentence on every status row and enabled copy buttons", () => {
    const read = section({
      statusTexts: ["claude-hooks", "claude-statusline", "codex-hooks", "codex-bridge"].map(
        (id) => ({ id, text: away }),
      ),
      buttons: [button("Copy install command"), button("Copy uninstall command")],
    });
    expect(checkServiceAway("integrations", read)).toEqual([]);
    const lastGood = section({
      ...read,
      statusTexts: [{ id: "claude-hooks", text: "Installed. Last event 3 minutes ago." }],
    });
    expect(checkServiceAway("integrations", lastGood).join(" ")).toContain("claude-hooks");
    const disabledCopy = section({ ...read, buttons: [button("Copy install command", true)] });
    expect(checkServiceAway("integrations", disabledCopy).join(" ")).toContain(
      "Copy install command",
    );
  });

  it("accepts Approvals and tasks with the preference live and the two service actions inert and explained", () => {
    const read = section({
      rows: [
        row("Approval notifications", { kind: "switch", label: "On", checked: true }),
        row("Send a test approval", { disabled: true, describedText: ["x", AWAY] }),
        row("Rebuild task index", { disabled: true, describedText: [AWAY] }),
      ],
    });
    expect(checkServiceAway("approvals-tasks", read)).toEqual([]);
    const unexplained = section({
      rows: [
        row("Approval notifications", { kind: "switch" }),
        row("Send a test approval", { disabled: true }),
        row("Rebuild task index", { disabled: true, describedText: [AWAY] }),
      ],
    });
    expect(checkServiceAway("approvals-tasks", unexplained).join(" ")).toContain(
      "Send a test approval",
    );
  });

  it("accepts Paths with the service values Unknown and the socket still shown", () => {
    const read = section({
      facts: [
        fact("Managed vault", { unknown: true, lines: ["Unknown", AWAY] }),
        fact("Service data folder", { unknown: true, lines: ["Unknown", AWAY] }),
        fact("Service socket", { code: ["~/sock/svc.sock"] }),
      ],
    });
    expect(checkServiceAway("paths", read)).toEqual([]);
    const lastGood = section({
      ...read,
      facts: [fact("Managed vault", { code: ["…/vaults/live"] }), ...read.facts.slice(1)],
    });
    expect(checkServiceAway("paths", lastGood).join(" ")).toContain("Managed vault");
  });

  it("accepts Visual with its select live, Security with no value shown as current, and Schedules Unknown", () => {
    expect(
      checkServiceAway(
        "visual",
        section({ rows: [row("Reduced motion", { kind: "select", label: "System" })] }),
      ),
    ).toEqual([]);
    expect(
      checkServiceAway(
        "visual",
        section({ rows: [row("Reduced motion", { kind: "select", disabled: true })] }),
      ).join(" "),
    ).toContain("Reduced motion");
    const unknownChip: SettingsChipRead = { status: "unknown", word: "Unknown" };
    const secure = section({
      facts: [
        fact("Install secret in keychain", { chips: [unknownChip], lines: [AWAY] }),
        fact("Research key in keychain", { chips: [unknownChip], lines: [AWAY] }),
        fact("Approval presence check", { chips: [unknownChip], lines: [AWAY] }),
      ],
      rows: [
        row("Transcript analysis", { kind: "switch", disabled: true, describedText: [AWAY] }),
        row("Delete cached usage analytics", { disabled: true, describedText: [AWAY] }),
      ],
    });
    expect(checkServiceAway("security", secure)).toEqual([]);
    const present = section({
      ...secure,
      facts: [
        fact("Install secret in keychain", { chips: [{ status: "ok", word: "Present" }] }),
        secure.facts[1] as SettingsFactRead,
        secure.facts[2] as SettingsFactRead,
      ],
    });
    expect(checkServiceAway("security", present).join(" ")).toContain("Present");
    const availableAway = section({
      ...secure,
      facts: [
        secure.facts[0] as SettingsFactRead,
        secure.facts[1] as SettingsFactRead,
        fact("Approval presence check", {
          chips: [{ status: "ok", word: "Available" }],
          lines: [AWAY],
        }),
      ],
    });
    expect(checkServiceAway("security", availableAway).join(" ")).toContain(
      "Approval presence check still reads Available",
    );
    const schedules = section({
      facts: [
        fact("Topic", { unknown: true, lines: ["Unknown", AWAY] }),
        fact("Sources", { unknown: true, lines: ["Unknown", AWAY] }),
        fact("Scheduling", { text: "Manual trigger only in this version." }),
      ],
    });
    expect(checkServiceAway("schedules", schedules)).toEqual([]);
  });

  it("accepts Launchers with the disconnected banner and Detect apps inert", () => {
    const read = section({
      paragraphs: ["Reconnect the service to detect, save or test launchers."],
      buttons: [button("Detect apps", true)],
    });
    expect(checkServiceAway("launchers", read)).toEqual([]);
    expect(
      checkServiceAway("launchers", section({ buttons: [button("Detect apps", true)] })).join(" "),
    ).toContain("banner");
  });

  it("has no verdict for Diagnostics (item 23 holds it)", () => {
    expect(checkServiceAway("diagnostics", section({}))).toEqual([]);
  });
});

describe("the keyboard walk verdict (Test 2, item 16)", () => {
  const ring = { outlineStyle: "solid", outlineWidth: "2px", boxShadow: "none" };
  const stop = (label: string, over: Partial<FocusStop> = {}): FocusStop => ({
    label,
    tag: "button",
    inContent: true,
    focusVisible: true,
    ...ring,
    ...over,
  });
  const expected = [
    { label: "One", tag: "button" },
    { label: "Two", tag: "button" },
  ];

  it("accepts a walk that visits every control in order with a visible ring on each", () => {
    expect(checkKeyboardWalk("Visual", [stop("One"), stop("Two")], expected)).toEqual([]);
  });

  it("flags a control that was skipped, an order change and a stop with no ring", () => {
    expect(checkKeyboardWalk("Visual", [stop("One")], expected).join(" ")).toContain(
      "1 tab stops for 2",
    );
    expect(checkKeyboardWalk("Visual", [stop("Two"), stop("One")], expected).join(" ")).toContain(
      "stop 0",
    );
    expect(
      checkKeyboardWalk(
        "Visual",
        [stop("One"), stop("Two", { focusVisible: false })],
        expected,
      ).join(" "),
    ).toContain("Two shows no focus ring");
    expect(
      checkKeyboardWalk(
        "Visual",
        [stop("One"), stop("Two", { outlineStyle: "none", outlineWidth: "0px" })],
        expected,
      ).join(" "),
    ).toContain("Two shows no focus ring");
  });

  it("accepts a box shadow as the ring and checks the nav stop as well", () => {
    const shadow = stop("Two", {
      outlineStyle: "none",
      outlineWidth: "0px",
      boxShadow: "0 0 0 2px rgb(1, 2, 3)",
    });
    expect(checkKeyboardWalk("Visual", [stop("One"), shadow], expected)).toEqual([]);
    expect(
      checkKeyboardWalk(
        "Visual",
        [stop("One"), stop("Two")],
        expected,
        stop("Visual", { focusVisible: false }),
      ).join(" "),
    ).toContain("nav");
  });

  it("counts a walk that never left the section as unfinished", () => {
    const wandering = [stop("One"), stop("Two"), stop("Three")];
    expect(checkKeyboardWalk("Visual", wandering, expected).join(" ")).toContain(
      "3 tab stops for 2",
    );
  });

  it("walks the tab stops of a browser until focus leaves the section", async () => {
    const reads: (FocusStop | null)[] = [
      stop("One"),
      stop("Two"),
      stop("Out", { inContent: false }),
    ];
    const pressed: string[] = [];
    const fake = {
      keys: async (keys: string | string[]) => {
        pressed.push(String(keys));
      },
      execute: async () => reads.shift() ?? null,
    };
    const stops = await walkTabStops(fake as never, 10);
    expect(stops.map((entry) => entry.label)).toEqual(["One", "Two"]);
    expect(pressed).toHaveLength(3);
  });

  it("stops walking at the limit and says so", async () => {
    const fake = { keys: async () => {}, execute: async () => stop("Loop") };
    await expect(walkTabStops(fake as never, 3)).rejects.toThrow(/never left the section/);
  });
});

describe("the contrast verdict (Test 2, item 17)", () => {
  const reading = (over: Partial<ThemeReading> = {}): ThemeReading => ({
    base: "theme-dark",
    measured: [{ label: 'text h3 "Visual"', ratio: 9, floor: 4.5 }],
    problems: [],
    texts: ["Visual", "Reduced motion", "Always reduced"],
    ...over,
  });

  it("names the subjects each section must have measured", () => {
    expect(contrastSubjects("visual")).toEqual(["visual", "reduced motion"]);
    expect(contrastSubjects("diagnostics")).toContain("run checks again");
    for (const id of SETTINGS_SECTION_IDS) {
      expect(contrastSubjects(id).length, id).toBeGreaterThan(0);
    }
  });

  it("accepts a reading that measured the subjects and found nothing under its floor", () => {
    expect(checkContrastReading("Visual", reading(), contrastSubjects("visual"))).toEqual([]);
  });

  it("flags a ratio under its floor, an unreadable colour and a subject that was not measured", () => {
    const low = reading({ measured: [{ label: 'text p "x"', ratio: 3.2, floor: 4.5 }] });
    expect(checkContrastReading("Visual", low, contrastSubjects("visual")).join(" ")).toContain(
      "3.20:1 < 4.5:1",
    );
    const unread = reading({ problems: ["text p: unreadable colour"] });
    expect(checkContrastReading("Visual", unread, contrastSubjects("visual")).join(" ")).toContain(
      "unreadable",
    );
    const nothing = reading({ texts: ["Visual"] });
    expect(checkContrastReading("Visual", nothing, contrastSubjects("visual")).join(" ")).toContain(
      '"reduced motion" was not measured',
    );
    expect(checkContrastReading("Visual", low, contrastSubjects("visual")).join(" ")).toContain(
      "theme-dark",
    );
  });

  it("names the Overview slice subjects", () => {
    expect(OVERVIEW_CONTRAST_SUBJECTS).toEqual([
      "today",
      "technology and market intelligence",
      "project shortcuts",
      "active claude sessions",
    ]);
  });
});

describe("the mutation scan (Test 2)", () => {
  it("flags a Settings mutation outside withRestore and withMode, and accepts one inside", () => {
    const source = `
      await chooseOption(sb, "Reduced motion", "Always reduced");
      await withRestore(() => chooseOption(sb, "Reduced motion", "System"), async () => {
        await chooseOption(sb, "Reduced motion", "Always reduced");
      });
      await pressRowControl(sb, "Rebuild task index");
    `;
    const found = findUnguardedMutations(source, SETTINGS_MUTATING_HELPERS);
    expect(found.map((entry) => `${entry.call}:${entry.line}`)).toEqual([
      "chooseOption:2",
      "pressRowControl:6",
    ]);
  });

  it("keeps the default list of the health drills when no list is given", () => {
    expect(findUnguardedMutations("await removeProject(c, {});")).toHaveLength(1);
    expect(findUnguardedMutations("await chooseOption(sb, 'a', 'b');")).toEqual([]);
  });

  it("includes the health drills' own helpers in the Settings list", () => {
    for (const name of MUTATING_HELPERS) expect(SETTINGS_MUTATING_HELPERS).toContain(name);
    expect(SETTINGS_MUTATING_HELPERS).toContain("removeScanRoot");
  });
});

describe("the reduced motion readers and the theme swap (Test 2, items 13, 17 and 34)", () => {
  it("asks the operating system's media query, and answers false where there is none", () => {
    const run = (win: unknown): unknown =>
      vm.runInContext(
        `(${rendererText("rendererOsPrefersReduced")})()`,
        vm.createContext({ window: win }),
      );
    const yes = { matchMedia: () => ({ matches: true }) };
    const no = { matchMedia: () => ({ matches: false }) };
    expect(run(yes)).toBe(true);
    expect(run(no)).toBe(false);
    expect(run({})).toBe(false);
  });

  it("reads reducedMotion from the plugin, the host the native tab reads and the loaded data", async () => {
    const ctx = {
      app: {
        plugins: {
          plugins: {
            "claude-command-center": {
              settings: { reducedMotion: "reduced" },
              settingsHost: { settings: { reducedMotion: "reduced" } },
              loadData: async () => ({ reducedMotion: "reduced", notifyApprovals: true }),
            },
          },
        },
      },
    };
    expect(await rendererReadReducedMotion(ctx, "claude-command-center")).toEqual({
      memory: "reduced",
      host: "reduced",
      saved: "reduced",
    });
    expect(await rendererReadReducedMotion({}, "claude-command-center")).toEqual({
      memory: undefined,
      host: undefined,
      saved: undefined,
    });
    expect(rendererText("rendererReadReducedMotion")).not.toContain("__name");
  });

  it("runs a step in a base theme and puts the old one back, even when the step throws", async () => {
    const calls: unknown[] = [];
    const fake = {
      execute: async (_fn: unknown, base: unknown) => {
        calls.push(base);
        return { was: "theme-dark", now: base };
      },
    };
    expect(await withBase(fake, "theme-light", async () => "done")).toBe("done");
    expect(calls).toEqual(["theme-light", "theme-dark"]);
    calls.length = 0;
    await expect(
      withBase(fake, "theme-light", async () => {
        throw new Error("step failed");
      }),
    ).rejects.toThrow("step failed");
    expect(calls).toEqual(["theme-light", "theme-dark"]);
  });

  it("judges a section settled only when nothing is busy and no value is a skeleton", () => {
    expect(checkSectionSettled(section({}))).toEqual([]);
    expect(checkSectionSettled(section({ busy: true })).join(" ")).toContain("busy");
    expect(
      checkSectionSettled(section({ facts: [fact("Managed vault", { loading: true })] })).join(" "),
    ).toContain("Managed vault still loading");
    expect(checkSectionSettled(section({ mounted: false }))).toEqual([
      "the Settings destination is not on the page",
    ]);
  });
});

describe("restoreSystemMotion and the spec's mutation discipline (Test 2)", () => {
  const deps = (label: string) => {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        open: async () => {
          calls.push("open");
        },
        read: async () => section({ rows: [row("Reduced motion", { kind: "select", label })] }),
        choose: async (rowName: string, option: string) => {
          calls.push(`choose ${rowName} -> ${option}`);
        },
      },
    };
  };

  it("puts the select back to System when a case left it on Always reduced", async () => {
    const fake = deps("Always reduced");
    expect(await restoreSystemMotion({} as never, fake.deps)).toBe(true);
    expect(fake.calls).toEqual(["open", "choose Reduced motion -> System"]);
  });

  it("changes nothing when the select already reads System", async () => {
    const fake = deps("System");
    expect(await restoreSystemMotion({} as never, fake.deps)).toBe(false);
    expect(fake.calls).toEqual(["open"]);
  });

  it("reads the Reduced motion choice from a read, or an empty string without the row", () => {
    expect(motionSelectOf(section({ rows: [row("Reduced motion", { label: "System" })] }))).toBe(
      "System",
    );
    expect(motionSelectOf(section({}))).toBe("");
  });

  it.each(["settings-core.e2e.ts", "settings-integrations.e2e.ts"])(
    "finds no Settings mutation outside withRestore or withMode in %s",
    (file) => {
      const source = readFileSync(join(HERE, "..", "..", "specs", file), "utf8");
      expect(findUnguardedMutations(source, SETTINGS_MUTATING_HELPERS)).toEqual([]);
    },
  );

  it("control: the scan does flag a restore helper called on its own", () => {
    expect(
      findUnguardedMutations("await restoreSystemMotion(sb);", SETTINGS_MUTATING_HELPERS).length,
    ).toBe(1);
  });
});

// ===========================================================================
// Plan 08-22 Task 3: items 19 to 21

describe("the account rows reader (Test 3)", () => {
  const ACCOUNTS = `<section class="ccc-settings"><div class="ccc-settings-content"><h3 tabindex="-1">Integrations</h3>
    <div data-group="accounts"><h4 class="ccc-settings-group-title">Accounts</h4>
      <div class="ccc-setting-row" role="group"><div class="ccc-setting-row-text"><span>Gmail</span>
        <p><span class="ccc-badge" data-status="not-in-version"><span class="ccc-visually-hidden">Status: </span><span class="ccc-badge-glyph" aria-hidden="true">◌</span> <span class="ccc-badge-label">Not part of this version</span></span></p>
        <p>Connecting accounts arrives in a later milestone. Nothing is read from this account.</p></div>
        <div class="ccc-setting-row-control"></div></div>
    </div></div></section>`;

  it("reads the badges inside a setting row and an absent control as none", () => {
    const read = readSettingsFrom(ACCOUNTS);
    expect(read.rows).toHaveLength(1);
    expect(read.rows[0]?.chips).toEqual([
      { status: "not-in-version", word: "Not part of this version" },
    ]);
    expect(read.rows[0]?.control.kind).toBe("none");
    expect(read.subheads).toEqual(["Accounts"]);
  });
});

describe("snapshotDir (Test 2)", () => {
  function runRoot(): string {
    return mkdtempSync(join("/tmp", "ccc-uat."));
  }

  it("is the same for a folder that did not change and differs for every kind of change", () => {
    const root = runRoot();
    try {
      const dir = join(root, "claude");
      mkdirSync(join(dir, "nested"), { recursive: true });
      writeFileSync(join(dir, "settings.json"), '{"a":1}');
      writeFileSync(join(dir, "nested", "x.txt"), "x");
      const before = snapshotDir(dir, root);
      expect(before.exists).toBe(true);
      expect(before.count).toBe(3);
      expect(snapshotDir(dir, root)).toEqual(before);

      writeFileSync(join(dir, "settings.json"), '{"a":2}');
      expect(snapshotDir(dir, root).digest).not.toBe(before.digest);
      writeFileSync(join(dir, "settings.json"), '{"a":1}');
      expect(snapshotDir(dir, root)).toEqual(before);

      writeFileSync(join(dir, "new.txt"), "n");
      expect(snapshotDir(dir, root).count).toBe(4);
      rmSync(join(dir, "new.txt"));
      const mode = statSync(join(dir, "settings.json")).mode & 0o777;
      chmodSync(join(dir, "settings.json"), 0o640);
      expect(snapshotDir(dir, root).digest).not.toBe(before.digest);
      chmodSync(join(dir, "settings.json"), mode);
      expect(snapshotDir(dir, root)).toEqual(before);

      renameSync(join(dir, "nested", "x.txt"), join(dir, "nested", "y.txt"));
      expect(snapshotDir(dir, root).digest).not.toBe(before.digest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads a folder that is not there as empty, and refuses a path outside the run root or a link", () => {
    const root = runRoot();
    const other = runRoot();
    try {
      const missing = snapshotDir(join(root, "absent"), root);
      expect(missing).toMatchObject({ exists: false, count: 0 });
      expect(() => snapshotDir(other, root)).toThrow(/outside the run root/);
      const link = join(root, "link");
      symlinkSync(other, link);
      expect(() => snapshotDir(link, root)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("records a link inside the folder as a link and notices when it points elsewhere", () => {
    const root = runRoot();
    try {
      const dir = join(root, "claude");
      mkdirSync(dir);
      symlinkSync("target-one", join(dir, "ln"));
      const before = snapshotDir(dir, root);
      rmSync(join(dir, "ln"));
      symlinkSync("target-two", join(dir, "ln"));
      expect(snapshotDir(dir, root).digest).not.toBe(before.digest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a folder with more entries than its limit", () => {
    const root = runRoot();
    try {
      const dir = join(root, "many");
      mkdirSync(dir);
      for (let i = 0; i < 5; i += 1) writeFileSync(join(dir, `f${i}`), "");
      expect(() => snapshotDir(dir, root, { maxEntries: 3 })).toThrow(/more than 3 entries/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names a changed folder without naming anything in it", () => {
    const a = { exists: true, count: 2, digest: "aaaa" };
    expect(checkSnapshotUnchanged("the scratch Claude config folder", a, { ...a })).toEqual([]);
    expect(
      checkSnapshotUnchanged("the scratch Claude config folder", a, {
        ...a,
        count: 3,
        digest: "bbbb",
      }),
    ).toEqual(["the scratch Claude config folder changed: 2 entries before, 3 after"]);
    expect(
      checkSnapshotUnchanged("the scratch Claude config folder", a, { ...a, digest: "bbbb" }),
    ).toEqual(["the scratch Claude config folder changed: an entry's contents or mode differ"]);
  });
});

describe("findInstallerProcesses (Test 3)", () => {
  const node = (command: string) => ({ pid: 1, ppid: 0, command });

  it("flags the install and uninstall scripts and the bridge installer, and nothing else", () => {
    const found = findInstallerProcesses([
      node("/bin/sh ./scripts/claude-hooks/install.sh"),
      node("/bin/sh ./scripts/codex-hooks/uninstall.sh"),
      node("node scripts/codex/install-user-kit.mjs"),
      node("/usr/bin/git status --porcelain"),
      node("/usr/bin/security find-generic-password -s x"),
      node("node dist/main.js"),
    ]);
    expect(found.map((entry) => entry.command.split(" ").at(-1))).toEqual([
      "./scripts/claude-hooks/install.sh",
      "./scripts/codex-hooks/uninstall.sh",
      "scripts/codex/install-user-kit.mjs",
    ]);
  });
});

describe("the copy actions of Integrations (Test 3, item 19)", () => {
  it("lists the five copy actions with a repository-relative command and their notices", () => {
    expect(COPY_ACTIONS.map((action) => action.id)).toEqual([
      "claude-install",
      "claude-uninstall",
      "codex-hooks-install",
      "codex-hooks-uninstall",
      "codex-bridge-install",
    ]);
    for (const action of COPY_ACTIONS) {
      expect(
        action.command.startsWith("./scripts/") || action.command.startsWith("node scripts/"),
      ).toBe(true);
      expect(action.command.includes("/Users/")).toBe(false);
    }
    // The Codex hook install and the bridge install share one notice, so four differ.
    expect(new Set(COPY_ACTIONS.map((action) => action.notice)).size).toBe(4);
    expect(COPY_ACTIONS[0]?.command).toBe("./scripts/claude-hooks/install.sh");
  });

  it("accepts the exact command on the clipboard and the copied notice in the status line", () => {
    const action = COPY_ACTIONS[0] as (typeof COPY_ACTIONS)[number];
    expect(checkCopied(action, action.command, action.notice)).toEqual([]);
    expect(checkCopied(action, undefined, action.notice).join(" ")).toContain("clipboard");
    expect(checkCopied(action, `${action.command} --dry-run`, action.notice).join(" ")).toContain(
      "clipboard",
    );
    expect(checkCopied(action, action.command, "").join(" ")).toContain("status line");
  });

  const claudeNot = "Not installed. Session tracking and waiting-for-approval states need them.";
  const statuslineNot =
    'Not installed. Plan usage reads "Account capacity unavailable". The wrapper keeps your current status line exactly as it is.';
  const codexNot =
    "Not installed. Live status for interactive Codex sessions needs the optional hook package. Sessions and usage still appear from Codex's own records.";
  const bridgeNot = "Not installed. Launches fall back to Terminal.";
  const rows = (texts: Record<string, string>) =>
    section({ statusTexts: Object.entries(texts).map(([id, text]) => ({ id, text })) });

  it("accepts Claude and Codex rows that read not set up", () => {
    expect(
      checkIntegrationsNotSetUp(
        rows({
          "claude-hooks": claudeNot,
          "claude-statusline": statuslineNot,
          "codex-hooks": codexNot,
          "codex-bridge": bridgeNot,
        }),
      ),
    ).toEqual([]);
  });

  it("flags a row that claims to be installed, one that still checks and one that is missing", () => {
    const problems = checkIntegrationsNotSetUp(
      rows({
        "claude-hooks": "Installed. Last event 3 minutes ago.",
        "claude-statusline": "Checking…",
        "codex-hooks": codexNot,
      }),
    );
    expect(problems.join(" ")).toContain("claude-hooks");
    expect(problems.join(" ")).toContain("claude-statusline");
    expect(problems.join(" ")).toContain("codex-bridge");
  });

  it("accepts Codex hooks that cannot tell whether the package is installed", () => {
    const unknown = "Status unknown. This app couldn't tell whether the hook package is installed.";
    expect(
      checkIntegrationsNotSetUp(
        rows({
          "claude-hooks": claudeNot,
          "claude-statusline": statuslineNot,
          "codex-hooks": unknown,
          "codex-bridge": bridgeNot,
        }),
      ),
    ).toEqual([]);
  });

  const account = (name: string, over: Partial<SettingsRowRead> = {}): SettingsRowRead => ({
    name,
    paragraphs: [
      "Connecting accounts arrives in a later milestone. Nothing is read from this account.",
    ],
    control: control({ kind: "none", label: "" }),
    results: [],
    chips: [{ status: "not-in-version", word: "Not part of this version" }],
    ...over,
  });

  it("accepts Gmail, Google Calendar and GitHub as Not part of this version with no control", () => {
    const read = section({
      rows: [account("Gmail"), account("Google Calendar"), account("GitHub")],
      subheads: ["Claude Code", "Codex", "Accounts"],
    });
    expect(checkAccountsRows(read)).toEqual([]);
  });

  it("flags a connectable account, a missing one and a chip that claims more", () => {
    const read = section({
      rows: [
        account("Gmail", { control: control({ kind: "button", label: "Connect Gmail" }) }),
        account("GitHub", { chips: [{ status: "ok", word: "Connected" }] }),
      ],
    });
    const problems = checkAccountsRows(read).join(" ");
    expect(problems).toContain("Gmail");
    expect(problems).toContain("Google Calendar");
    expect(problems).toContain("GitHub");
  });
});

describe("the dialog reader and the delete dialog (Test 3, item 20)", () => {
  const DIALOG = (title: string, bodies: string[], buttons: string[]) =>
    `<div class="modal-container"><div class="modal"><div class="modal-title">${title}</div><div class="modal-content">${bodies
      .map((body) => `<p>${body}</p>`)
      .join(
        "",
      )}<div>${buttons.map((label) => `<button>${label}</button>`).join("")}</div></div></div></div>`;
  const BODY1 =
    "This deletes the token counts, cost estimates, plan usage history and transcript coverage records the companion service has stored.";
  const BODY2 = "Your session history and Claude Code's own transcripts aren't touched.";
  const RECOUNT =
    "Transcript analysis is on, so token counts will be recounted right away from the transcripts Claude Code still keeps.";
  const dialog = (analysisOn: boolean): DialogRead =>
    runWith(
      "rendererReadDialog",
      DIALOG(
        "Delete cached usage analytics?",
        analysisOn ? [BODY1, BODY2, RECOUNT] : [BODY1, BODY2],
        ["Delete usage analytics", "Cancel"],
      ),
      [],
    ) as DialogRead;

  it("reads the open dialog's title, paragraphs and buttons, and nothing when none is open", () => {
    const read = dialog(false);
    expect(read).toEqual({
      open: true,
      title: "Delete cached usage analytics?",
      paragraphs: [BODY1, BODY2],
      buttons: ["Delete usage analytics", "Cancel"],
    });
    expect(runWith("rendererReadDialog", "<div></div>", [])).toEqual({
      open: false,
      title: "",
      paragraphs: [],
      buttons: [],
    });
    expect(rendererText("rendererReadDialog")).not.toContain("__name");
  });

  it("accepts the delete dialog with its destructive button first and the recount line only when analysis is on", () => {
    expect(checkDeleteDialog(dialog(false), false)).toEqual([]);
    expect(checkDeleteDialog(dialog(true), true)).toEqual([]);
    expect(checkDeleteDialog(dialog(true), false).join(" ")).toContain("recount");
    expect(checkDeleteDialog(dialog(false), true).join(" ")).toContain("recount");
  });

  it("flags a dialog that is not there, another title and buttons in the wrong order", () => {
    expect(
      checkDeleteDialog({ open: false, title: "", paragraphs: [], buttons: [] }, false),
    ).toEqual(["no dialog is open"]);
    const other = { ...dialog(false), title: "Something else?" };
    expect(checkDeleteDialog(other, false).join(" ")).toContain("title");
    const swapped = { ...dialog(false), buttons: ["Cancel", "Delete usage analytics"] };
    expect(checkDeleteDialog(swapped, false).join(" ")).toContain("buttons");
  });
});

describe("the usage store and the synthetic transcript (Test 3, item 20)", () => {
  it("writes one assistant record with the four counters and a time, in the shape Claude Code writes", () => {
    const line = JSON.parse(
      syntheticTranscriptLine("msg_settings0001", "2026-10-23T09:00:00.000Z"),
    ) as {
      type: string;
      timestamp: string;
      message: { id: string; role: string; usage: Record<string, number> };
      sessionId: string;
    };
    expect(line.type).toBe("assistant");
    expect(line.timestamp).toBe("2026-10-23T09:00:00.000Z");
    expect(line.message).toMatchObject({ id: "msg_settings0001", role: "assistant" });
    expect(Object.keys(line.message.usage)).toEqual(
      expect.arrayContaining([
        "input_tokens",
        "output_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
      ]),
    );
    expect(syntheticTranscriptLine("a", "2026-10-23T09:00:00.000Z").includes("\n")).toBe(false);
    expect(
      findAbsolutePathProblems(syntheticTranscriptLine("a", "2026-10-23T09:00:00.000Z")),
    ).toEqual([]);
  });

  it("names the seven usage tables the delete empties", () => {
    expect(USAGE_TABLES).toEqual([
      "usage_quarter_hourly",
      "usage_seen_messages",
      "coverage_days",
      "transcript_cursors",
      "capacity_snapshots",
      "cost_snapshots",
      "transcript_recognition",
    ]);
    expect(USAGE_COUNTS_SQL).toContain("usage_quarter_hourly");
  });

  const counts = (over: Record<string, number> = {}): Record<string, number> =>
    Object.fromEntries(USAGE_TABLES.map((table) => [table, over[table] ?? 0]));

  it("totals the rows and accepts only empty tables as emptied", () => {
    expect(totalUsageRows(counts({ usage_quarter_hourly: 2, coverage_days: 1 }))).toBe(3);
    expect(checkUsageEmptied(counts())).toEqual([]);
    expect(checkUsageEmptied(counts({ cost_snapshots: 1 }))).toEqual([
      "cost_snapshots still holds 1 row",
    ]);
    expect(checkUsageEmptied(counts({ usage_quarter_hourly: 4 }))).toEqual([
      "usage_quarter_hourly still holds 4 rows",
    ]);
  });

  it("judges the analysis setting by the service's stored value and the plugin file by its keys", () => {
    const data = { reducedMotion: "auto", notifyApprovals: true };
    expect(checkAnalysisStored({ analysis: "true", counts: counts() }, true, data)).toEqual([]);
    expect(checkAnalysisStored({ analysis: "false", counts: counts() }, false, data)).toEqual([]);
    expect(
      checkAnalysisStored({ analysis: null, counts: counts() }, true, data).join(" "),
    ).toContain("service");
    expect(
      checkAnalysisStored({ analysis: "true", counts: counts() }, true, {
        ...data,
        transcriptAnalysis: true,
      }).join(" "),
    ).toContain("plugin data file");
  });
});

describe("the approvals and tasks verdicts (Test 3, item 21)", () => {
  it("accepts a notifications switch whose state and saved value are the expected one", () => {
    const read = section({
      rows: [row("Approval notifications", { kind: "switch", label: "Off", checked: false })],
    });
    expect(checkNotifyApprovals(read, false, false)).toEqual([]);
    expect(checkNotifyApprovals(read, true, true).join(" ")).toContain("switch");
    expect(checkNotifyApprovals(read, false, true).join(" ")).toContain("data file");
    expect(checkNotifyApprovals(section({}), false, false).join(" ")).toContain("row");
  });

  it("accepts a transcript analysis switch in the expected state and not busy", () => {
    const on = section({
      rows: [row("Transcript analysis", { kind: "switch", label: "On", checked: true })],
    });
    expect(checkTranscriptSwitch(on, true)).toEqual([]);
    expect(checkTranscriptSwitch(on, false).join(" ")).toContain("Transcript analysis");
    const busy = section({
      rows: [row("Transcript analysis", { kind: "switch", checked: true, busy: true })],
    });
    expect(checkTranscriptSwitch(busy, true).join(" ")).toContain("busy");
  });

  it("accepts a rebuild reported in the status line and under the row", () => {
    const read = section({
      statusLine: "Task index rebuilt. 304 tasks found.",
      results: [{ key: "rebuild", text: "Task index rebuilt. 304 tasks found." }],
    });
    expect(checkRebuilt(read, 300)).toEqual([]);
    expect(checkRebuilt(read, 400).join(" ")).toContain("304");
    expect(
      checkRebuilt(section({ statusLine: "Rebuilding the task index…" }), 1).join(" "),
    ).toContain("status line");
    expect(
      checkRebuilt(section({ statusLine: "Task index rebuilt. 304 tasks found." }), 300).join(" "),
    ).toContain("under the row");
  });

  it("accepts a delete reported in the status line and under the row", () => {
    const text = "Cached usage analytics deleted.";
    expect(
      checkDeleted(section({ statusLine: text, results: [{ key: "delete-usage", text }] })),
    ).toEqual([]);
    expect(checkDeleted(section({ statusLine: text })).join(" ")).toContain("under the row");
    expect(checkDeleted(section({ results: [{ key: "delete-usage", text }] })).join(" ")).toContain(
      "status line",
    );
  });

  it("judges the pending approvals of the sandbox store", () => {
    expect(checkPending([{ id: "p1", state: "pending" }])).toEqual([]);
    expect(checkPending([]).join(" ")).toContain("no pending");
    expect(checkPending([{ id: "p1", state: "approved" }]).join(" ")).toContain("not pending");
  });
});
