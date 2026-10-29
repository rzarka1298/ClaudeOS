import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../repo-paths.js";
import {
  buildSessionEventRecord,
  checkAgentRunsIdle,
  checkAgentRunsRunning,
  checkAgentRunsSilent,
  checkCardIdle,
  checkCardRunning,
  QUIET_DOM_CONFIG,
  QUIET_TEXT,
  QUIET_TEXT_OWNERS,
  type QuietRead,
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

function readHtml(html: string): QuietRead {
  const { JSDOM } = loadJsdom();
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
  const window = dom.window as Record<string, unknown> & { document: unknown };
  const context = vm.createContext({ document: window.document, window });
  const text = rendererText("rendererReadQuiet");
  const out = vm.runInContext(
    `(${text}).apply(null, ${JSON.stringify([QUIET_DOM_CONFIG])})`,
    context,
  );
  return JSON.parse(JSON.stringify(out)) as QuietRead;
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
