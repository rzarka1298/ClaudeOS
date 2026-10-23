import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../repo-paths.js";
import { pathsForRoot } from "../run-root.js";
import { HEALTH_TEXT, reasonSentence } from "./health-copy.js";
import {
  BUNDLE_DOM_CONFIG,
  type BundleRead,
  bundleTextsEqual,
  checkBundleClean,
  checkBundleClosed,
  checkBundleOffered,
  checkBundleRefused,
  checkCachedReopen,
  checkFreshInstall,
  checkOffers,
  checkPartIs,
  checkRowIs,
  checkRunChecksPresses,
  checkSaveButton,
  checkSaveDialogCall,
  checkSavedFile,
  checkSchedulerLine,
  checkServiceRestored,
  checkServiceStopped,
  diagnosticsClickPath,
  drillFiles,
  expectPart,
  expectReason,
  expectRow,
  findRawErrorText,
  findUnguardedMutations,
  HEALTH_DOM_CONFIG,
  type HealthBrowser,
  type HealthRead,
  hostileProjectNames,
  installJsonWithNodePath,
  newCheckClock,
  openBundlePreview,
  openDiagnostics,
  partOf,
  recheck,
  reopenClickPath,
  reopenDiagnostics,
  rowOf,
  settingsWithAllHooksDisabled,
  settingsWithoutDisableAll,
  statusOfReason,
  waitForHealth,
  waitForLive,
  withRestore,
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
interface LooseElement {
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: () => void): void;
  textContent: string | null;
  focus(): void;
}

interface LooseDocument {
  querySelector(selector: string): unknown;
}

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

// ---------------------------------------------------------------------------
// Task 2: the break drills

const LIST_START = '<ul class="ccc-health-list">';
const NOT_IN_VERSION_START = '<h4 class="ccc-settings-group-title">Not part of this version</h4>';

function chipHtml(status: string, word: string): string {
  return `<span class="ccc-badge" data-status="${status}"><span class="ccc-visually-hidden">Status: </span><span class="ccc-badge-glyph" aria-hidden="true">?</span><span class="ccc-badge-label">${word}</span></span>`;
}

function rowHtml(spec: {
  subsystem: string;
  name: string;
  status: string;
  word: string;
  reason: string;
  text: string;
  detail?: string;
  meta?: boolean;
  parts?: string;
}): string {
  const meta =
    spec.meta === false
      ? '<p class="ccc-health-meta"><span>Not checked</span> <span class="ccc-badge" data-badge="unavailable"><span class="ccc-badge-glyph" aria-hidden="true">?</span><span class="ccc-visually-hidden">Freshness: </span><span class="ccc-badge-label">Unavailable</span></span></p>'
      : '<p class="ccc-health-meta"><span>Checked </span><time datetime="2026-10-23T10:00:00.000Z">just now</time> <span class="ccc-badge" data-badge="live"><span class="ccc-badge-glyph" aria-hidden="true">?</span><span class="ccc-visually-hidden">Freshness: </span><span class="ccc-badge-label">Live</span></span></p>';
  const detail = spec.detail === undefined ? "" : `<p class="ccc-health-detail">${spec.detail}</p>`;
  return `<li class="ccc-health-row" data-status="${spec.status}" data-subsystem="${spec.subsystem}" data-reason="${spec.reason}"><div><h5 class="ccc-settings-item-title">${spec.name}</h5>${chipHtml(spec.status, spec.word)}</div><div><p>${spec.text}</p>${detail}${meta}</div>${spec.parts ?? ""}</li>`;
}

const NAMES: Record<string, string> = {
  service: "Companion service",
  vault: "Vault access",
  hooks: "Claude Code hooks",
  collectors: "Usage collectors",
  scheduler: "Scheduler",
  launchers: "App launchers",
};

/** The section with the six rows replaced by `rows` (the Not part of this version rows stay). */
function sectionWith(rows: string[]): string {
  const head = BASE_HTML.slice(0, BASE_HTML.indexOf(LIST_START) + LIST_START.length);
  const tailAt = BASE_HTML.indexOf("</ul>", BASE_HTML.indexOf(LIST_START));
  const tail = BASE_HTML.slice(tailAt);
  void NOT_IN_VERSION_START;
  return `${head}${rows.join("")}${tail}`;
}

const NOT_RUNNING = "Can't be checked while the companion service isn't running.";

function clearedRow(subsystem: string): string {
  return rowHtml({
    subsystem,
    name: NAMES[subsystem] as string,
    status: "unknown",
    word: "Unknown",
    reason: "service-not-running",
    text: NOT_RUNNING,
    meta: false,
  });
}

const STOPPED_HTML = sectionWith([
  rowHtml({
    subsystem: "service",
    name: "Companion service",
    status: "failing",
    word: "Failing",
    reason: "service-unreachable",
    text: "The plugin can't reach the companion service.",
    meta: false,
  }),
  ...["vault", "hooks", "collectors", "scheduler", "launchers"].map(clearedRow),
]);

describe("checkServiceStopped and checkServiceRestored (item 23)", () => {
  const stopped = readHealthFrom(STOPPED_HTML);

  it("accepts the stopped look: the service row Failing, the other five Unknown with no last value", () => {
    expect(checkServiceStopped(stopped)).toEqual([]);
  });

  it("flags a service row that is not Failing with the unreachable reason", () => {
    const problems = checkServiceStopped(fresh).join(" ");
    expect(problems).toContain("Companion service");
  });

  it("flags a row that kept a last value, a detail or a wrong reason", () => {
    const kept = readHealthFrom(
      STOPPED_HTML.replace(
        'data-subsystem="vault" data-reason="service-not-running"',
        'data-subsystem="vault" data-reason="vault-ready"',
      ),
    );
    expect(checkServiceStopped(kept).join(" ")).toContain("Vault access");
    const detail = readHealthFrom(
      STOPPED_HTML.replace(
        `<p>${NOT_RUNNING}</p>`,
        `<p>${NOT_RUNNING}</p><p class="ccc-health-detail">Version 0.1.0 · started 5s ago</p>`,
      ),
    );
    expect(checkServiceStopped(detail).join(" ")).toContain("last value");
  });

  it("flags raw error text on a stopped section, naming the kind only", () => {
    const leaky = readHealthFrom(
      STOPPED_HTML.replace(
        "The plugin can't reach the companion service.",
        "connect ECONNREFUSED /tmp/ccc-uat.abc123/rt/svc.sock",
      ),
    );
    const problems = checkServiceStopped(leaky).join(" ");
    expect(problems).toContain("raw error text");
    expect(problems).not.toContain("svc.sock");
  });

  it("accepts the restored look: the service Running and no row still cleared", () => {
    expect(checkServiceRestored(fresh)).toEqual([]);
    expect(checkServiceRestored(stopped).join(" ")).toContain("Companion service");
  });
});

describe("checkRowIs and checkPartIs", () => {
  it("accepts a row with the expected status, reason code and sentence", () => {
    expect(
      checkRowIs(fresh, "vault", { status: "setup-needed", reason: "vault-not-set-up" }),
    ).toEqual([]);
  });

  it("names the row and the codes when the status or the reason is not the expected one", () => {
    const wrongStatus = checkRowIs(fresh, "vault", {
      status: "failing",
      reason: "vault-not-set-up",
    });
    expect(wrongStatus.join(" ")).toContain("Vault access");
    expect(wrongStatus.join(" ")).toContain("failing");
    const wrongReason = checkRowIs(fresh, "vault", {
      status: "setup-needed",
      reason: "vault-root-missing",
    });
    expect(wrongReason.join(" ")).toContain("vault-root-missing");
    expect(wrongReason.join(" ")).toContain("vault-not-set-up");
  });

  it("can require a button on the row, in its callout or in a part", () => {
    expect(
      checkRowIs(fresh, "hooks", {
        status: "setup-needed",
        reason: "hooks-not-installed",
        button: "Copy install command",
      }),
    ).toEqual([]);
    expect(
      checkRowIs(fresh, "hooks", {
        status: "setup-needed",
        reason: "hooks-not-installed",
        button: "Set up vault",
      }).join(" "),
    ).toContain("Set up vault");
    expect(
      checkRowIs(fresh, "collectors", {
        status: "setup-needed",
        reason: "statusline-not-installed",
        button: "Go to the security section",
      }),
    ).toEqual([]);
  });

  it("reports a missing row", () => {
    expect(checkRowIs(fresh, "nothing", { status: "ok", reason: "x" }).join(" ")).toContain(
      "no nothing row",
    );
  });

  it("judges a part by its id, status, reason code and sentence", () => {
    expect(
      checkPartIs(fresh, "collectors", "codex-install", {
        status: "setup-needed",
        reason: "codex-not-installed",
      }),
    ).toEqual([]);
    expect(
      checkPartIs(fresh, "collectors", "codex-install", {
        status: "ok",
        reason: "codex-not-installed",
      }).join(" "),
    ).toContain("codex-install");
    expect(
      checkPartIs(fresh, "collectors", "nope", { status: "ok", reason: "x" }).join(" "),
    ).toContain("no nope part");
  });

  it("describes the Codex parts as the sandbox: no home path or version on them", () => {
    const parts = rowOf(fresh, "collectors")?.parts.filter((part) =>
      part.partId.startsWith("codex"),
    );
    expect(parts?.length).toBe(4);
    for (const part of parts ?? []) expect(findRawErrorText(part.text), part.partId).toEqual([]);
  });
});

describe("rendererPressRunChecksTwice and checkRunChecksPresses (item 30)", () => {
  async function press(behaviour: "gated" | "ungated"): Promise<unknown> {
    const { JSDOM } = loadJsdom();
    const dom = new JSDOM(`<!doctype html><html><body>${BASE_HTML}</body></html>`);
    const window = dom.window as Record<string, unknown> & { document: LooseDocument };
    const document = window.document;
    const button = document.querySelector(".ccc-health-toolbar button") as LooseElement;
    const status = document.querySelector(".ccc-settings-status") as LooseElement;
    let busy = false;
    button.addEventListener("click", () => {
      if (busy && behaviour === "gated") return;
      busy = true;
      button.setAttribute("aria-busy", "true");
      button.setAttribute("aria-disabled", "true");
      status.textContent = "Checking…";
      if (behaviour === "ungated") status.textContent = `Checking… ${Math.random()}`;
    });
    const context = vm.createContext({ document, window });
    const text = rendererText("rendererPressRunChecksTwice");
    return vm.runInContext(
      `(${text}).apply(null, ${JSON.stringify([HEALTH_DOM_CONFIG])})`,
      context,
    );
  }

  it("presses the button twice back to back and reports what the page showed after each press", async () => {
    const result = JSON.parse(JSON.stringify(await press("gated")));
    expect(result.found).toBe(true);
    expect(result.first).toEqual({ busy: true, disabled: true, status: "Checking…" });
    expect(result.second).toEqual({ busy: true, disabled: true, status: "Checking…" });
    expect(checkRunChecksPresses(result)).toEqual([]);
  });

  it("flags a second press that was not ignored, a missing button and a press that did nothing", () => {
    const idle = { busy: false, disabled: false, status: "" };
    const busy = { busy: true, disabled: true, status: "Checking…" };
    expect(checkRunChecksPresses({ found: false, first: null, second: null }).join(" ")).toContain(
      "button",
    );
    expect(checkRunChecksPresses({ found: true, first: idle, second: idle }).join(" ")).toContain(
      "busy",
    );
    expect(
      checkRunChecksPresses({
        found: true,
        first: busy,
        second: { ...busy, status: "Checking… again" },
      }).join(" "),
    ).toContain("second press");
  });
});

describe("checkCachedReopen (item 30)", () => {
  const cachedHtml = BASE_HTML.replace(/data-badge="live"/g, 'data-badge="cached"').replace(
    /<span class="ccc-badge-label">Live<\/span>/g,
    '<span class="ccc-badge-label">Cached</span>',
  );

  it("accepts a reopening that shows every row as Cached with the same checked time", () => {
    expect(checkCachedReopen(fresh, readHealthFrom(cachedHtml))).toEqual([]);
  });

  it("flags rows that are not Cached and a checked time that moved", () => {
    expect(checkCachedReopen(fresh, fresh).join(" ")).toContain("Cached");
    const moved = readHealthFrom(
      cachedHtml.replace(
        'datetime="2026-10-23T10:00:00.000Z" title="Oct 23, 2026, 10:00 AM" aria-describedby="abs-toolbar"',
        'datetime="2026-10-23T10:00:09.000Z" title="x" aria-describedby="abs-toolbar"',
      ),
    );
    expect(checkCachedReopen(fresh, moved).join(" ")).toContain("checked time");
  });
});

describe("withRestore (item 29/24/25 drill discipline)", () => {
  it("runs the restore after a step that succeeded and returns its value", async () => {
    const order: string[] = [];
    const value = await withRestore(
      async () => {
        order.push("restore");
      },
      async () => {
        order.push("step");
        return 7;
      },
    );
    expect(value).toBe(7);
    expect(order).toEqual(["step", "restore"]);
  });

  it("runs the restore when the step throws, and the step's error is the one thrown", async () => {
    const order: string[] = [];
    await expect(
      withRestore(
        async () => {
          order.push("restore");
          throw new Error("restore failed");
        },
        async () => {
          order.push("step");
          throw new Error("step failed");
        },
      ),
    ).rejects.toThrow("step failed");
    expect(order).toEqual(["step", "restore"]);
  });

  it("throws the restore's error when the step itself succeeded", async () => {
    await expect(
      withRestore(
        async () => {
          throw new Error("restore failed");
        },
        async () => 1,
      ),
    ).rejects.toThrow("restore failed");
  });
});

describe("findUnguardedMutations (Test 3)", () => {
  it("flags a mutating call outside withRestore and withMode, with its line", () => {
    const source = [
      "it('x', async () => {",
      "  replaceFileInRunRoot(paths, file, 'x');",
      "  await withRestore(() => removeFileInRunRoot(paths, file), async () => {",
      "    replaceFileInRunRoot(paths, file, 'y');",
      "  });",
      "  await withMode(paths, dir, 0o000, async () => { renameInRunRoot(paths, a, b); });",
      "  writeSpoolDrops(paths, 3);",
      "});",
    ].join("\n");
    expect(findUnguardedMutations(source)).toEqual([
      { call: "replaceFileInRunRoot", line: 2 },
      { call: "writeSpoolDrops", line: 7 },
    ]);
  });

  it("ignores a mutating name in a comment or a string", () => {
    const source = "// replaceFileInRunRoot(a)\nconst x = 'removeFileInRunRoot(b)';\n";
    expect(findUnguardedMutations(source)).toEqual([]);
  });

  it("finds nothing unguarded in the bundle export spec", () => {
    const spec = readFileSync(join(REPO_ROOT, "packages/e2e/specs/bundle-export.e2e.ts"), "utf8");
    expect(findUnguardedMutations(spec)).toEqual([]);
  });

  it("finds nothing unguarded in the health drills spec", () => {
    const spec = readFileSync(join(REPO_ROOT, "packages/e2e/specs/health-drills.e2e.ts"), "utf8");
    expect(findUnguardedMutations(spec)).toEqual([]);
  });
});

describe("drill recipes", () => {
  const paths = pathsForRoot("/tmp/ccc-uat.abc123", "0123abcd");

  it("names the sandbox files the drills touch, all below the run root", () => {
    const files = drillFiles(paths);
    expect(files.claudeSettings).toBe("/tmp/ccc-uat.abc123/claude/settings.json");
    expect(files.installJson).toBe("/tmp/ccc-uat.abc123/rt/hooks/install.json");
    expect(files.spoolDropped).toBe("/tmp/ccc-uat.abc123/rt/spool/hooks.dropped");
    expect(files.fakeClaude).toBe("/tmp/ccc-uat.abc123/fake-bin/claude");
    for (const file of Object.values(files))
      expect(file.startsWith(`${paths.root}/`), file).toBe(true);
  });

  it("turns all hooks off in Claude's settings text and back on, keeping every other key", () => {
    const original = JSON.stringify({ hooks: { Stop: [] }, other: 1 }, null, 2);
    const off = settingsWithAllHooksDisabled(original);
    expect(JSON.parse(off)).toEqual({ hooks: { Stop: [] }, other: 1, disableAllHooks: true });
    expect(JSON.parse(settingsWithoutDisableAll(off))).toEqual({ hooks: { Stop: [] }, other: 1 });
    expect(() => settingsWithAllHooksDisabled("not json")).toThrow(/settings/);
    expect(() => settingsWithAllHooksDisabled("[1]")).toThrow(/settings/);
  });

  it("points the install record's node path at a missing program, keeping the other keys", () => {
    const original = JSON.stringify({ nodePath: "/usr/local/bin/node", v: 1 });
    const broken = installJsonWithNodePath(original, "/tmp/ccc-uat.abc123/fake-bin/missing-node");
    expect(JSON.parse(broken)).toEqual({
      nodePath: "/tmp/ccc-uat.abc123/fake-bin/missing-node",
      v: 1,
    });
    expect(() => installJsonWithNodePath("x", "/a")).toThrow(/install record/);
  });
});

describe("statusOfReason, expectRow and expectPart", () => {
  it("takes the status of a reason code from the domain's own table", () => {
    expect(statusOfReason("vault", "vault-mismatch")).toBe("degraded");
    expect(statusOfReason("vault", "vault-root-missing")).toBe("failing");
    expect(statusOfReason("hooks", "no-events-yet")).toBe("unknown");
    expect(statusOfReason("scheduler", "run-interrupted")).toBe("unknown");
    expect(statusOfReason("launchers", "bundle-not-found")).toBe("failing");
    expect(statusOfReason("service", "service-unreachable")).toBe("failing");
    expect(() => statusOfReason("vault", "no-such-reason")).toThrow(/reason code/);
    expect(() => statusOfReason("nowhere", "vault-ready")).toThrow(/subsystem/);
  });

  it("judges a row and a part by code alone, with the status the domain says", () => {
    expect(expectRow(fresh, "vault", "vault-not-set-up")).toEqual([]);
    expect(expectRow(fresh, "vault", "vault-root-missing").join(" ")).toContain(
      "vault-root-missing",
    );
    expect(expectPart(fresh, "collectors", "codex-install", "codex-not-installed")).toEqual([]);
    expect(expectPart(fresh, "collectors", "spool", "spool-dropped-records").join(" ")).toContain(
      "spool",
    );
  });
});

describe("checkOffers and checkSchedulerLine", () => {
  it("finds a button on the row's callout or in one of its parts", () => {
    expect(checkOffers(fresh, "hooks", "Copy install command")).toEqual([]);
    expect(checkOffers(fresh, "collectors", "Go to the security section")).toEqual([]);
    expect(checkOffers(fresh, "hooks", "Set up vault").join(" ")).toContain("Set up vault");
    expect(checkOffers(fresh, "nothing", "x").join(" ")).toContain("no nothing row");
  });

  it("requires the scheduler's fixed manual-trigger line in every state", () => {
    expect(checkSchedulerLine(fresh)).toEqual([]);
    const without = readHealthFrom(
      BASE_HTML.replace(
        '<p class="ccc-health-detail">Manual trigger only in this version. Nothing runs on a timer.</p>',
        "",
      ),
    );
    expect(checkSchedulerLine(without).join(" ")).toContain("Manual trigger only");
  });
});

describe("rendererReadSection and rendererReadModal", () => {
  function run(name: string, html: string, config: unknown, focus?: string): unknown {
    const { JSDOM } = loadJsdom();
    const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
    const window = dom.window as Record<string, unknown> & { document: LooseDocument };
    if (focus !== undefined) (window.document.querySelector(focus) as LooseElement).focus();
    const context = vm.createContext({ document: window.document, window });
    const text = rendererText(name);
    return JSON.parse(
      JSON.stringify(vm.runInContext(`(${text}).apply(null, ${JSON.stringify(config)})`, context)),
    );
  }

  it("reads the current nav item, the section heading and whether the heading holds focus", () => {
    expect(run("rendererReadSection", BASE_HTML, [HEALTH_DOM_CONFIG], "h3")).toEqual({
      navCurrent: "Diagnostics",
      heading: "Diagnostics",
      headingFocused: true,
    });
    expect(run("rendererReadSection", BASE_HTML, [HEALTH_DOM_CONFIG])).toMatchObject({
      headingFocused: false,
    });
  });

  it("reads the open modal's title and button labels, or null when there is none", () => {
    expect(run("rendererReadModal", BASE_HTML, [])).toEqual({ title: null, buttons: [] });
    const modal = `${BASE_HTML}<div class="modal"><h2>Set up managed vault</h2><div><button>Confirm</button><button>Cancel</button></div></div>`;
    expect(run("rendererReadModal", modal, [])).toEqual({
      title: "Set up managed vault",
      buttons: ["Confirm", "Cancel"],
    });
  });
});

describe("reopenDiagnostics, waitForLive and recheck", () => {
  function scripted(reads: HealthRead[]): {
    browser: HealthBrowser;
    clicks: unknown[][];
    presses: number;
  } {
    const clicks: unknown[][] = [];
    const state = { presses: 0 };
    let index = 0;
    const browser = {
      executeObsidianCommand: async () => undefined,
      executeObsidian: async (_fn: unknown, ...args: unknown[]) => {
        clicks.push(args);
        if (args[1] === "Run checks again") state.presses += 1;
        return true;
      },
      execute: async () => reads[Math.min(index++, reads.length - 1)],
    } as unknown as HealthBrowser;
    return {
      browser,
      clicks,
      get presses() {
        return state.presses;
      },
    };
  }

  const newer = { ...fresh, toolbarGeneratedAt: "2026-10-23T10:00:30.000Z" } as HealthRead;

  it("clicks the reopen path (another section, then Diagnostics) and returns the settled section", async () => {
    const { browser, clicks } = scripted([fresh]);
    const read = await reopenDiagnostics(browser);
    expect(clicks.map((args) => args[1])).toEqual([null, "Visual", "Diagnostics"]);
    expect(read.mounted).toBe(true);
  });

  it("waits until the Run checks again button is free, which means the service is live", async () => {
    const disabled = { ...fresh, runChecks: { ...fresh.runChecks, disabled: true } } as HealthRead;
    const { browser } = scripted([disabled, disabled, fresh]);
    const read = await waitForLive(browser, { timeoutMs: 5_000, intervalMs: 1 });
    expect(read.runChecks?.disabled).toBe(false);
  });

  it("presses Run checks again and returns the first section that shows a newer answer", async () => {
    const stub = scripted([fresh, fresh, newer]);
    const clock = newCheckClock();
    const read = await recheck(stub.browser, clock, {
      gapMs: 0,
      wait: { timeoutMs: 5_000, intervalMs: 1 },
    });
    expect(read.toolbarGeneratedAt).toBe("2026-10-23T10:00:30.000Z");
    expect(stub.presses).toBe(1);
    expect(clock.lastPressAt).toBeGreaterThan(0);
  });

  it("waits out the answer cache before it presses", async () => {
    const stub = scripted([fresh, newer]);
    const clock = { lastPressAt: Date.now() };
    const started = Date.now();
    await recheck(stub.browser, clock, { gapMs: 120, wait: { timeoutMs: 5_000, intervalMs: 1 } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// Task 3: the diagnostic bundle block

const BUNDLE_JSON = JSON.stringify(
  {
    bundleVersion: 1,
    generatedAt: "2026-10-23T10:00:00.000Z",
    versions: {
      plugin: "0.1.0",
      service: "0.1.0",
      obsidian: "1.13.7",
      electron: "37.2.1",
      node: "24.20.0",
      storeSchema: 7,
    },
    platform: { os: "darwin", arch: "arm64" },
    connection: { state: "live" },
    subsystems: [
      {
        id: "service",
        status: "ok",
        reasonCode: "service-live",
        checkedAt: "2026-10-23T10:00:00.000Z",
        freshness: "live",
      },
      {
        id: "vault",
        status: "setup-needed",
        reasonCode: "vault-not-set-up",
        checkedAt: "2026-10-23T10:00:00.000Z",
        freshness: "live",
      },
      {
        id: "hooks",
        status: "setup-needed",
        reasonCode: "hooks-not-installed",
        checkedAt: "2026-10-23T10:00:00.000Z",
        freshness: "live",
      },
      {
        id: "collectors",
        status: "setup-needed",
        reasonCode: "statusline-not-installed",
        checkedAt: "2026-10-23T10:00:00.000Z",
        freshness: "live",
      },
      {
        id: "scheduler",
        status: "setup-needed",
        reasonCode: "never-run",
        checkedAt: "2026-10-23T10:00:00.000Z",
        freshness: "live",
      },
      {
        id: "launchers",
        status: "setup-needed",
        reasonCode: "launcher-not-set-up",
        checkedAt: "2026-10-23T10:00:00.000Z",
        freshness: "live",
      },
    ],
    counts: { projects: 0, scanFolders: 0, openTasks: 0, reports: 0, pluginDiagnostics: 0 },
    features: {
      reducedMotion: "auto",
      transcriptAnalysis: false,
      notifyApprovals: true,
      launchers: { antigravity: null, "claude-code": null, "claude-desktop": null, codex: null },
    },
    pluginDiagnostics: [],
  },
  null,
  2,
);

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function button(label: string, extra = ""): string {
  return `<button type="button" class="ccc-connect-button" data-variant="secondary"${extra}>${label}</button>`;
}

interface BundleHtmlSpec {
  open?: boolean;
  preview?: string;
  refusal?: boolean;
  saveDisabled?: string;
  stale?: boolean;
  waiting?: boolean;
}

function bundleHtml(spec: BundleHtmlSpec = {}): string {
  const open = spec.open ?? false;
  const parts: string[] = [
    '<h4 class="ccc-settings-group-title">Diagnostic bundle</h4>',
    "<p>A bundle lists versions, the status of each subsystem with its reason code, counts and setting flags. Read the preview before you share it.</p>",
    `<div class="ccc-health-toolbar">${button(open ? "Hide bundle preview" : "Show bundle preview", ` aria-expanded="${open}"`)}</div>`,
  ];
  if (open && spec.refusal === true) {
    parts.push(
      `<div id="pv" class="ccc-setup-callout"><h5 tabindex="-1" class="ccc-settings-item-title"><span class="ccc-error-glyph" aria-hidden="true">▲</span> Bundle not offered</h5><p>The bundle failed a privacy check (a project name), so it can't be copied or saved. Nothing was exported. Run the checks again to rebuild it.</p>${button("Run checks again")}</div>`,
    );
  } else if (open && spec.waiting === true) {
    parts.push(
      '<div id="pv" aria-busy="true"><div class="ccc-skeleton-line" aria-hidden="true"></div></div>',
    );
  } else if (open) {
    parts.push(
      `<pre id="pv" class="ccc-bundle-preview" tabindex="0" role="region" aria-label="Diagnostic bundle preview">${escapeHtml(spec.preview ?? BUNDLE_JSON)}</pre>`,
    );
    if (spec.stale === true) {
      parts.push(
        `<div class="ccc-health-toolbar"><p class="ccc-health-stale">Built from checks older than 5 minutes</p>${button("Run checks again")}</div>`,
      );
    }
  }
  if (open) {
    const refused = spec.refusal === true;
    const waiting = spec.waiting === true;
    const reason = refused
      ? "The bundle was refused by a privacy check."
      : waiting
        ? "Waiting for the checks."
        : spec.saveDisabled;
    parts.push(
      `<div class="ccc-health-toolbar">${refused || waiting ? "" : "<p>1.4 KB · 61 lines</p>"}${button("Copy bundle", refused || waiting ? ' aria-disabled="true" aria-describedby="why"' : "")}${button("Save bundle", reason === undefined ? "" : ' aria-disabled="true" aria-describedby="why"')}${reason === undefined ? "" : `<p id="why">${reason}</p>`}</div>`,
    );
  }
  return parts.join("");
}

function withBundle(spec: BundleHtmlSpec): HealthRead & { bundle: BundleRead } {
  const html = BASE_HTML.replace(
    "</div>\n    </div>\n  </div>\n</section>",
    `</div>${bundleHtml(spec)}\n    </div>\n  </div>\n</section>`,
  );
  return readBundleFrom(html);
}

function readBundleFrom(html: string): HealthRead & { bundle: BundleRead } {
  const { JSDOM } = loadJsdom();
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
  const window = dom.window as Record<string, unknown> & { document: LooseDocument };
  const context = vm.createContext({ document: window.document, window });
  const text = rendererText("rendererReadBundle");
  const out = vm.runInContext(
    `(${text}).apply(null, ${JSON.stringify([BUNDLE_DOM_CONFIG])})`,
    context,
  );
  return { bundle: JSON.parse(JSON.stringify(out)) as BundleRead } as HealthRead & {
    bundle: BundleRead;
  };
}

describe("rendererReadBundle (Task 3)", () => {
  it("finds the block by its heading and reads the closed state: only the toggle", () => {
    const { bundle } = withBundle({});
    expect(bundle.mounted).toBe(true);
    expect(bundle.buttons).toEqual([
      { label: "Show bundle preview", expanded: false, disabled: false, busy: false, reason: null },
    ]);
    expect(bundle.preview).toBeNull();
    expect(bundle.refusal).toBeNull();
  });

  it("reads the open preview exactly (line breaks and indentation kept) with its role and label", () => {
    const { bundle } = withBundle({ open: true });
    expect(bundle.preview?.text).toBe(BUNDLE_JSON);
    expect(bundle.preview).toMatchObject({
      role: "region",
      label: "Diagnostic bundle preview",
      focusable: true,
    });
    expect(bundle.buttons.map((entry) => entry.label)).toEqual([
      "Hide bundle preview",
      "Copy bundle",
      "Save bundle",
    ]);
    expect(bundle.sizeLine).toBe("1.4 KB · 61 lines");
  });

  it("reads a disabled Save with the reason its aria-describedby names", () => {
    const { bundle } = withBundle({
      open: true,
      saveDisabled: "The save dialog isn't available here. Use Copy bundle instead.",
    });
    const save = bundle.buttons.find((entry) => entry.label === "Save bundle");
    expect(save).toMatchObject({
      disabled: true,
      reason: "The save dialog isn't available here. Use Copy bundle instead.",
    });
    expect(bundle.buttons.find((entry) => entry.label === "Copy bundle")?.disabled).toBe(false);
  });

  it("reads a refusal by its heading and closed label, never a preview", () => {
    const { bundle } = withBundle({ open: true, refusal: true });
    expect(bundle.preview).toBeNull();
    expect(bundle.refusal?.heading).toBe("Bundle not offered");
    expect(bundle.refusal?.text).toContain("privacy check");
    expect(bundle.buttons.find((entry) => entry.label === "Copy bundle")).toMatchObject({
      disabled: true,
      reason: "The bundle was refused by a privacy check.",
    });
  });

  it("reads the stale line and the status line", () => {
    const { bundle } = withBundle({ open: true, stale: true });
    expect(bundle.stale).toBe("Built from checks older than 5 minutes");
    expect(bundle.statusLine).toBe("");
  });

  it("reads a block that is not on the page as not mounted", () => {
    const { bundle } = readBundleFrom(BASE_HTML);
    expect(bundle.mounted).toBe(false);
    expect(bundle.buttons).toEqual([]);
  });
});

describe("bundle verdicts (Task 3)", () => {
  const closed = withBundle({}).bundle;
  const offered = withBundle({ open: true }).bundle;
  const noDialog = withBundle({
    open: true,
    saveDisabled: "The save dialog isn't available here. Use Copy bundle instead.",
  }).bundle;
  const refused = withBundle({ open: true, refusal: true }).bundle;

  it("checkBundleClosed accepts the toggle alone and flags a preview or a Copy button", () => {
    expect(checkBundleClosed(closed)).toEqual([]);
    expect(checkBundleClosed(offered).join(" ")).toContain("preview");
  });

  it("checkBundleOffered accepts a labelled region with Copy enabled and Save present", () => {
    expect(checkBundleOffered(offered)).toEqual([]);
    expect(checkBundleOffered(closed).join(" ")).toContain("no preview");
    expect(checkBundleOffered(refused).join(" ")).toContain("Bundle not offered");
    expect(checkBundleOffered(withBundle({ open: true, stale: true }).bundle).join(" ")).toContain(
      "older than 5 minutes",
    );
  });

  it("checkBundleRefused accepts the refusal heading with no preview and Copy and Save disabled", () => {
    expect(checkBundleRefused(refused)).toEqual([]);
    expect(checkBundleRefused(offered).join(" ")).toContain("refusal");
  });

  it("checkSaveButton reports Save's presence and state, and a disabled Save must say why", () => {
    expect(checkSaveButton(offered)).toEqual([]);
    expect(checkSaveButton(noDialog)).toEqual([]);
    expect(checkSaveButton(closed).join(" ")).toContain("Save bundle");
    const silent = withBundle({ open: true, saveDisabled: "" }).bundle;
    expect(checkSaveButton(silent).join(" ")).toContain("reason");
  });

  it("bundleTextsEqual compares the preview and the copied text byte for byte", () => {
    expect(bundleTextsEqual(BUNDLE_JSON, BUNDLE_JSON)).toEqual([]);
    expect(bundleTextsEqual(BUNDLE_JSON, `${BUNDLE_JSON}\n`).join(" ")).toContain("byte");
    expect(
      bundleTextsEqual(BUNDLE_JSON, BUNDLE_JSON.replace("darwin", "linux")).join(" "),
    ).toContain("byte");
    expect(bundleTextsEqual(BUNDLE_JSON, undefined).join(" ")).toContain("nothing was copied");
    // Same characters, different bytes: a composed and a decomposed letter.
    expect(bundleTextsEqual("caf\u00e9", "cafe\u0301").join(" ")).toContain("byte");
  });

  it("checkSavedFile needs the preview's bytes and mode 0600", () => {
    const bytes = Buffer.from(BUNDLE_JSON, "utf8");
    expect(checkSavedFile(BUNDLE_JSON, bytes, 0o600)).toEqual([]);
    expect(checkSavedFile(BUNDLE_JSON, Buffer.from("x"), 0o600).join(" ")).toContain("preview");
    expect(checkSavedFile(BUNDLE_JSON, bytes, 0o644).join(" ")).toContain("600");
  });

  it("checkSaveDialogCall needs a bare default name, the json filter and the overwrite confirmation", () => {
    const call = {
      defaultPath: "claude-command-center-diagnostics-2026-10-23.json",
      bareDefaultName: true,
      filters: [{ name: "JSON", extensions: ["json"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    };
    expect(checkSaveDialogCall(call)).toEqual([]);
    expect(checkSaveDialogCall({ ...call, bareDefaultName: false }).join(" ")).toContain("bare");
    expect(checkSaveDialogCall({ ...call, defaultPath: "bundle.json" }).join(" ")).toContain(
      "name",
    );
    expect(checkSaveDialogCall({ ...call, properties: [] }).join(" ")).toContain("overwrite");
    expect(checkSaveDialogCall({ ...call, filters: [] }).join(" ")).toContain("filter");
    expect(checkSaveDialogCall(undefined).join(" ")).toContain("no save dialog call");
  });
});

describe("checkBundleClean (Task 3)", () => {
  const facts = {
    runRoot: "/tmp/ccc-uat.abc123",
    homeFolder: "/Users/username",
    userName: "username-example",
    vaultName: "live",
    projectNames: ["Orchard Ledger"],
    folderBasenames: ["plum-cellar"],
  };

  it("accepts a clean bundle: versions, subsystem reason codes, counts and setting flags", () => {
    expect(checkBundleClean(BUNDLE_JSON, facts)).toEqual([]);
  });

  it("flags text that is not the bundle format, naming only the check that failed", () => {
    expect(checkBundleClean("not json", facts).join(" ")).toContain("JSON");
    expect(checkBundleClean(JSON.stringify({ bundleVersion: 1 }), facts).join(" ")).toContain(
      "format",
    );
  });

  it("flags a name, a path, an address or a token by label and never shows the value", () => {
    const leaks: Array<[string, string]> = [
      ["the project name", "Orchard Ledger"],
      ["a folder name", "plum-cellar"],
      ["the run root", "/tmp/ccc-uat.abc123"],
      ["the home folder", "/Users/username"],
      ["the user name", "username-example"],
    ];
    for (const [label, value] of leaks) {
      const dirty = BUNDLE_JSON.replace('"node": "24.20.0"', `"node": "24.20.0 ${value}"`);
      const problems = checkBundleClean(dirty, facts).join(" ");
      expect(problems, label).toContain(label);
      expect(problems, label).not.toContain(value);
    }
  });

  it("flags an email address and a token-shaped string through the domain verifier, by rule", () => {
    const email = BUNDLE_JSON.replace('"node": "24.20.0"', '"node": "person@mail.co"');
    expect(checkBundleClean(email, facts).join(" ")).toMatch(/email|format/);
    expect(checkBundleClean(email, facts).join(" ")).not.toContain("person@mail.co");
  });

  it("flags a bundle over the size cap and one missing a section", () => {
    const missing = JSON.parse(BUNDLE_JSON) as Record<string, unknown>;
    delete missing.counts;
    const padded = JSON.stringify({ ...JSON.parse(BUNDLE_JSON), pad: "x".repeat(40_000) }, null, 2);
    expect(checkBundleClean(padded, facts).join(" ")).toContain("size cap");
    expect(checkBundleClean(JSON.stringify(missing, null, 2), facts).join(" ")).toContain("format");
  });
});

describe("hostileProjectNames and openBundlePreview (Task 3)", () => {
  it("takes folder names that are safe on disk from the domain's hostile corpus", () => {
    const names = hostileProjectNames();
    expect(names.folders.length).toBeGreaterThanOrEqual(3);
    for (const folder of names.folders) {
      expect(folder).not.toMatch(/[\\/\0]/);
      expect(folder.length).toBeLessThanOrEqual(80);
    }
    expect(names.displayNames.some((name) => /\/(?:Users|home)/.test(name))).toBe(true);
    expect(names.displayNames.some((name) => name.includes("@"))).toBe(true);
    // The names that must stay out of the bundle are the corpus's own invented ones.
    expect(names.projectNames).toContain("Orchard Ledger");
    expect(names.folderBasenames).toContain("plum-cellar");
  });

  it("presses the toggle and returns the offered block", async () => {
    const calls: unknown[][] = [];
    let step = 0;
    const closedRead = readBundleFrom(
      BASE_HTML.replace(
        "</div>\n    </div>\n  </div>\n</section>",
        `</div>${bundleHtml({})}\n    </div>\n  </div>\n</section>`,
      ),
    ).bundle;
    const openRead = withBundle({ open: true }).bundle;
    const browser = {
      executeObsidianCommand: async () => undefined,
      executeObsidian: async (_fn: unknown, ...args: unknown[]) => {
        calls.push(args);
        return true;
      },
      execute: async () => (step++ === 0 ? closedRead : openRead),
    } as unknown as HealthBrowser;
    const read = await openBundlePreview(browser);
    expect(calls[0]).toEqual([`.ccc-health-toolbar button`, "Show bundle preview"]);
    expect(read.preview?.text).toBe(BUNDLE_JSON);
  });
});
