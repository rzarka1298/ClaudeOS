// The approvals cells of the visual harness (UI-SPEC "Visual regression and
// fixtures", plan 06-17 Task 3, Tests 7 and 8).
//
// Three things are proven without a browser:
//   1. the fixture file is valid against the domain schemas the service sends
//      and contains nothing but synthetic data (PRIV-04);
//   2. every case, width and motion mode the UI-SPEC names exists in the
//      harness entry;
//   3. every case actually RENDERS through the real components from
//      `@ccc/plugin`: the harness bundle is built in memory and run in jsdom,
//      and each case must reach its ready marker, show what it exists to show
//      and write nothing to the console's error channel.
//
// jsdom comes from the plugin package's own dependencies (this package has no
// DOM implementation of its own), resolved through that package's manifest.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ApprovalSummarySchema } from "@ccc/domain/approval.js";
import { ApprovalDetailResponseSchema } from "@ccc/domain/approval-view.js";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(HERE, "..");
const REPO_ROOT = resolve(PACKAGE_DIR, "..", "..");
const HARNESS_DIR = join(PACKAGE_DIR, "harness");
const FIXTURE_PATH = join(HARNESS_DIR, "approval-fixtures.json");
const MAIN_PATH = join(HARNESS_DIR, "main.tsx");

const fixtureText = readFileSync(FIXTURE_PATH, "utf8");
const fixtures = JSON.parse(fixtureText) as {
  readonly now: string;
  readonly ids: Readonly<Record<string, string>>;
  readonly inbox: Readonly<Record<"pending" | "decided" | "expired", readonly string[]>>;
  readonly alternateHash: string;
  readonly details: Readonly<Record<string, unknown>>;
};

/** The approvals cells the UI-SPEC table names, with the widths each is captured at. */
const CASES = [
  "approvals-pending-destructive",
  "approvals-pending-requester",
  "approvals-pending-test",
  "approvals-executing",
  "approvals-executed",
  "approvals-failed",
  "approvals-unknown",
  "approvals-expired",
  "approvals-hash-mismatch",
  "approvals-too-large",
  "approvals-empty",
  "approvals-loading",
  "approvals-error",
  "approvals-stale",
  "approvals-disconnected",
  "shell-nav-count",
] as const;

describe("Test 8: the approvals fixture file is valid and synthetic", () => {
  it("holds a detail for every id, each valid against the schema the service sends", () => {
    const detailIds = Object.keys(fixtures.details);
    expect(detailIds.length).toBeGreaterThanOrEqual(10);
    for (const [id, detail] of Object.entries(fixtures.details)) {
      const parsed = ApprovalDetailResponseSchema.safeParse(detail);
      expect(parsed.success, `${id}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
      expect(
        ApprovalSummarySchema.safeParse((detail as { summary: unknown }).summary).success,
      ).toBe(true);
    }
    for (const id of Object.values(fixtures.ids)) expect(detailIds).toContain(id);
    for (const list of Object.values(fixtures.inbox)) {
      for (const id of list) expect(detailIds).toContain(id);
    }
  });

  it("covers every state the UI-SPEC shows, with the inbox lists in the right buckets", () => {
    const stateOf = (id: string): string =>
      (fixtures.details[id] as { summary: { state: string } }).summary.state;
    expect(fixtures.inbox.pending.every((id) => stateOf(id) === "pending")).toBe(true);
    expect(fixtures.inbox.expired.every((id) => stateOf(id) === "expired")).toBe(true);
    const decided = new Set(fixtures.inbox.decided.map(stateOf));
    for (const state of ["executing", "executed", "failed", "unknown", "denied"]) {
      expect(decided.has(state), state).toBe(true);
    }
  });

  it("names only the synthetic projects, session, requesters and process", () => {
    expect(fixtureText).toContain("example-project");
    expect(fixtureText).toContain("sample-notes");
    expect(fixtureText).toContain("demo-api");
    expect(fixtureText).toContain("Refactor parser");
    expect(fixtureText).toContain("research-brief");
    expect(fixtureText).toContain("daily-news");
    expect(fixtureText).toContain("PID 4242");
  });

  it("contains no real name, address, token or home path", () => {
    expect(fixtureText).not.toMatch(/\/Users\/(?!USERNAME\b)[A-Za-z]/);
    expect(fixtureText).not.toMatch(/\/home\/[a-z]/);
    expect(fixtureText).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(fixtureText).not.toMatch(/\b(sk|ghp|gho|xox[bap])[-_][A-Za-z0-9]{10,}/);
    expect(fixtureText).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{10,}/);
    // Every URL points at the reserved example.invalid domain.
    for (const match of fixtureText.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) {
      expect(match[0]).toMatch(/^https?:\/\/example\.invalid(\/|$)/);
    }
    // The hostile fixture's literals and a service-written bidi token are present.
    expect(fixtureText).toContain("**bold**");
    expect(fixtureText).toContain("[link](https://example.invalid)");
    expect(fixtureText).toContain("<script>alert(1)</script>");
    expect(fixtureText).toContain("[U+202E]");
  });

  it("uses times relative to one frozen now", () => {
    expect(Number.isNaN(Date.parse(fixtures.now))).toBe(false);
  });
});

describe("the harness entry names every approvals cell, width and motion mode", () => {
  const main = readFileSync(MAIN_PATH, "utf8");

  it.each(CASES)("declares the %s case", (name) => {
    expect(main).toContain(`"${name}"`);
  });

  it("accepts width=full|narrow and motion=full|reduced, and imports the fixture file deliberately", () => {
    expect(main).toMatch(/APPROVAL_WIDTHS\s*=\s*\[\s*"full",\s*"narrow"\s*\]/);
    expect(main).toContain('motion !== "full" && motion !== "reduced"');
    expect(main).toMatch(/from\s+"\.\/approval-fixtures\.json"/);
  });
});

// ---------------------------------------------------------------------------
// Rendering through the real components

interface JsdomWindow {
  readonly document: Document;
  eval(code: string): unknown;
  close(): void;
  matchMedia?: unknown;
}

interface JsdomModule {
  readonly JSDOM: new (
    html: string,
    options: Record<string, unknown>,
  ) => { readonly window: JsdomWindow };
  readonly VirtualConsole: new () => {
    on(event: string, listener: (...args: unknown[]) => void): void;
  };
}

const requireFromPlugin = createRequire(join(REPO_ROOT, "packages", "plugin", "package.json"));
const jsdom = requireFromPlugin("jsdom") as JsdomModule;

let bundle = "";

beforeAll(async () => {
  const result = await build({
    absWorkingDir: PACKAGE_DIR,
    entryPoints: ["harness/main.tsx"],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    jsxImportSource: "preact",
    write: false,
    logLevel: "silent",
  });
  bundle = result.outputFiles[0]?.text ?? "";
}, 60_000);

interface Rendered {
  readonly document: Document;
  readonly errors: readonly string[];
  close(): void;
}

async function renderCase(query: string): Promise<Rendered> {
  const errors: string[] = [];
  const virtualConsole = new jsdom.VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(String((error as Error).message)));
  virtualConsole.on("error", (...args) => errors.push(args.map(String).join(" ")));
  const dom = new jsdom.JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: `file:///harness/index.html?${query}`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole,
  });
  // Runs the harness bundle this test just built from the repository's own
  // source, inside a jsdom window: no network, no host access, no outside code.
  dom.window.eval(bundle);
  const document = dom.window.document;
  const deadline = Date.now() + 8000;
  while (document.documentElement.getAttribute("data-harness-ready") !== "true") {
    if (Date.now() > deadline) throw new Error(`The case never became ready: ${query}`);
    await new Promise((done) => setTimeout(done, 10));
  }
  // Let the last effects and re-renders settle.
  await new Promise((done) => setTimeout(done, 30));
  return { document, errors, close: () => dom.window.close() };
}

function text(document: Document): string {
  return document.body.textContent ?? "";
}

interface Expectation {
  readonly name: string;
  readonly check: (document: Document) => void;
}

const EXPECTATIONS: readonly Expectation[] = [
  {
    name: "approvals-pending-destructive",
    check: (doc) => {
      expect(doc.querySelector("h4")?.textContent).toBe("Force-terminate Refactor parser");
      expect(doc.activeElement?.getAttribute("data-decision")).toBe("deny");
      expect(
        doc.querySelector('[data-block="change"] .ccc-approval-diff, [data-block="change"]'),
      ).not.toBeNull();
      expect(text(doc)).toContain("This will force-terminate Refactor parser.");
    },
  },
  {
    name: "approvals-pending-requester",
    check: (doc) => {
      expect(doc.querySelector('[data-origin="requester"]')).not.toBeNull();
      expect(text(doc)).toContain("Provided by Skill: System");
      expect(text(doc)).toContain("Text shortened for display.");
      expect(doc.querySelector(".ccc-control-token")?.textContent).toContain("[U+202E]");
      expect(doc.querySelector("script")).toBeNull();
    },
  },
  {
    name: "approvals-pending-test",
    check: (doc) => {
      expect(doc.querySelector("h4")?.textContent).toBe("Test approval");
      expect(doc.querySelector('[data-role="effect"]')).toBeNull();
    },
  },
  {
    name: "approvals-executing",
    check: (doc) => {
      expect(text(doc)).toContain("Carrying out");
      expect(doc.querySelector(".ccc-approval-detail [data-decision]")).toBeNull();
    },
  },
  {
    name: "approvals-executed",
    check: (doc) => {
      expect(doc.querySelector(".ccc-filter-chip[aria-pressed='true']")?.textContent).toMatch(
        /^Decided/,
      );
      expect(text(doc)).toContain("Carried out");
      expect(doc.querySelector(".ccc-approval-history")).not.toBeNull();
    },
  },
  {
    name: "approvals-failed",
    check: (doc) => {
      expect(text(doc)).toContain("the session's process had already ended");
    },
  },
  {
    name: "approvals-unknown",
    check: (doc) => {
      expect(text(doc)).toContain("Outcome unknown");
      expect(text(doc)).toContain("Nothing is retried automatically.");
    },
  },
  {
    name: "approvals-expired",
    check: (doc) => {
      expect(doc.querySelector(".ccc-filter-chip[aria-pressed='true']")?.textContent).toMatch(
        /^Expired/,
      );
      expect(text(doc)).toContain("Expired — denied automatically");
    },
  },
  {
    name: "approvals-hash-mismatch",
    check: (doc) => {
      expect(text(doc)).toContain("The details changed since you first opened this request.");
    },
  },
  {
    name: "approvals-too-large",
    check: (doc) => {
      expect(text(doc)).toContain("This change is too large to review here.");
      expect(doc.querySelector('[data-decision="approve"]')?.getAttribute("aria-disabled")).toBe(
        "true",
      );
      expect(doc.querySelector('[data-decision="deny"]')?.getAttribute("aria-disabled")).toBeNull();
    },
  },
  {
    name: "approvals-empty",
    check: (doc) => {
      expect(text(doc)).toContain("Nothing needs your decision right now.");
    },
  },
  {
    name: "approvals-loading",
    check: (doc) => {
      expect(doc.querySelector(".ccc-approvals")?.getAttribute("aria-busy")).toBe("true");
      expect(doc.querySelectorAll(".ccc-approvals-loading .ccc-skeleton-line").length).toBe(3);
    },
  },
  {
    name: "approvals-error",
    check: (doc) => {
      expect(text(doc)).toContain("Couldn't load approval requests.");
    },
  },
  {
    name: "approvals-stale",
    check: (doc) => {
      expect(text(doc)).toContain("Refresh approvals");
      expect(doc.querySelector(".ccc-badge[data-badge='stale']")).not.toBeNull();
      expect(text(doc)).toContain("This list may be out of date. Refresh, then decide.");
    },
  },
  {
    name: "approvals-disconnected",
    check: (doc) => {
      expect(text(doc)).toContain(
        "Pending requests are kept safely and appear again when the service is back.",
      );
      expect(doc.querySelector('[data-decision="deny"]')?.getAttribute("aria-disabled")).toBe(
        "true",
      );
    },
  },
  {
    name: "shell-nav-count",
    check: (doc) => {
      const chip = doc.querySelector("#ccc-tab-agent-runs .ccc-nav-count");
      expect(chip?.textContent).toBe("5");
      expect(chip?.getAttribute("aria-hidden")).toBe("true");
      expect(doc.querySelector("#ccc-tab-agent-runs")?.textContent).toContain(
        "5 approval requests need your decision",
      );
    },
  },
];

describe("Test 7: every approvals case renders through the real components with no console error", () => {
  it("covers every case the UI-SPEC names", () => {
    expect(EXPECTATIONS.map((entry) => entry.name).sort()).toEqual([...CASES].sort());
  });

  it.each(EXPECTATIONS)(
    "renders $name at full width and ready",
    async ({ name, check }) => {
      const rendered = await renderCase(`view=agent-runs&case=${name}&width=full&motion=full`);
      try {
        expect(rendered.errors).toEqual([]);
        expect(rendered.document.querySelector(".ccc-command-center")).not.toBeNull();
        check(rendered.document);
      } finally {
        rendered.close();
      }
    },
    20_000,
  );

  it("renders the narrow cells inside a constrained destination, still without errors", async () => {
    for (const name of [
      "approvals-pending-destructive",
      "approvals-pending-requester",
      "approvals-expired",
      "shell-nav-count",
    ]) {
      const rendered = await renderCase(`view=agent-runs&case=${name}&width=narrow&motion=full`);
      try {
        expect(rendered.errors, name).toEqual([]);
        expect(
          rendered.document.querySelector('[data-harness-width="narrow"]'),
          name,
        ).not.toBeNull();
      } finally {
        rendered.close();
      }
    }
  }, 40_000);

  it("renders the destructive case under reduced motion with the reduced-motion hook set", async () => {
    const rendered = await renderCase(
      "view=agent-runs&case=approvals-pending-destructive&width=full&motion=reduced",
    );
    try {
      expect(rendered.errors).toEqual([]);
      expect(
        rendered.document.querySelector('.ccc-command-center[data-motion="reduced"]'),
      ).not.toBeNull();
      expect(rendered.document.activeElement?.getAttribute("data-decision")).toBe("deny");
    } finally {
      rendered.close();
    }
  }, 20_000);

  it("refuses an unknown width or case loudly instead of rendering a blank cell", async () => {
    const width = await renderCaseRaw("view=agent-runs&case=approvals-empty&width=huge");
    expect(width).toContain('Unknown width "huge"');
    const unknown = await renderCaseRaw("view=agent-runs&case=approvals-nope");
    expect(unknown).toContain("Unknown agent-runs case");
  });
});

/** Renders a query that is expected to stop at the harness error line, and returns the page text. */
async function renderCaseRaw(query: string): Promise<string> {
  const virtualConsole = new jsdom.VirtualConsole();
  const dom = new jsdom.JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: `file:///harness/index.html?${query}`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole,
  });
  // Same bundle, same sandbox as above.
  dom.window.eval(bundle);
  await new Promise((done) => setTimeout(done, 30));
  const content = dom.window.document.body.textContent ?? "";
  dom.window.close();
  return content;
}
