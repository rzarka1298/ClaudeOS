import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../repo-paths.js";
import {
  BANNER_CONFIG,
  type BannerRead,
  BUNDLE_GEOMETRY_CONFIG,
  type BundleGeometry,
  buildSessionEventRecord,
  checkAgentRunsIdle,
  checkAgentRunsRunning,
  checkAgentRunsSilent,
  checkBannerDisplayPath,
  checkBundleLineInView,
  checkCardIdle,
  checkCardRunning,
  checkDecidedThrough,
  checkLaunchersHeading,
  checkOneReport,
  checkPresenceUnavailable,
  checkTodayOverdueHeading,
  findPresenceHelpers,
  HEADING_CONFIG,
  type HeadingRead,
  MAX_LINE_GAP_PX,
  QUIET_DOM_CONFIG,
  QUIET_TEXT,
  QUIET_TEXT_OWNERS,
  type QuietRead,
  withWindowHeight,
} from "./hardening-support.js";

/**
 * Plan 09-21 Task 1: the renderer reader of the quiet session rows, run the way wdio runs it
 * (compiled by esbuild with keepNames as tsx does, sent as text, defined in a clean context that
 * has no `__name`) against a synthetic DOM that mirrors what the plugin renders, the verdicts over
 * what it reads, the hook record builder, and the drift guard on the mirrored words.
 */

const RUN_ROOT = "/tmp/ccc-uat.abc123";

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

const SOURCE = readFileSync(
  join(REPO_ROOT, "packages/e2e/src/spec-support/hardening-support.ts"),
  "utf8",
);

/** The top-level declaration of `name`: its `function` line to the closing brace at column 0. */
function declarationOf(name: string): string {
  const start = SOURCE.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, "m"));
  if (start < 0) throw new Error(`no declaration of ${name}`);
  const end = SOURCE.indexOf("\n}\n", start);
  return SOURCE.slice(start, end + 2);
}

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

/** Runs a renderer function against `html` in a clean context, as wdio would, and returns its data. */
function runRenderer<T>(
  name: string,
  config: unknown,
  html: string,
  extra: Record<string, unknown> = {},
): T {
  const { JSDOM } = loadJsdom();
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
  const window = dom.window as Record<string, unknown> & {
    document: unknown;
    getComputedStyle: (n: unknown) => unknown;
  };
  const context = vm.createContext({
    document: window.document,
    window,
    getComputedStyle: window.getComputedStyle.bind(window),
    ...extra,
  });
  const text = rendererText(name);
  const out = vm.runInContext(`(${text}).apply(null, ${JSON.stringify([config])})`, context);
  return JSON.parse(JSON.stringify(out)) as T;
}

function readHtml(html: string): QuietRead {
  return runRenderer<QuietRead>("rendererReadQuiet", QUIET_DOM_CONFIG, html);
}

function agentRunsHtml(summary: string, rows: readonly { name: string; state: string }[]): string {
  const trs = rows
    .map(
      (row) =>
        `<tr><th scope="row"><button type="button" class="ccc-session-row-link ccc-clamp-2" title="${row.name}">${row.name}</button></th><td>${row.state}</td><td>Unclassified</td></tr>`,
    )
    .join("");
  return `<div class="ccc-agent-runs"><p class="ccc-state-body">${summary}</p><div class="ccc-agent-runs-layout"><section><h3>Active (${rows.length})</h3><table class="ccc-agent-runs-table"><thead><tr><th>Name</th><th>State</th></tr></thead><tbody>${trs}</tbody></table></section></div></div>`;
}

function cardHtml(
  numeral: string,
  caption: string,
  rows: readonly { primary: string; meta: string }[],
): string {
  const lis = rows
    .map(
      (row) =>
        `<li class="ccc-list-row"><span class="ccc-list-primary">${row.primary}</span><span class="ccc-list-meta">${row.meta}</span></li>`,
    )
    .join("");
  return `<section class="ccc-card" data-presentation="ready"><h3>Active Claude sessions</h3><div class="ccc-hero-head"><p class="ccc-kpi-number">${numeral}</p><span class="ccc-visually-hidden">${numeral} active sessions</span><p class="ccc-hero-caption">${caption}</p></div><div class="ccc-card-body"><ul>${lis}</ul></div></section>`;
}

const NAME = "Session 1a2b3c4d";

describe("rendererReadQuiet (Task 1)", () => {
  it("reads the Agent runs summary and each row's name and State cell", () => {
    const read = readHtml(
      agentRunsHtml("0 active · 1 quiet · 0 waiting for approval · 0 unknown", [
        { name: NAME, state: "⋯ Idle — last event less than a minute ago" },
      ]),
    );
    expect(read.agentRuns.mounted).toBe(true);
    expect(read.agentRuns.summary).toBe("0 active · 1 quiet · 0 waiting for approval · 0 unknown");
    expect(read.agentRuns.rows).toEqual([
      { name: NAME, state: "⋯ Idle — last event less than a minute ago" },
    ]);
    expect(read.card.found).toBe(false);
  });

  it("reads the card's numeral and caption without the screen-reader text, and its rows", () => {
    const read = readHtml(
      cardHtml("0", "0 waiting for approval · 1 quiet · 0 unknown", [
        {
          primary: `Unclassified · ${NAME}`,
          meta: "⋯ Idle — last event less than a minute ago · 1m",
        },
      ]),
    );
    expect(read.card.found).toBe(true);
    expect(read.card.numeral).toBe("0");
    expect(read.card.caption).toBe("0 waiting for approval · 1 quiet · 0 unknown");
    expect(read.card.rows).toHaveLength(1);
    expect(read.agentRuns.mounted).toBe(false);
  });

  it("finds nothing when neither view is on the page", () => {
    const read = readHtml("<p>nothing</p>");
    expect(read.agentRuns.mounted).toBe(false);
    expect(read.card.found).toBe(false);
  });
});

describe("the quiet verdicts (Task 1)", () => {
  const idleAgent = readHtml(
    agentRunsHtml("0 active · 1 quiet · 0 waiting for approval · 0 unknown", [
      { name: NAME, state: "⋯ Idle — last event less than a minute ago" },
    ]),
  );
  const idleCard = readHtml(
    cardHtml("0", "0 waiting for approval · 1 quiet · 0 unknown", [
      {
        primary: `Unclassified · ${NAME}`,
        meta: "⋯ Idle — last event less than a minute ago · 1m",
      },
    ]),
  );
  const runningAgent = readHtml(
    agentRunsHtml("1 active · 0 waiting for approval · 0 unknown", [
      { name: NAME, state: "▸ Running · Working" },
    ]),
  );
  const runningCard = readHtml(
    cardHtml("1", "0 waiting for approval · 0 unknown", [
      { primary: `Unclassified · ${NAME}`, meta: "▸ Running · 2m · active just now" },
    ]),
  );

  it("passes an idle session excluded from the numerals and named in the quiet segments", () => {
    expect(checkAgentRunsIdle(idleAgent, NAME)).toEqual([]);
    expect(checkCardIdle(idleCard, NAME)).toEqual([]);
  });

  it("passes a session that reads Running again after a new event", () => {
    expect(checkAgentRunsRunning(runningAgent, NAME)).toEqual([]);
    expect(checkCardRunning(runningCard, NAME)).toEqual([]);
  });

  it("fails a quiet session that is still counted as active", () => {
    const counted = readHtml(
      agentRunsHtml("1 active · 1 quiet · 0 waiting for approval · 0 unknown", [
        { name: NAME, state: "⋯ Idle — last event less than a minute ago" },
      ]),
    );
    expect(checkAgentRunsIdle(counted, NAME).join(" ")).toMatch(/counts 1 active but 0 rows/);
    const cardCounted = readHtml(
      cardHtml("1", "0 waiting for approval · 1 quiet · 0 unknown", [
        { primary: `Unclassified · ${NAME}`, meta: "⋯ Idle — last event less than a minute ago" },
      ]),
    );
    expect(checkCardIdle(cardCounted, NAME).join(" ")).toMatch(/numeral reads 1 but 0 rows/);
  });

  it("fails a card caption that does not name the quiet session", () => {
    const silent = readHtml(
      cardHtml("0", "0 waiting for approval · 0 unknown", [
        { primary: `Unclassified · ${NAME}`, meta: "⋯ Idle — last event less than a minute ago" },
      ]),
    );
    expect(checkCardIdle(silent, NAME).join(" ")).toMatch(/does not name 1 quiet/);
  });

  it("fails a session that still reads Running when it should be idle, and a missing one", () => {
    expect(checkAgentRunsIdle(runningAgent, NAME).join(" ")).toMatch(/not ⋯ Idle — last event/);
    expect(checkAgentRunsRunning(idleAgent, NAME).join(" ")).toMatch(/not ▸ Running/);
    expect(checkAgentRunsIdle(idleAgent, "Session ffffffff")).toEqual([
      "Session ffffffff is not listed in Agent runs",
    ]);
    expect(checkCardRunning(idleCard, "Session ffffffff")).toEqual([
      "Session ffffffff is not listed in the Active sessions card",
    ]);
  });

  it("passes the working session that went quiet as `No events for` and fails an idle one", () => {
    const silent = readHtml(
      agentRunsHtml("0 active · 1 quiet · 0 waiting for approval · 0 unknown", [
        { name: NAME, state: "⋯ No events for less than a minute" },
      ]),
    );
    expect(checkAgentRunsSilent(silent, NAME)).toEqual([]);
    expect(checkAgentRunsSilent(idleAgent, NAME).join(" ")).toMatch(/not ⋯ No events for/);
  });

  it("reports an unreadable summary and an unmounted view", () => {
    const odd = readHtml(agentRunsHtml("garbled", [{ name: NAME, state: "▸ Running" }]));
    expect(checkAgentRunsRunning(odd, NAME)).toEqual([
      "the Agent runs summary line is not readable",
    ]);
    expect(checkAgentRunsRunning(readHtml("<p>x</p>"), NAME)).toEqual([
      `${NAME} is not listed in Agent runs`,
    ]);
  });
});

describe("buildSessionEventRecord (Task 1)", () => {
  it("builds the three lifecycle events with the session id and folder only", () => {
    for (const event of ["Stop", "UserPromptSubmit", "PostToolUse"] as const) {
      const record = buildSessionEventRecord(
        event,
        "abcdef0123456789",
        `${RUN_ROOT}/tmp/s`,
        RUN_ROOT,
      );
      expect(record.hook_event_name).toBe(event);
      expect(record.session_id).toBe("abcdef0123456789");
      expect(Object.keys(record).sort()).toEqual(
        ["cwd", "hook_event_name", "model", "permission_mode", "session_id"].sort(),
      );
    }
  });

  it("refuses an unknown event, a bad id and a folder outside the run root", () => {
    expect(() =>
      buildSessionEventRecord("SessionEnd" as never, "abcdef0123456789", `${RUN_ROOT}/s`, RUN_ROOT),
    ).toThrow(/three/);
    expect(() => buildSessionEventRecord("Stop", "x y", `${RUN_ROOT}/s`, RUN_ROOT)).toThrow(
      /plain/,
    );
    expect(() =>
      buildSessionEventRecord("Stop", "abcdef0123456789", "/Users/USERNAME/s", RUN_ROOT),
    ).toThrow(/inside the run root/);
    expect(() =>
      buildSessionEventRecord("Stop", "abcdef0123456789", `${RUN_ROOT}/../s`, RUN_ROOT),
    ).toThrow(/inside the run root/);
    expect(() =>
      buildSessionEventRecord("Stop", "abcdef0123456789", `${RUN_ROOT}-sibling/s`, RUN_ROOT),
    ).toThrow(/inside the run root/);
  });
});

describe("the mirrored quiet words (Task 1)", () => {
  it("are still in the files that own them", () => {
    for (const owner of QUIET_TEXT_OWNERS) {
      const text = readFileSync(join(REPO_ROOT, owner.file), "utf8");
      expect(text, `${owner.text} in ${owner.file}`).toContain(owner.text);
    }
  });

  it("use the glyphs the domain defines", () => {
    expect(QUIET_TEXT.idlePrefix.startsWith(QUIET_TEXT.quietGlyph)).toBe(true);
    expect(QUIET_TEXT.silentPrefix.startsWith(QUIET_TEXT.quietGlyph)).toBe(true);
    expect(QUIET_TEXT.runningPrefix.startsWith(QUIET_TEXT.runningGlyph)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 2: the other seven items' readers

describe("rendererReadBundleGeometry and checkBundleLineInView (Task 2, item 3)", () => {
  const geo = (over: Partial<BundleGeometry> = {}): BundleGeometry => ({
    viewportHeight: 500,
    line: { text: "Bundle copied.", top: 300, bottom: 320 },
    buttons: [
      { label: "Copy bundle", top: 250, bottom: 282 },
      { label: "Save bundle", top: 250, bottom: 282 },
    ],
    ...over,
  });

  it("reads the line's text and the buttons' rectangles from the page", () => {
    // jsdom has no layout: every rectangle is zero, which still proves the structure is found.
    const html =
      '<div class="ccc-health-toolbar"><button>Copy bundle</button><button>Save bundle</button></div>' +
      '<p class="ccc-settings-status" data-status-region="bundle">Bundle copied.</p>';
    const read = runRenderer<BundleGeometry>(
      "rendererReadBundleGeometry",
      BUNDLE_GEOMETRY_CONFIG,
      html,
      {
        innerHeight: 500,
      },
    );
    expect(read.line?.text).toBe("Bundle copied.");
    expect(read.buttons.map((button) => button.label)).toEqual(["Copy bundle", "Save bundle"]);
    expect(read.viewportHeight).toBe(500);
  });

  it("reads no line when the bundle line is not on the page", () => {
    const read = runRenderer<BundleGeometry>(
      "rendererReadBundleGeometry",
      BUNDLE_GEOMETRY_CONFIG,
      '<div class="ccc-health-toolbar"><button>Copy bundle</button></div>',
      { innerHeight: 500 },
    );
    expect(read.line).toBeNull();
  });

  it("passes a line inside the viewport and next to its button", () => {
    expect(checkBundleLineInView(geo(), "Copy bundle")).toEqual([]);
  });

  it("fails a line above the viewport, below it, far from its button, empty, or a missing button", () => {
    expect(
      checkBundleLineInView(
        geo({ line: { text: "Bundle copied.", top: -400, bottom: -380 } }),
        "Copy bundle",
      ).join(" "),
    ).toMatch(/outside the viewport/);
    expect(
      checkBundleLineInView(
        geo({ line: { text: "Bundle copied.", top: 490, bottom: 520 } }),
        "Copy bundle",
      ).join(" "),
    ).toMatch(/outside the viewport/);
    const far = geo({
      viewportHeight: 900,
      line: { text: "Bundle copied.", top: 600, bottom: 620 },
    });
    expect(checkBundleLineInView(far, "Copy bundle").join(" ")).toMatch(
      new RegExp(`more than ${MAX_LINE_GAP_PX}`),
    );
    expect(
      checkBundleLineInView(geo({ line: { text: "", top: 300, bottom: 320 } }), "Copy bundle").join(
        " ",
      ),
    ).toMatch(/empty/);
    expect(checkBundleLineInView(geo({ line: null }), "Copy bundle")).toEqual([
      "the bundle status line is not on the page",
    ]);
    expect(checkBundleLineInView(geo({ buttons: [] }), "Copy bundle")).toEqual([
      "the Copy bundle button is not on the page",
    ]);
  });
});

describe("withWindowHeight (Task 2, item 3)", () => {
  interface FakeFacts {
    via: "electron" | "screen";
    bounds: { x: number; y: number; width: number; height: number } | null;
    maximized: boolean;
    outerWidth: number;
    outerHeight: number;
    screenX: number;
    screenY: number;
    innerHeight: number;
  }
  function fakeBrowser(options: { honours: boolean }) {
    const calls: string[] = [];
    const state: FakeFacts = {
      via: "electron",
      bounds: { x: 10, y: 20, width: 1200, height: 900 },
      maximized: false,
      outerWidth: 1200,
      outerHeight: 900,
      screenX: 10,
      screenY: 20,
      innerHeight: 860,
    };
    const fake = {
      calls,
      state,
      async execute(fn: { name: string }, ...args: unknown[]): Promise<unknown> {
        if (fn.name === "readWindowFacts") return { ...state };
        if (fn.name === "applyWindowBounds") {
          const bounds = args[0] as { height: number };
          calls.push(`bounds:${bounds.height}`);
          if (options.honours) state.innerHeight = bounds.height - 40;
          return true;
        }
        return undefined;
      },
      async setWindowRect(): Promise<unknown> {
        calls.push("setWindowRect");
        return undefined;
      },
      async pause(): Promise<void> {},
    };
    return fake;
  }

  it("shrinks the window, runs the body, and puts the window back", async () => {
    const fake = fakeBrowser({ honours: true });
    const seen: number[] = [];
    await withWindowHeight(fake as never, 600, async (inner) => {
      seen.push(inner);
    });
    expect(seen).toEqual([560]);
    expect(fake.calls).toEqual(["bounds:600", "bounds:900"]);
  });

  it("restores the window when the body throws", async () => {
    const fake = fakeBrowser({ honours: true });
    await expect(
      withWindowHeight(fake as never, 600, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(fake.calls).toEqual(["bounds:600", "bounds:900"]);
  });

  it("fails, naming the sizes, when the window never became short", async () => {
    const fake = fakeBrowser({ honours: false });
    await expect(
      withWindowHeight(fake as never, 600, async () => {}, { settleMs: 0 }),
    ).rejects.toThrow(/did not become short/);
    expect(fake.calls.at(-1)).toBe("bounds:900");
  });
});

describe("rendererReadBanner and checkBannerDisplayPath (Task 2, item 4)", () => {
  const html = (text: string, state = "disconnected") =>
    `<div class="ccc-connection-status" data-state="${state}"><span class="ccc-status-text">${text}</span></div>`;
  const read = (text: string, state?: string) =>
    runRenderer<BannerRead>("rendererReadBanner", BANNER_CONFIG, html(text, state));
  const forbidden = { homeDir: "/Users/USERNAME", runRoot: "/tmp/ccc-uat.abc123" };

  it("reads the state and the text", () => {
    expect(read("Disconnected — nothing at …/rt/svc.sock")).toEqual({
      present: true,
      state: "disconnected",
      text: "Disconnected — nothing at …/rt/svc.sock",
    });
    expect(runRenderer<BannerRead>("rendererReadBanner", BANNER_CONFIG, "<p>x</p>").present).toBe(
      false,
    );
  });

  it("passes a disconnected banner that shows a display path only", () => {
    expect(
      checkBannerDisplayPath(read("Disconnected — Could not connect to …/rt/svc.sock"), forbidden),
    ).toEqual([]);
  });

  it("fails an absolute path, the home folder, the run root, a missing display path and a live banner", () => {
    expect(
      checkBannerDisplayPath(
        read("Disconnected — connect ENOENT /Users/USERNAME/run/service.sock"),
        forbidden,
      ).join(" "),
    ).toMatch(/\/Users\//);
    expect(
      checkBannerDisplayPath(
        read("Disconnected — connect ENOENT /tmp/ccc-uat.abc123/rt/svc.sock"),
        forbidden,
      ).join(" "),
    ).toMatch(/run root/);
    expect(checkBannerDisplayPath(read("Disconnected — gone"), forbidden).join(" ")).toMatch(
      /display path/,
    );
    expect(checkBannerDisplayPath(read("Live", "live"), forbidden).join(" ")).toMatch(
      /not disconnected/,
    );
    expect(checkBannerDisplayPath({ present: false, state: null, text: "" }, forbidden)).toEqual([
      "the connection banner is not on the page",
    ]);
  });
});

describe("checkPresenceUnavailable (Task 2, item 5)", () => {
  const fact = (word: string, text: string, loading = false) => ({
    name: "Approval presence check",
    text,
    lines: [text],
    chips: loading ? [] : [{ status: "failing", word, glyph: "✕" }],
    stale: false,
    code: [],
    unknown: false,
    loading,
  });

  it("passes Unavailable with the sandbox reason", () => {
    expect(
      checkPresenceUnavailable([
        fact(
          "Unavailable",
          "Unavailable This is a test service, which never starts the presence helper.",
        ),
      ]),
    ).toEqual([]);
  });

  it("fails Available, Unknown, a missing fact, a loading one and a missing sandbox reason", () => {
    expect(checkPresenceUnavailable([fact("Available", "Available")]).join(" ")).toMatch(
      /reads "Available"/,
    );
    expect(checkPresenceUnavailable([fact("Unknown", "Unknown")]).join(" ")).toMatch(
      /reads "Unknown"/,
    );
    expect(checkPresenceUnavailable([]).join(" ")).toMatch(/missing/);
    expect(checkPresenceUnavailable([fact("", "", true)]).join(" ")).toMatch(/loading/);
    expect(
      checkPresenceUnavailable([fact("Unavailable", "Unavailable The check is unavailable.")]).join(
        " ",
      ),
    ).toMatch(/sandbox/);
  });
});

describe("the decided-through line (Task 2, item 6)", () => {
  it("passes The command center and fails another client, a presence proof, or no line", () => {
    expect(checkDecidedThrough({ "Decided through": "The command center" })).toEqual([]);
    expect(checkDecidedThrough({ "Decided through": "Another local client" }).join(" ")).toMatch(
      /Another local client/,
    );
    expect(
      checkDecidedThrough({
        "Decided through": "The command center, confirmed with your Touch ID or password",
      }).join(" "),
    ).toMatch(/confirmed/);
    expect(checkDecidedThrough({})).toEqual(["the request pane has no Decided through line"]);
  });
});

describe("findPresenceHelpers (Task 2, item 6)", () => {
  it("finds a helper binary anywhere under the run root and nothing else", () => {
    const root = mkdtempSync(join(tmpdir(), "ccc-hardening-"));
    try {
      mkdirSync(join(root, "rt", "bin"), { recursive: true });
      mkdirSync(join(root, "vaults", "live"), { recursive: true });
      writeFileSync(join(root, "rt", "svc.sock.note"), "x");
      expect(findPresenceHelpers(root)).toEqual([]);
      writeFileSync(join(root, "rt", "bin", "ccc-presence"), "x");
      expect(findPresenceHelpers(root)).toEqual([join(root, "rt", "bin", "ccc-presence")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the Launchers and Today headings (Task 2, item 7)", () => {
  const launchers = (text: string, transform: string) =>
    runRenderer<HeadingRead>(
      "rendererReadLaunchersHeading",
      HEADING_CONFIG,
      `<div class="ccc-settings-content"><h3 class="ccc-settings-section-title" style="text-transform:${transform}">${text}</h3></div>`,
    );

  it("reads the Launchers heading's text and its computed text transform", () => {
    expect(launchers("Launchers", "none")).toEqual({
      present: true,
      text: "Launchers",
      textTransform: "none",
    });
    expect(
      runRenderer<HeadingRead>("rendererReadLaunchersHeading", HEADING_CONFIG, "<p>x</p>").present,
    ).toBe(false);
  });

  it("passes Launchers shown as written and fails uppercase, a different word or no heading", () => {
    expect(checkLaunchersHeading(launchers("Launchers", "none"))).toEqual([]);
    expect(checkLaunchersHeading(launchers("Launchers", "uppercase")).join(" ")).toMatch(
      /uppercase/,
    );
    expect(checkLaunchersHeading(launchers("LAUNCHERS", "none")).join(" ")).toMatch(
      /reads "LAUNCHERS"/,
    );
    expect(checkLaunchersHeading({ present: false, text: "", textTransform: "" })).toEqual([
      "the Launchers heading is not on the page",
    ]);
  });

  it("passes the Today card whose focal heading is Due today and overdue", () => {
    const today = (heading: string) => [
      {
        title: "Today",
        sections: [
          { text: heading, focal: true },
          { text: "Automation", focal: false },
        ],
      },
    ];
    expect(checkTodayOverdueHeading(today("Due today and overdue"))).toEqual([]);
    expect(checkTodayOverdueHeading(today("Due today")).join(" ")).toMatch(/reads "Due today"/);
    expect(checkTodayOverdueHeading([]).join(" ")).toMatch(/no Today card/);
  });
});

describe("checkOneReport (Task 2, item 8)", () => {
  const row = (readable = true, sourceCount = 3) => ({ readable, sourceCount, title: "A report" });

  it("passes one readable report with its sources after a successful run", () => {
    expect(checkOneReport({ ok: true, rows: [row()] })).toEqual([]);
  });

  it("fails a failed run, no report, two reports, an unreadable one and one without sources", () => {
    expect(checkOneReport({ ok: false, rows: [row()] }).join(" ")).toMatch(/did not end well/);
    expect(checkOneReport({ ok: true, rows: [] }).join(" ")).toMatch(/0 readable/);
    expect(checkOneReport({ ok: true, rows: [row(), row()] }).join(" ")).toMatch(/2 readable/);
    expect(checkOneReport({ ok: true, rows: [row(false)] }).join(" ")).toMatch(/0 readable/);
    expect(checkOneReport({ ok: true, rows: [row(true, 0)] }).join(" ")).toMatch(/no sources/);
  });
});
