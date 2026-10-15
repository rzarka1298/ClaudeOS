import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Source scan for the Research destination files (plan 07-11; UI-SPEC
 * Non-Negotiables 2, 3, 5, 6, 7; accessibility floors 6, 7 and 11; T-07-38):
 * no source-derived or model-derived string reaches the Markdown renderer, an
 * HTML-injection sink, an address, an image, an inline style or a class; no
 * control uses the native disabled attribute; nothing scrolls smoothly; and the
 * view files import neither the Obsidian API, the service client nor a
 * connector. The scan reads comments too, so a prohibition is described without
 * using the words it prohibits.
 *
 * It lists the files by name. A new Research view file must be added here, so
 * the scan cannot silently stop covering one.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RESEARCH_DIR = join(HERE, "..", "research");

/** Presentational files: the domain, preact and their own siblings only. */
const COMPONENT_FILES = [
  "research-copy.ts",
  "research-format.ts",
  "research-status.tsx",
  "report-list.tsx",
] as const;
/** The container and the state: they also read the research holders and signals. */
const CONTAINER_FILES = ["research.tsx"] as const;
const STATE_FILES = [join(RESEARCH_DIR, "api.ts"), join(RESEARCH_DIR, "state.ts")] as const;

const COMPONENT_SOURCES = COMPONENT_FILES.map(
  (file) => [file, readFileSync(join(HERE, file), "utf8")] as const,
);
const CONTAINER_SOURCES = CONTAINER_FILES.map(
  (file) => [file, readFileSync(join(HERE, file), "utf8")] as const,
);
const STATE_SOURCES = STATE_FILES.map((file) => [file, readFileSync(file, "utf8")] as const);
const SOURCES = [...COMPONENT_SOURCES, ...CONTAINER_SOURCES, ...STATE_SOURCES];

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

/** The Markdown renderer, assembled so this file names it only here. */
const RENDERER = new RegExp(["Markdown", "Renderer"].join(""));

const ALLOWED_COMPONENT_IMPORT =
  /^(@ccc\/domain\/[\w./-]+|preact(\/hooks)?|\.\/[\w-]+\.js|\.\.\/widgets\/(footer|presentation|relative-time)\.js)$/;
const ALLOWED_CONTAINER_IMPORT =
  /^(@ccc\/domain\/[\w./-]+|preact(\/hooks)?|\.\/[\w-]+\.js|\.\.\/connection-state\.js|\.\.\/research\/(api|state)\.js|\.\.\/widgets\/(footer|presentation|relative-time)\.js)$/;
const ALLOWED_STATE_IMPORT =
  /^(@ccc\/domain\/[\w./-]+|@preact\/signals|\.\/api\.js|\.\.\/view\/research-copy\.js)$/;

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gms)].map(
    (match) => match[1] as string,
  );
}

describe("the Research files render untrusted text safely (T-07-38)", () => {
  it("covers a non-empty closed set of files", () => {
    expect(SOURCES.every(([, source]) => source.length > 200)).toBe(true);
    expect(SOURCES).toHaveLength(
      COMPONENT_FILES.length + CONTAINER_FILES.length + STATE_FILES.length,
    );
  });

  it.each(SOURCES)("%s builds no markup from data and names no renderer", (file, source) => {
    expect(source, file).not.toMatch(HTML_SINKS);
    expect(source, file).not.toMatch(RENDERER);
  });

  it.each(SOURCES)("%s sets no style, address, image, frame or autofocus", (file, source) => {
    expect(source, file).not.toMatch(/\bstyle\s*=/);
    expect(source, file).not.toMatch(/\.style\b/);
    expect(source, file).not.toMatch(/\bhref\s*=/);
    expect(source, file).not.toMatch(/<a[\s>]/);
    expect(source, file).not.toMatch(/<img[\s>]/);
    expect(source, file).not.toMatch(/<iframe[\s>]/);
    expect(source, file).not.toMatch(/<script[\s>]/);
    expect(source, file).not.toMatch(/\bautoFocus\b|\bautofocus\b/);
  });

  it.each(SOURCES)("%s never uses the native disabled attribute", (file, source) => {
    expect(source, file).not.toMatch(/(^|[^-\w])disabled\s*=/);
  });

  it.each(SOURCES)("%s never scrolls smoothly and reads no ambient clock", (file, source) => {
    expect(source, file).not.toMatch(/behavior\s*:\s*["']smooth["']/);
    expect(source, file).not.toMatch(/scroll-behavior/);
    expect(source, file).not.toMatch(/Date\.now\s*\(/);
    expect(source, file).not.toMatch(/new\s+Date\s*\(\s*\)/);
    expect(source, file).not.toMatch(/performance\.now/);
  });

  it.each(SOURCES)("%s derives no class or id from data", (file, source) => {
    expect(source, file).not.toMatch(/className=\{`[^`]*\$\{/);
    expect(source, file).not.toMatch(/\bid=\{`[^`]*\$\{(row|source|item|report)\./);
  });
});

describe("the Research files stay inside their import rules (D-23 transport rule)", () => {
  it.each(COMPONENT_SOURCES)(
    "%s imports only the domain, preact and its siblings",
    (file, source) => {
      for (const specifier of importSpecifiers(source)) {
        expect(specifier, `${file} imports ${specifier}`).toMatch(ALLOWED_COMPONENT_IMPORT);
      }
    },
  );

  it.each(CONTAINER_SOURCES)("%s imports only the holders it is allowed", (file, source) => {
    for (const specifier of importSpecifiers(source)) {
      expect(specifier, `${file} imports ${specifier}`).toMatch(ALLOWED_CONTAINER_IMPORT);
    }
  });

  it.each(STATE_SOURCES)("%s imports only the domain, signals and its copy", (file, source) => {
    for (const specifier of importSpecifiers(source)) {
      expect(specifier, `${file} imports ${specifier}`).toMatch(ALLOWED_STATE_IMPORT);
    }
  });

  it.each(SOURCES)(
    "%s imports no Obsidian API, service client, connector or executor",
    (file, source) => {
      for (const specifier of importSpecifiers(source)) {
        expect(specifier, file).not.toMatch(/obsidian|service-api-client|connector|executor/i);
      }
    },
  );

  it.each(SOURCES)("%s never reaches the keychain", (file, source) => {
    expect(source, file).not.toMatch(/keychain\//i);
    expect(source, file).not.toMatch(/getSecret|setSecret|@ccc\/keychain/);
  });
});

describe("the Run now control is a port call and nothing else", () => {
  it("lets the container call only requestRunNow, openNote and the state actions", () => {
    const container = CONTAINER_SOURCES[0]?.[1] ?? "";
    const calls = [...container.matchAll(/researchPorts\(\)\.(\w+)\(/g)].map((match) => match[1]);
    expect(new Set(calls)).toEqual(new Set(["requestRunNow", "openNote"]));
    expect(container).not.toMatch(/researchApi\(\)/);
  });
});
