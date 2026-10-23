import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../repo-paths.js";
import { SETTINGS_CLASSES, SETTINGS_TEXT } from "./settings-copy.js";
import {
  assertNoAbsolutePath,
  checkFocusNotMoved,
  checkNavigation,
  checkSectionFocused,
  findAbsolutePathProblems,
  openSection,
  readSettingsNav,
  rendererFocusNavItem,
  SETTINGS_DOM_CONFIG,
  type SettingsRead,
} from "./settings-support.js";

/**
 * Plan 08-22 Task 1: the renderer reader of the Settings destination, run the way wdio runs it
 * (compiled by esbuild with keepNames as tsx does, sent as text, defined in a clean context that
 * has no `__name`) against a synthetic DOM that mirrors what the plugin's SettingsDestination and
 * SecuritySection render; the nav and focus verdicts; the click path that opens a section; and the
 * absolute-path finder that backs the privacy items.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
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
      "Always allow",
    ]);
    const install = base.facts.find((fact) => fact.name === "Install secret in keychain");
    expect(install?.chips).toEqual([{ status: "ok", word: "Present" }]);
    expect(install?.stale).toBe(false);
    const research = base.facts.find((fact) => fact.name === "Research key in keychain");
    expect(research?.chips).toEqual([{ status: "setup-needed", word: "Needs setup" }]);
    expect(research?.code).toEqual(["node scripts/research-key-setup.mjs"]);
    expect(research?.buttons).toEqual(["Copy key setup command"]);
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
    homeDir: "/Users/janedoe",
    userName: "janedoe",
  };

  it("flags a macOS home path, a Linux home path, the run root, the home folder and the user name", () => {
    expect(findAbsolutePathProblems("see /Users/janedoe/code/app", facts)).toEqual(
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
    expect(() => assertNoAbsolutePath("a /Users/janedoe/secret-project/x b", facts)).toThrow(
      /macOS home path/,
    );
    try {
      assertNoAbsolutePath("a /Users/janedoe/secret-project/x b", facts);
    } catch (error) {
      expect(String(error)).not.toContain("secret-project");
      expect(String(error)).not.toContain("janedoe");
    }
    expect(() => assertNoAbsolutePath("~/fine", facts)).not.toThrow();
  });
});
