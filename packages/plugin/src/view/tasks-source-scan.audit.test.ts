import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Source scan for the Tasks list view files (UI-SPEC accessibility floor 12,
 * Non-Negotiables 3, 5 and 10; TASK-08, T-06-13, T-06-24, T-06-25): the files
 * offer no standing choice of any kind, never use the word the approval inbox
 * keeps for its own item, never use the Run state's phrase, never scroll
 * smoothly, build no markup from data, set no style, link or native disabled,
 * and import nothing that could carry out an action. The scan reads comments
 * too, so a prohibition is described without using the words it prohibits.
 *
 * It lists the files by name. A new Tasks view file must be added here, so the
 * scan cannot silently stop covering one.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FILES = [
  "tasks-copy.ts",
  "tasks-format.ts",
  "task-chips.tsx",
  "task-list.tsx",
  "tasks-forms-copy.ts",
  "task-form.tsx",
  "task-detail.tsx",
  "attention-list.tsx",
] as const;
/** The containers (06-22): they read signals and the API and port holders, so their import rule differs. */
const CONTAINER_FILES = [
  "tasks.tsx",
  "tasks-workspace.tsx",
  "tasks-view-state.ts",
  "tasks-detail-model.ts",
  "project-tasks.tsx",
] as const;
const COMPONENT_SOURCES = FILES.map(
  (file) => [file, readFileSync(join(HERE, file), "utf8")] as const,
);
const CONTAINER_SOURCES = CONTAINER_FILES.map(
  (file) => [file, readFileSync(join(HERE, file), "utf8")] as const,
);
const SOURCES = [...COMPONENT_SOURCES, ...CONTAINER_SOURCES];

/** What a container may import: the domain, preact, signals, its siblings and the plugin's own holders. */
const ALLOWED_CONTAINER_IMPORT =
  /^(@ccc\/domain\/[\w./-]+|preact(\/hooks)?|@preact\/signals|\.\/[\w-]+\.js|\.\.\/connection-state\.js|\.\.\/projects\/projects-state\.js|\.\.\/tasks\/(api|contexts|events|rebuild|actions-port|actions|task-update)\.js|\.\.\/widgets\/(footer|presentation)\.js)$/;

/** The DOM HTML-injection sinks, assembled so this file names none of them (backstop rule 6). */
const MARKUP = "HTML";
const HTML_SINKS = new RegExp(
  [
    `dangerouslySetInner${MARKUP}`,
    `inner${MARKUP}`,
    `outer${MARKUP}`,
    `insertAdjacent${MARKUP}`,
  ].join("|"),
);

/** The standing-choice wording family: every phrase that offers to skip asking next time. */
const STANDING_CHOICE: readonly RegExp[] = [
  /always[\s_-]*(allow|approve|permit|accept)/i,
  /\bremember(s|ed|ing)?\b/i,
  /don'?t\s+ask\s+again/i,
  /\bstop\s+asking\b/i,
  /\bnever\s+ask\b/i,
  /for\s+this\s+session/i,
  /\bpermanent(ly)?\b/i,
  /\bstanding\s+(approval|permission|choice)\b/i,
];

/** The only modules a list or chip file may import: the domain, preact and its own siblings. */
const ALLOWED_IMPORT =
  /^(@ccc\/domain\/[\w./-]+|preact(\/hooks)?|\.\/tasks-copy\.js|\.\/tasks-format\.js|\.\/task-(chips|list|form|detail)\.js|\.\/attention-list\.js|\.\/tasks-forms-copy\.js|\.\.\/widgets\/toolbar-keys\.js)$/;

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gms)].map(
    (match) => match[1] as string,
  );
}

describe("the Tasks list view files (UI-SPEC floor 12, T-06-13)", () => {
  it.each(SOURCES)("%s offers no standing choice of any kind", (file, source) => {
    for (const pattern of STANDING_CHOICE) {
      expect(source.match(pattern)?.[0], `${file} matches ${pattern}`).toBeUndefined();
    }
  });

  it.each(SOURCES)("%s never says Proposal", (file, source) => {
    expect(source.match(/\bproposals?\b/i)?.[0], file).toBeUndefined();
  });

  it.each(SOURCES)("%s never uses the Run state's phrase", (file, source) => {
    expect(source.match(/waiting\s+for\s+approval/i)?.[0], file).toBeUndefined();
  });

  it.each(SOURCES)("%s never scrolls smoothly", (file, source) => {
    expect(source, file).not.toMatch(/behavior\s*:\s*["']smooth["']/);
    expect(source, file).not.toMatch(/scroll-behavior/);
  });

  it("states the closed set of files it checks is non-empty, so a rename cannot hollow the scan out", () => {
    expect(SOURCES.every(([, source]) => source.length > 200)).toBe(true);
    expect(SOURCES).toHaveLength(FILES.length + CONTAINER_FILES.length);
  });
});

describe("the Tasks list view files stay props-driven and inert (TASK-08, T-06-24, T-06-25)", () => {
  it.each(COMPONENT_SOURCES)(
    "%s imports only the domain, preact and its own siblings",
    (file, source) => {
      const specifiers = importSpecifiers(source);
      for (const specifier of specifiers) {
        expect(specifier, `${file} imports ${specifier}`).toMatch(ALLOWED_IMPORT);
      }
    },
  );

  it.each(CONTAINER_SOURCES)("%s imports only the holders it is allowed", (file, source) => {
    for (const specifier of importSpecifiers(source)) {
      expect(specifier, `${file} imports ${specifier}`).toMatch(ALLOWED_CONTAINER_IMPORT);
    }
  });

  it.each(COMPONENT_SOURCES)(
    "%s imports no service client, connector, executor, signal or obsidian",
    (file, source) => {
      for (const specifier of importSpecifiers(source)) {
        expect(specifier, file).not.toMatch(
          /obsidian|service-api-client|connector|executor|signals|approvals\/|tasks\/|projects\//i,
        );
      }
    },
  );

  it.each(SOURCES)("%s reads no ambient clock", (file, source) => {
    expect(source, file).not.toMatch(/Date\.now\s*\(/);
    expect(source, file).not.toMatch(/new\s+Date\s*\(\s*\)/);
    expect(source, file).not.toMatch(/performance\.now/);
  });

  it.each(SOURCES)(
    "%s builds no markup from data and sets no style, link, autofocus or native disabled",
    (file, source) => {
      expect(source, file).not.toMatch(HTML_SINKS);
      expect(source, file).not.toMatch(/\bstyle\s*=/);
      expect(source, file).not.toMatch(/\.style\b/);
      expect(source, file).not.toMatch(/\bhref\s*=/);
      expect(source, file).not.toMatch(/\bautoFocus\b|\bautofocus\b/);
      expect(source, file).not.toMatch(/(^|[^-\w])disabled\s*=/);
    },
  );

  it.each(CONTAINER_SOURCES)(
    "%s imports the note writer and updater as types only",
    (file, source) => {
      const value = [
        ...source.matchAll(
          /^\s*import\s+(?!type\b)[^;]*?\bfrom\s+["']\.\.\/tasks\/(actions|task-update)\.js["']/gms,
        ),
      ];
      expect(value, file).toHaveLength(0);
    },
  );

  it("lets a row action call only the injected function for that row", () => {
    const list = COMPONENT_SOURCES.find(([file]) => file === "task-list.tsx")?.[1] ?? "";
    const calls = [...list.matchAll(/props\.(on[A-Z]\w*)\??\.?\(/g)].map((match) => match[1]);
    expect(new Set(calls)).toEqual(new Set(["onAction", "onLoadMore", "onCreate", "onSelect"]));
    expect(list).toMatch(/props\.onAction\(action, row\)/);
  });
});
