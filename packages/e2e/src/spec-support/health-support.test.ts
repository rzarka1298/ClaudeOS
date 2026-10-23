import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../repo-paths.js";
import { HEALTH_TEXT, reasonSentence } from "./health-copy.js";
import {
  checkFreshInstall,
  diagnosticsClickPath,
  expectReason,
  findRawErrorText,
  HEALTH_DOM_CONFIG,
  type HealthBrowser,
  type HealthRead,
  openDiagnostics,
  partOf,
  reopenClickPath,
  rowOf,
  waitForHealth,
} from "./health-support.js";
import { rendererClick } from "./tasks-support.js";

/**
 * Plan 08-20 Task 1: the renderer reader of Settings > Diagnostics, run the way wdio runs it
 * (compiled by esbuild with keepNames as tsx does, sent as text, defined in a clean context that
 * has no `__name`) against a synthetic DOM that mirrors what the plugin's SettingsDestination,
 * DiagnosticsSection and HealthRow render; the fresh-install verdict; the raw-error finder; and the
 * click path that opens the section.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "health-dom-fixtures", "rows.html");
const SOURCE = readFileSync(join(HERE, "health-support.ts"), "utf8");
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

function loadJsdom(): { JSDOM: new (html: string) => { window: Record<string, unknown> } } {
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

function readHealthFrom(html: string): HealthRead {
  const { JSDOM } = loadJsdom();
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
  const window = dom.window as Record<string, unknown> & { document: unknown };
  const context = vm.createContext({
    document: window.document,
    window,
    getComputedStyle: (window.getComputedStyle as (n: unknown) => unknown).bind(window),
  });
  const text = rendererText("rendererReadHealth");
  const out = vm.runInContext(
    `(${text}).apply(null, ${JSON.stringify([HEALTH_DOM_CONFIG])})`,
    context,
  );
  return JSON.parse(JSON.stringify(out)) as HealthRead;
}

const fresh = readHealthFrom(BASE_HTML);

describe("rendererReadHealth (Test 2)", () => {
  it("reads the section as mounted and settled, with its heading, nav item and toolbar", () => {
    expect(fresh.mounted).toBe(true);
    expect(fresh.busy).toBe(false);
    expect(fresh.heading).toBe("Diagnostics");
    expect(fresh.navCurrent).toBe("Diagnostics");
    expect(fresh.statusLine).toBe("");
    expect(fresh.runChecks).toEqual({
      label: "Run checks again",
      name: "Run checks again: re-run the read-only checks",
      busy: false,
      disabled: false,
    });
    expect(fresh.toolbarGeneratedAt).toBe("2026-10-23T10:00:00.000Z");
    expect(fresh.error).toBeNull();
    expect(fresh.stale).toBeNull();
  });

  it("reads the six subsystem rows in order with status, chip word, reason code and sentence", () => {
    const rows = fresh.rows.filter((row) => row.scope === "subsystem");
    expect(rows.map((row) => row.subsystem)).toEqual([
      "service",
      "vault",
      "hooks",
      "collectors",
      "scheduler",
      "launchers",
    ]);
    expect(rows.map((row) => row.status)).toEqual([
      "ok",
      "setup-needed",
      "setup-needed",
      "setup-needed",
      "setup-needed",
      "setup-needed",
    ]);
    expect(rows.map((row) => row.chip)).toEqual([
      "Running",
      "Needs setup",
      "Needs setup",
      "Needs setup",
      "Needs setup",
      "Needs setup",
    ]);
    expect(rows.map((row) => row.reason)).toEqual([
      "service-live",
      "vault-not-set-up",
      "hooks-not-installed",
      "statusline-not-installed",
      "never-run",
      "launcher-not-set-up",
    ]);
    expect(rowOf(fresh, "vault")?.reasonText).toBe("No managed vault is set up yet.");
    expect(rowOf(fresh, "vault")?.name).toBe("Vault access");
  });

  it("reads each row's detail, freshness, checked time, next step, command and actions", () => {
    const service = rowOf(fresh, "service");
    expect(service?.detail).toBe("Version 0.1.0 · started 5s ago");
    expect(service?.freshness).toBe("live");
    expect(service?.freshnessLabel).toBe("Live");
    expect(service?.checkedAt).toBe("2026-10-23T10:00:00.000Z");
    expect(service?.nextStep).toBeNull();
    expect(service?.actions).toEqual([]);

    const hooks = rowOf(fresh, "hooks");
    expect(hooks?.nextStep).toBe(
      "From the Claude command center repository folder, run the install command.",
    );
    expect(hooks?.command).toBe("./scripts/claude-hooks/install.sh");
    expect(hooks?.actions).toEqual(["Copy install command"]);
    expect(rowOf(fresh, "vault")?.actions).toEqual(["Set up vault"]);
    expect(rowOf(fresh, "launchers")?.actions).toEqual(["Go to the launchers section"]);
    expect(rowOf(fresh, "scheduler")?.detail).toBe(HEALTH_TEXT.schedulerFixedLine);
  });

  it("reads the parts of the three rows that have them, grouped by their data-part id", () => {
    const collectors = rowOf(fresh, "collectors");
    expect(collectors?.parts.map((part) => part.partId)).toEqual([
      "telemetry",
      "status-line",
      "transcript-analysis",
      "spool",
      "codex-install",
      "codex-hooks",
      "codex-bridge",
      "codex-doctor",
    ]);
    expect(partOf(collectors, "transcript-analysis")).toMatchObject({
      status: "setup-needed",
      reason: "analysis-off",
      name: "Transcript analysis",
      buttons: ["Go to the security section"],
    });
    expect(partOf(collectors, "codex-install")?.reason).toBe("codex-not-installed");
    expect(collectors?.toggle).toEqual({
      label: "Show details for Usage collectors: 8 parts",
      expanded: false,
    });
    expect(rowOf(fresh, "scheduler")?.parts).toHaveLength(3);
    expect(rowOf(fresh, "launchers")?.parts).toHaveLength(4);
    expect(rowOf(fresh, "hooks")?.parts).toEqual([]);
  });

  it("reads the summary lead and chips, and the three Not part of this version rows", () => {
    expect(fresh.summary?.lead).toBe("Nothing is failing.");
    expect(fresh.summary?.chips).toEqual([
      { status: "ok", text: "1 working" },
      { status: "setup-needed", text: "5 need setup" },
    ]);
    const outside = fresh.rows.filter((row) => row.scope === "not-in-version");
    expect(outside.map((row) => row.name)).toEqual(["Gmail", "Google Calendar", "GitHub"]);
    expect(outside.every((row) => row.chip === "Not part of this version")).toBe(true);
    expect(outside.every((row) => row.buttons.length === 0)).toBe(true);
  });

  it("reads a loading section: aria-busy set and skeleton rows that claim nothing", () => {
    const loading = BASE_HTML.replace(
      '<div class="ccc-health">',
      '<div class="ccc-health" aria-busy="true">',
    ).replace(
      /data-status="setup-needed" data-subsystem="vault" data-reason="vault-not-set-up"/,
      'data-subsystem="vault"',
    );
    const read = readHealthFrom(loading);
    expect(read.busy).toBe(true);
    expect(rowOf(read, "vault")?.skeleton).toBe(true);
    expect(rowOf(read, "vault")?.status).toBeNull();
    expect(rowOf(read, "hooks")?.skeleton).toBe(false);
  });

  it("reads the busy button, the status line, the error and the stale line", () => {
    const html = BASE_HTML.replace(
      'aria-label="Run checks again: re-run the read-only checks">',
      'aria-label="Run checks again: re-run the read-only checks" aria-busy="true" aria-disabled="true">',
    )
      .replace('role="status"></p>', 'role="status">Checking…</p>')
      .replace(
        '<h4 class="ccc-settings-group-title">Subsystems</h4>',
        '<div class="ccc-health-error"><p>▲ Couldn\'t run the checks.</p><p>The companion service didn\'t respond.</p></div><p class="ccc-health-stale">These checks are more than 5 minutes old. Press Run checks again.</p><h4 class="ccc-settings-group-title">Subsystems</h4>',
      );
    const read = readHealthFrom(html);
    expect(read.runChecks).toMatchObject({ busy: true, disabled: true });
    expect(read.statusLine).toBe("Checking…");
    expect(read.error).toContain("Couldn't run the checks.");
    expect(read.stale).toContain("more than 5 minutes old");
  });

  it("reads the section as not mounted when the Diagnostics markup is absent", () => {
    const empty = readHealthFrom('<section class="ccc-settings"><h2>Settings</h2></section>');
    expect(empty.mounted).toBe(false);
    expect(empty.rows).toEqual([]);
    expect(empty.runChecks).toBeNull();
  });
});

describe("checkFreshInstall (item 22)", () => {
  it("finds nothing wrong with a fresh install: one Running, five Needs setup, nothing failing", () => {
    expect(checkFreshInstall(fresh)).toEqual([]);
  });

  it("flags a failing or degraded row, a service that is not Running and a wrong summary", () => {
    const failing = readHealthFrom(
      BASE_HTML.replace(
        'data-status="setup-needed" data-subsystem="hooks"',
        'data-status="failing" data-subsystem="hooks"',
      ),
    );
    expect(checkFreshInstall(failing).join(" ")).toContain("Claude Code hooks");
    const stopped = readHealthFrom(
      BASE_HTML.replace('data-reason="service-live"', 'data-reason="service-unreachable"').replace(
        '<span class="ccc-badge-label">Running</span>',
        '<span class="ccc-badge-label">Failing</span>',
      ),
    );
    expect(checkFreshInstall(stopped).join(" ")).toContain("Companion service");
    const summary = readHealthFrom(
      BASE_HTML.replace("Nothing is failing.", "2 subsystems need attention."),
    );
    expect(checkFreshInstall(summary).join(" ")).toContain("Nothing is failing.");
  });

  it("flags a missing next step or action, a missing Not part of this version row and a loading section", () => {
    const noStep = readHealthFrom(
      BASE_HTML.replace(
        '<p class="ccc-state-body">Set up the managed folders in this vault.</p>',
        "",
      ),
    );
    expect(checkFreshInstall(noStep).join(" ")).toContain("Vault access");
    const noGmail = readHealthFrom(
      BASE_HTML.replace(
        /<li class="ccc-health-row" data-scope="not-in-version"><div><h5 class="ccc-settings-item-title">Gmail<\/h5>.*?<\/li>/s,
        "",
      ),
    );
    expect(checkFreshInstall(noGmail).join(" ")).toContain("Gmail");
    const loading = readHealthFrom(
      BASE_HTML.replace('<div class="ccc-health">', '<div class="ccc-health" aria-busy="true">'),
    );
    expect(checkFreshInstall(loading).join(" ")).toContain("still loading");
  });

  it("flags raw error text anywhere in the section, naming the kind and never the text", () => {
    const leaky = readHealthFrom(
      BASE_HTML.replace(
        "<p>No managed vault is set up yet.</p>",
        "<p>No managed vault is set up yet. ENOENT: no such file /Users/username/vault</p>",
      ),
    );
    const problems = checkFreshInstall(leaky).join(" ");
    expect(problems).toContain("raw error text");
    expect(problems).not.toContain("/Users/username/vault");
    expect(problems).not.toContain("no such file");
  });
});

describe("findRawErrorText", () => {
  const samples: Array<[string, string]> = [
    ["a home path", "see /Users/username/Documents"],
    ["a temporary run folder", "at /tmp/ccc-uat.abc123/vaults/live"],
    ["a tilde path", "stored in ~/.something"],
    ["an errno name", "failed with EACCES"],
    ["an error prefix", "Error: boom"],
    ["a stack frame", "at run (file.js:10:5)"],
    ["an object dump", "[object Object]"],
    ["an undefined value", "Checked undefined"],
  ];

  it.each(samples)("flags %s", (kind, text) => {
    expect(findRawErrorText(text)).toContain(kind);
  });

  it("finds nothing in the plugin's own sentences", () => {
    for (const text of [
      reasonSentence("vault-root-missing"),
      reasonSentence("service-unreachable"),
      HEALTH_TEXT.schedulerFixedLine,
      "Version 0.1.0 · started 5s ago",
      "Nothing is failing.",
      "Nothing is due. Undefined behaviour is not mentioned here.".replace("Undefined", "Unclear"),
    ]) {
      expect(findRawErrorText(text), text).toEqual([]);
    }
  });
});

describe("expectReason", () => {
  it("passes when the row's code is the expected one and its sentence is the mapped sentence", () => {
    expect(() => expectReason(rowOf(fresh, "vault"), "vault-not-set-up")).not.toThrow();
  });

  it("fails with the row's actual code, never a path or the page text", () => {
    const leaky = readHealthFrom(
      BASE_HTML.replace(
        "<p>No managed vault is set up yet.</p>",
        "<p>/Users/username/secret-vault is gone</p>",
      ),
    );
    let message = "";
    try {
      expectReason(rowOf(leaky, "vault"), "vault-root-missing");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("vault-not-set-up");
    expect(message).toContain("vault-root-missing");
    expect(message).not.toContain("/Users/");
    expect(message).not.toContain("secret-vault");
  });

  it("fails when the code matches but the sentence does not", () => {
    const reworded = readHealthFrom(
      BASE_HTML.replace("No managed vault is set up yet.", "Something else entirely."),
    );
    expect(() => expectReason(rowOf(reworded, "vault"), "vault-not-set-up")).toThrow(/sentence/);
  });

  it("fails for a missing row", () => {
    expect(() => expectReason(undefined, "vault-ready")).toThrow(/no row/);
  });
});

interface Call {
  fn: unknown;
  args: unknown[];
}

function fakeBrowser(reads: HealthRead[]): {
  browser: HealthBrowser;
  clicks: Call[];
  commands: string[];
} {
  const clicks: Call[] = [];
  const commands: string[] = [];
  let read = 0;
  const browser = {
    executeObsidianCommand: async (id: string) => {
      commands.push(id);
    },
    executeObsidian: async (fn: unknown, ...args: unknown[]) => {
      clicks.push({ fn, args });
      return true;
    },
    execute: async () => reads[Math.min(read++, reads.length - 1)],
  } as unknown as HealthBrowser;
  return { browser, clicks, commands };
}

describe("openDiagnostics (Test 2)", () => {
  it("builds the click path: the Settings tab, then the Diagnostics item of the section nav", () => {
    const path = diagnosticsClickPath();
    expect(path).toEqual([
      { selector: "#ccc-tab-settings", text: null },
      {
        selector: 'nav[aria-label="Settings sections"] button.ccc-settings-nav-item',
        text: "Diagnostics",
      },
    ]);
  });

  it("builds the reopen path: another section first, so Diagnostics mounts again", () => {
    expect(reopenClickPath().map((step) => step.text)).toEqual([null, "Visual", "Diagnostics"]);
  });

  it("opens the command center, clicks the path in order and returns the settled section", async () => {
    const { browser, clicks, commands } = fakeBrowser([fresh]);
    const read = await openDiagnostics(browser);
    expect(commands).toEqual(["claude-command-center:open-overview"]);
    expect(clicks.map((call) => call.fn)).toEqual([rendererClick, rendererClick]);
    expect(clicks.map((call) => call.args)).toEqual(
      diagnosticsClickPath().map((step) => [step.selector, step.text]),
    );
    expect(read.mounted).toBe(true);
  });
});

describe("waitForHealth", () => {
  it("polls until the check finds nothing wrong, then returns the read", async () => {
    const loading = { ...fresh, busy: true } as HealthRead;
    const { browser } = fakeBrowser([loading, loading, fresh]);
    const read = await waitForHealth(
      browser,
      (value) => (value.busy ? ["still loading"] : []),
      "the section to settle",
      {
        timeoutMs: 5_000,
        intervalMs: 1,
      },
    );
    expect(read.busy).toBe(false);
  });

  it("names the problems seen last when the wait times out", async () => {
    const loading = { ...fresh, busy: true } as HealthRead;
    const { browser } = fakeBrowser([loading]);
    await expect(
      waitForHealth(browser, () => ["the vault row never changed"], "the vault row", {
        timeoutMs: 30,
        intervalMs: 5,
      }),
    ).rejects.toThrow(/the vault row never changed/);
  });
});
