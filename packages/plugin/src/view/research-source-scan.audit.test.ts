import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  "report-finding.tsx",
  "report-sources.tsx",
] as const;
/** The container, the reader and the state: they also read the research holders and signals. */
const CONTAINER_FILES = ["research.tsx", "report-reader.tsx"] as const;
const STATE_FILES = [
  join(RESEARCH_DIR, "api.ts"),
  join(RESEARCH_DIR, "state.ts"),
  join(RESEARCH_DIR, "reader-state.ts"),
] as const;

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
  /^(@ccc\/domain\/[\w./-]+|preact(\/hooks)?|\.\/[\w-]+\.js|\.\.\/connection-state\.js|\.\.\/research\/(api|state|reader-state)\.js|\.\.\/widgets\/(footer|presentation|relative-time)\.js)$/;
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

describe("the reader reaches the host only through the two local ports (plan 07-13)", () => {
  const reader = CONTAINER_SOURCES.find(([file]) => file === "report-reader.tsx")?.[1] ?? "";

  it("calls only openNote and copyText through the ports, and never the API directly", () => {
    const calls = [...reader.matchAll(/researchPorts\(\)\.(\w+)\(/g)].map((match) => match[1]);
    expect(new Set(calls)).toEqual(new Set(["openNote", "copyText"]));
    expect(reader).not.toMatch(/researchApi\(\)/);
  });

  it("builds no link or image and names no address attribute (the reader is text only)", () => {
    for (const [file, source] of SOURCES) {
      if (!/report-(reader|finding|sources)/.test(file)) continue;
      expect(source, file).not.toMatch(/\s(src|srcSet|srcDoc|action|formAction|target|rel)=/);
    }
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

describe("the plugin barrel exports the Research pieces the visual harness needs (plan 07-13)", () => {
  const SRC = join(HERE, "..");
  const BARREL = readFileSync(join(SRC, "index.ts"), "utf8");

  /** Every `export { a, b as c } from "x"` and `export type { ... } from "x"` of the barrel. */
  function barrelExports(): { name: string; type: boolean; from: string }[] {
    const found: { name: string; type: boolean; from: string }[] = [];
    for (const match of BARREL.matchAll(
      /export\s+(type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g,
    )) {
      for (const part of (match[2] ?? "").split(",")) {
        const name =
          part
            .trim()
            .split(/\s+as\s+/)
            .pop()
            ?.replace(/^type\s+/, "") ?? "";
        if (name !== "") found.push({ name, type: match[1] !== undefined, from: match[3] ?? "" });
      }
    }
    return found;
  }

  it("exports the destination, the holder and the reset functions as values", () => {
    const values = new Set(
      barrelExports()
        .filter((entry) => !entry.type)
        .map((entry) => entry.name),
    );
    for (const name of [
      "ResearchDestination",
      "configureResearch",
      "ResearchApiError",
      "onResearchUpdated",
      "resetResearchState",
      "resetReaderState",
    ]) {
      expect(values.has(name), name).toBe(true);
    }
  });

  it("exports the API port and the view-model types as types", () => {
    const types = new Set(
      barrelExports()
        .filter((entry) => entry.type)
        .map((entry) => entry.name),
    );
    for (const name of [
      "ResearchApi",
      "ResearchHostPorts",
      "ResearchListResponse",
      "ResearchListRow",
      "ResearchStatusResponse",
      "ResearchRunResponse",
      "ResearchReportHeader",
      "ResearchReportItem",
      "ResearchReportSource",
      "ResearchReportItemsPage",
      "ResearchReportSourcesPage",
      "ResearchReportResponse",
    ]) {
      expect(types.has(name), name).toBe(true);
    }
  });

  it("reaches no Obsidian or Electron module from anything the Research exports import", () => {
    const entries = barrelExports().filter((entry) => /research|view\/research/.test(entry.from));
    expect(entries.length).toBeGreaterThan(3);
    const seen = new Set<string>();
    const queue = [...new Set(entries.map((entry) => entry.from))].filter((from) =>
      from.startsWith("."),
    );
    const offenders: string[] = [];
    while (queue.length > 0) {
      const spec = queue.pop() as string;
      const base = resolve(SRC, spec.replace(/\.js$/, ""));
      const file = [".ts", ".tsx"].map((extension) => base + extension).find((c) => existsSync(c));
      if (file === undefined || seen.has(file)) continue;
      seen.add(file);
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        if (/^(obsidian|electron)$/.test(specifier)) offenders.push(`${file} imports ${specifier}`);
        if (specifier.startsWith("."))
          queue.push(resolve(dirname(file), specifier).replace(SRC, "."));
      }
    }
    expect(seen.size).toBeGreaterThan(5);
    expect(offenders).toEqual([]);
  });
});
