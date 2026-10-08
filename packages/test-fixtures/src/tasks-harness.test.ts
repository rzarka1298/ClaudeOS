// The Tasks cells of the visual harness (UI-SPEC "Visual regression and
// fixtures", plan 06-22 Task 3, Tests 8 and 9).
//
// Proven without a browser: the fixture file is valid against the domain
// schemas and purely synthetic (PRIV-04); every case the UI-SPEC names exists
// in the harness entry; and each case RENDERS through the real components from
// `@ccc/plugin`, reaches its ready marker, shows what it exists to show and
// writes nothing to the console's error channel. Same jsdom approach as
// `approvals-harness.test.ts`.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TaskAttentionResponseSchema,
  TaskCountsResponseSchema,
  TaskDetailSchema,
  TaskRowSchema,
} from "@ccc/domain/tasks.js";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(HERE, "..");
const REPO_ROOT = resolve(PACKAGE_DIR, "..", "..");
const HARNESS_DIR = join(PACKAGE_DIR, "harness");
const fixtureText = readFileSync(join(HARNESS_DIR, "task-fixtures.json"), "utf8");
const fixtures = JSON.parse(fixtureText) as {
  readonly now: string;
  readonly rows: Readonly<Record<string, unknown>>;
  readonly counts: unknown;
  readonly zeroCounts: unknown;
  readonly details: Readonly<Record<string, unknown>>;
  readonly attention: unknown;
  readonly notes: Readonly<Record<string, string>>;
  readonly lists: Readonly<Record<string, readonly string[]>>;
};

const TASKS_CASES = [
  "tasks-today",
  "tasks-overdue-blocked",
  "tasks-proposed",
  "tasks-create-form",
  "tasks-create-form-error",
  "tasks-create-form-busy",
  "tasks-create-form-disconnected",
  "tasks-detail-clean",
  "tasks-detail-dirty",
  "tasks-detail-confirm",
  "tasks-detail-conflict",
  "tasks-detail-blocked",
  "tasks-detail-suggested",
  "tasks-detail-hostile",
  "tasks-attention",
  "tasks-empty",
  "tasks-none",
  "tasks-loading",
  "tasks-stale",
  "tasks-error",
  "tasks-disconnected",
] as const;

describe("Test 9: the tasks fixture file is valid and synthetic", () => {
  it("carries one attention title long enough to need the two-line clamp (schema maximum)", () => {
    const items = (fixtures.attention as { items: { title?: string }[] }).items;
    const longest = Math.max(...items.map((item) => item.title?.length ?? 0));
    expect(longest).toBeGreaterThanOrEqual(190);
    expect(longest).toBeLessThanOrEqual(200);
  });

  it("holds rows, counts, details and attention entries valid against the schemas the service sends", () => {
    for (const [key, row] of Object.entries(fixtures.rows)) {
      const parsed = TaskRowSchema.safeParse(row);
      expect(parsed.success, `${key}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
    }
    expect(TaskCountsResponseSchema.safeParse(fixtures.counts).success).toBe(true);
    expect(TaskCountsResponseSchema.safeParse(fixtures.zeroCounts).success).toBe(true);
    for (const [id, detail] of Object.entries(fixtures.details)) {
      const parsed = TaskDetailSchema.safeParse(detail);
      expect(parsed.success, `${id}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
    }
    expect(TaskAttentionResponseSchema.safeParse(fixtures.attention).success).toBe(true);
    for (const detail of Object.values(fixtures.details)) {
      expect(fixtures.notes).toHaveProperty((detail as { path: string }).path);
    }
  });

  it("names only the synthetic projects and workspace, and uses one frozen now", () => {
    for (const name of ["example-project", "sample-notes", "demo-api", "Example workspace"]) {
      expect(fixtureText).toContain(name);
    }
    expect(Number.isNaN(Date.parse(fixtures.now))).toBe(false);
  });

  it("contains no real name, address, token or home path", () => {
    expect(fixtureText).not.toMatch(/\/Users\/(?!USERNAME\b)[A-Za-z]/);
    expect(fixtureText).not.toMatch(/\/home\/[a-z]/);
    expect(fixtureText).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(fixtureText).not.toMatch(/\b(sk|ghp|gho|xox[bap])[-_][A-Za-z0-9]{10,}/);
    for (const match of fixtureText.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) {
      expect(match[0]).toMatch(/^https?:\/\/example\.invalid(\/|$)/);
    }
    expect(fixtureText).toContain("<script>alert(1)</script>");
    expect(fixtureText).toContain("\\u202e");
  });
});

describe("the harness entry names every tasks cell, width and motion mode", () => {
  const main = readFileSync(join(HARNESS_DIR, "main.tsx"), "utf8");

  it.each([...TASKS_CASES, "project-tasks"])("declares the %s case", (name) => {
    expect(main).toContain(`"${name}"`);
  });

  it("accepts width=full|narrow and imports the fixture file deliberately", () => {
    expect(main).toMatch(/TASK_WIDTHS\s*=\s*\[\s*"full",\s*"narrow"\s*\]/);
    expect(main).toMatch(/from\s+"\.\/task-fixtures\.json"/);
  });
});

interface JsdomWindow {
  readonly document: Document;
  eval(code: string): unknown;
  close(): void;
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
  // source inside a jsdom window: no network, no host access, no outside code.
  dom.window.eval(bundle);
  const document = dom.window.document;
  const deadline = Date.now() + 12_000;
  while (document.documentElement.getAttribute("data-harness-ready") !== "true") {
    if (Date.now() > deadline) throw new Error(`The case never became ready: ${query}`);
    await new Promise((done) => setTimeout(done, 10));
  }
  await new Promise((done) => setTimeout(done, 30));
  return { document, errors, close: () => dom.window.close() };
}

const text = (document: Document): string => document.body.textContent ?? "";

const EXPECTATIONS: Readonly<Record<string, (doc: Document) => void>> = {
  "tasks-today": (doc) => {
    expect(text(doc)).toContain("Draft the weekly review");
    expect(text(doc)).toContain("5 open · 2 overdue · 2 proposed");
    expect(doc.querySelector('[role="toolbar"] [aria-pressed="true"]')?.textContent).toMatch(
      /^Today/,
    );
    // UI-SPEC "Tasks cells": Today shows a selected ready task in the pane.
    expect(doc.querySelector(".ccc-tasks-pane .ccc-task-detail h3")?.textContent).toBe(
      "Draft the weekly review",
    );
  },
  "tasks-overdue-blocked": (doc) => {
    expect(text(doc)).toContain("Blocked — waiting on 2 unfinished tasks");
  },
  "tasks-proposed": (doc) => {
    expect(doc.querySelectorAll("[data-action='accept']").length).toBe(2);
  },
  "tasks-create-form": (doc) => {
    expect(doc.activeElement?.tagName).toBe("INPUT");
  },
  "tasks-create-form-error": (doc) => {
    expect(text(doc)).toContain("Enter a title.");
  },
  "tasks-create-form-busy": (doc) => {
    expect(text(doc)).toContain("Adding the task…");
  },
  "tasks-create-form-disconnected": (doc) => {
    expect(text(doc)).toContain("Service disconnected");
  },
  "tasks-detail-clean": (doc) => {
    expect(doc.querySelector(".ccc-tasks-pane h3")?.textContent).toBe("Draft the weekly review");
  },
  "tasks-detail-dirty": (doc) => {
    expect(text(doc)).toContain("Unsaved changes");
  },
  "tasks-detail-confirm": (doc) => {
    expect(doc.querySelector(".ccc-task-confirm")).not.toBeNull();
  },
  "tasks-detail-conflict": (doc) => {
    expect(text(doc)).toContain("changed in its note while you were editing");
  },
  "tasks-detail-blocked": (doc) => {
    expect(text(doc)).toContain("Finish the changelog");
  },
  "tasks-detail-suggested": (doc) => {
    expect(text(doc)).toContain("Provided by");
    expect(doc.querySelector('[data-origin="requester"]')).not.toBeNull();
  },
  "tasks-detail-hostile": (doc) => {
    expect(doc.querySelector("script")).toBeNull();
    expect(doc.querySelector(".ccc-tasks-pane a")).toBeNull();
  },
  "tasks-attention": (doc) => {
    expect(text(doc)).toContain("Missing its ID");
    expect(doc.querySelector('[data-badge="partial"]')).not.toBeNull();
  },
  "tasks-empty": (doc) => {
    expect(text(doc)).not.toContain("Draft the weekly review");
  },
  "tasks-none": (doc) => {
    expect(text(doc)).toContain("Nothing here yet");
  },
  "tasks-loading": (doc) => {
    expect(text(doc)).toContain("Loading tasks");
  },
  "tasks-stale": (doc) => {
    expect(text(doc)).toContain("Rebuilding the task index…");
  },
  "tasks-error": (doc) => {
    expect(text(doc)).toContain("Couldn't load tasks.");
  },
  "tasks-disconnected": (doc) => {
    expect(text(doc)).toContain("Service disconnected");
    expect(doc.querySelector('[data-dimmed="true"]')).not.toBeNull();
  },
};

describe("every tasks case renders through the real components", () => {
  it.each(TASKS_CASES)(
    "renders %s at full and narrow width without console errors",
    async (name) => {
      for (const width of ["full", "narrow"]) {
        const rendered = await renderCase(`view=tasks&case=${name}&width=${width}&motion=full`);
        try {
          expect(rendered.errors).toEqual([]);
          expect(rendered.document.querySelector(".ccc-tasks")).not.toBeNull();
          EXPECTATIONS[name]?.(rendered.document);
        } finally {
          rendered.close();
        }
      }
    },
    40_000,
  );

  it("renders the project tasks panel, its chips and no Scope select, under reduced motion too", async () => {
    for (const motion of ["full", "reduced"]) {
      const rendered = await renderCase(
        `view=projects&case=project-tasks&width=full&motion=${motion}`,
      );
      try {
        expect(rendered.errors).toEqual([]);
        const panel = rendered.document.querySelector(".ccc-project-tasks");
        expect(panel).not.toBeNull();
        expect(panel?.querySelectorAll('[role="toolbar"] button')).toHaveLength(7);
        expect(panel?.querySelector("select")).toBeNull();
        expect(panel?.querySelector("h3")?.textContent).toBe("Tasks · example-project");
        // The panel is narrowed to its own project: its rows and chip counts differ from the global view's.
        expect(panel?.textContent).toContain("Draft the weekly review");
        expect(panel?.textContent).not.toContain("Archive the old sample notes");
        expect(panel?.textContent).toContain("All (1)");
      } finally {
        rendered.close();
      }
    }
  }, 40_000);

  it("renders tasks-today under reduced motion", async () => {
    const rendered = await renderCase("view=tasks&case=tasks-today&width=full&motion=reduced");
    try {
      expect(rendered.errors).toEqual([]);
      expect(rendered.document.querySelector(".ccc-task-row")).not.toBeNull();
    } finally {
      rendered.close();
    }
  });
});
