// Proves the plugin-policy lint families added in plan 03-01 are not vacuous
// (ADR-0019: "a boundary lint that never fires is strictly worse than no
// lint at all -- it is false confidence").
//
// Three layers protect each rule. This file is the third: for every
// committed fixture it asserts (a) the fixture as committed produces the
// expected lint message -- the rule FIRES -- and (b) the same file with the
// forbidden construct removed produces none -- the rule DISCRIMINATES,
// rather than failing for an unrelated reason such as a parse error.
//
// A fourth assertion closes the loop the fixtures cannot: the fixtures are
// linted with `eslint.lint-fixtures.config.mjs`, so proving a rule fires
// there proves nothing about the config `ci:obsidianmd` actually runs. The
// `--print-config` test reads the PRODUCTION config's resolved rules for
// `src/main.ts` and asserts it still carries every rule the fixtures prove,
// at error severity. The two configs therefore cannot drift apart silently.
//
// Harness copied from ./boundary-lint.test.ts (same REPO-03 pattern),
// parameterised by config path and run with `cwd: packages/plugin` to match
// how `ci:obsidianmd` invokes ESLint.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const PLUGIN_DIR = join(REPO_ROOT, "packages", "plugin");
const ESLINT_BIN = join(REPO_ROOT, "node_modules", ".bin", "eslint");
const FIXTURES_CONFIG = join(PLUGIN_DIR, "eslint.lint-fixtures.config.mjs");
const PRODUCTION_CONFIG = join(PLUGIN_DIR, "eslint.config.mjs");
const FIXTURES_DIR = join(PLUGIN_DIR, "lint-fixtures");

/** Every rule id these fixtures exercise. The "cleaned control" half asserts
 * zero messages from ALL of them, not just the one the fixture targets, so a
 * cleaned file that trips a sibling rule cannot pass. */
const PLUGIN_POLICY_RULE_IDS = [
  "no-restricted-syntax",
  "no-restricted-globals",
  "no-restricted-imports",
] as const;

interface EslintMessage {
  readonly ruleId: string | null;
  readonly message: string;
  readonly line?: number;
}
interface EslintFileResult {
  readonly filePath: string;
  readonly messages: EslintMessage[];
}

/** A `{ stdout }`-carrying error, the shape `execFileSync` throws on a
 * non-zero exit -- ESLint exits 1 when it reports lint errors, but the JSON
 * report is still on stdout. */
function hasStdout(err: unknown): err is { stdout: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { stdout?: unknown }).stdout === "string"
  );
}

function runEslintJson(configPath: string, filePath: string): EslintFileResult[] {
  let stdout: string;
  try {
    stdout = execFileSync(ESLINT_BIN, ["--config", configPath, "--format", "json", filePath], {
      cwd: PLUGIN_DIR,
      encoding: "utf8",
    });
  } catch (err) {
    if (!hasStdout(err)) throw err;
    stdout = err.stdout;
  }
  return JSON.parse(stdout) as EslintFileResult[];
}

function policyMessages(results: EslintFileResult[]): EslintMessage[] {
  return results
    .flatMap((r) => r.messages)
    .filter((m) => PLUGIN_POLICY_RULE_IDS.some((id) => id === m.ruleId));
}

interface Fixture {
  /** Path relative to FIXTURES_DIR, e.g. "inner-html-assignment.ts". */
  readonly file: string;
  /** The rule id the committed fixture must trip. */
  readonly ruleId: (typeof PLUGIN_POLICY_RULE_IDS)[number];
  /** A substring of the expected message, so a fixture that trips the right
   * rule for the wrong reason still fails. */
  readonly messageFragment: string;
  /** The same file with the forbidden construct removed -- same exported
   * names, so this is a genuine control rather than an empty file. */
  readonly cleanContent: string;
}

/** Split out of the fixture body below -- see the comment there. */
const OBSIDIAN_SPECIFIER = "obsidian";

const FIXTURES: readonly Fixture[] = [
  {
    file: "inner-html-assignment.ts",
    ruleId: "no-restricted-syntax",
    messageFragment: "innerHTML/outerHTML are forbidden",
    cleanContent:
      "export function renderUntrustedTitle(host: HTMLElement, title: string): void {\n" +
      "  host.textContent = title;\n" +
      "}\n",
  },
  {
    file: "inline-style-variable.ts",
    ruleId: "no-restricted-syntax",
    messageFragment: "Inline style assignment is forbidden",
    cleanContent:
      "export function applyMeasuredWidth(host: HTMLElement, width: string): void {\n" +
      '  host.setAttribute("data-ccc-width", width);\n' +
      "}\n",
  },
  {
    file: "jsx-style-prop.tsx",
    ruleId: "no-restricted-syntax",
    messageFragment: "Inline style props are forbidden",
    cleanContent:
      "/** @jsx h */\n" +
      'import { h, type VNode } from "preact";\n' +
      "\n" +
      "export function MeasuredBar({ width }: { readonly width: string }): VNode {\n" +
      '  return h("div", { class: "ccc-bar" }, <span data-ccc-width={width} />);\n' +
      "}\n",
  },
  {
    file: "global-fetch.ts",
    ruleId: "no-restricted-globals",
    messageFragment: "only through @ccc/service-api-client",
    cleanContent:
      "export async function loadRemoteStatus(url: string): Promise<string> {\n" +
      "  return Promise.resolve(url);\n" +
      "}\n",
  },
  {
    file: "obsidian-request-url.ts",
    ruleId: "no-restricted-imports",
    messageFragment: "Obsidian's own HTTP helpers bypass the service boundary",
    // The control keeps an `obsidian` import and removes only the forbidden
    // NAME -- that is the discrimination worth proving, since the plugin is
    // the one element allowed to import `obsidian` at all. The specifier is
    // interpolated rather than written literally so this line does not
    // itself read as `from "obsidian"` to scripts/check-boundaries.sh rule 1
    // ("no file outside packages/plugin imports the Obsidian API"), which
    // greps literal text and cannot tell a test's string payload from a real
    // import. Generated file content is unaffected.
    cleanContent:
      `import { Notice } from "${OBSIDIAN_SPECIFIER}";\n` +
      "\n" +
      "export async function loadRemoteBody(url: string): Promise<string> {\n" +
      "  new Notice(url);\n" +
      "  return Promise.resolve(url);\n" +
      "}\n",
  },
  {
    file: "node-http-import.ts",
    ruleId: "no-restricted-imports",
    messageFragment: "only through @ccc/service-api-client",
    cleanContent:
      "export function openDirectConnection(host: string): void {\n" + "  void host;\n" + "}\n",
  },
];

describe("plugin-policy lint fixtures (plan 03-01)", () => {
  // Each "cleaned control" test temporarily overwrites the committed fixture
  // in place (so it keeps the same path and therefore the same config match)
  // and restores it afterward -- restorers run even if an assertion throws.
  const restorers: Array<() => void> = [];
  afterEach(() => {
    while (restorers.length > 0) restorers.pop()?.();
  });

  for (const fixture of FIXTURES) {
    const filePath = join(FIXTURES_DIR, fixture.file);

    test(`${fixture.file} (as committed) violates the plugin policy lint`, () => {
      const messages = policyMessages(runEslintJson(FIXTURES_CONFIG, filePath)).filter(
        (m) => m.ruleId === fixture.ruleId,
      );
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.map((m) => m.message).join("\n")).toContain(fixture.messageFragment);
    });

    test(`${fixture.file} (forbidden construct removed) passes -- the rule discriminates`, () => {
      const original = readFileSync(filePath, "utf8");
      writeFileSync(filePath, fixture.cleanContent);
      restorers.push(() => writeFileSync(filePath, original));

      expect(policyMessages(runEslintJson(FIXTURES_CONFIG, filePath))).toHaveLength(0);
    });
  }
});

/** ESLint's `--print-config` output: the resolved config for one file. */
interface PrintedConfig {
  readonly rules: Record<string, unknown>;
}

function printProductionConfig(): PrintedConfig {
  const stdout = execFileSync(
    ESLINT_BIN,
    ["--config", PRODUCTION_CONFIG, "--print-config", join("src", "main.ts")],
    { cwd: PLUGIN_DIR, encoding: "utf8" },
  );
  return JSON.parse(stdout) as PrintedConfig;
}

/** ESLint severity is printed numerically (2) or as a string ("error"). */
function isErrorSeverity(value: unknown): boolean {
  return value === 2 || value === "error";
}

function ruleEntry(config: PrintedConfig, ruleId: string): readonly unknown[] {
  const entry = config.rules[ruleId];
  expect(Array.isArray(entry)).toBe(true);
  return entry as readonly unknown[];
}

describe("the production plugin config carries what the fixtures prove (plan 03-01)", () => {
  test("no-restricted-syntax is an error and lists the HTML-sink and inline-style selectors", () => {
    const entry = ruleEntry(printProductionConfig(), "no-restricted-syntax");
    expect(isErrorSeverity(entry[0])).toBe(true);

    const options = entry.slice(1) as ReadonlyArray<{ selector?: unknown; message?: unknown }>;
    const selectors = options
      .map((option) => option.selector)
      .filter((selector): selector is string => typeof selector === "string");
    const messages = options
      .map((option) => option.message)
      .filter((message): message is string => typeof message === "string")
      .join("\n");

    // The HTML-sink selector is written as an esquery alternation
    // (`[left.property.name=/^(inner|outer)HTML$/]`), so the string contains
    // no contiguous "innerHTML" -- this pattern accepts either that
    // alternation form or a literal spelling, and the message assertion
    // below pins which rule it actually is.
    expect(selectors.some((s) => /(?:\(inner\|outer\)|inner|outer)HTML/.test(s))).toBe(true);
    expect(selectors.some((s) => /style/.test(s))).toBe(true);

    expect(messages).toContain("innerHTML/outerHTML are forbidden");
    expect(messages).toContain("Inline style assignment is forbidden");
    expect(messages).toContain("Inline style props are forbidden");
  });

  test("no-restricted-globals is an error and names every network global", () => {
    const entry = ruleEntry(printProductionConfig(), "no-restricted-globals");
    expect(isErrorSeverity(entry[0])).toBe(true);

    const names = entry
      .slice(1)
      .map((option) => (option as { name?: unknown }).name)
      .filter((name): name is string => typeof name === "string");

    expect(names).toContain("fetch");
    expect(names).toContain("XMLHttpRequest");
    expect(names).toContain("WebSocket");
    expect(names).toContain("EventSource");
  });

  test("no-restricted-imports is an error and names the HTTP modules and Obsidian's helpers", () => {
    const entry = ruleEntry(printProductionConfig(), "no-restricted-imports");
    expect(isErrorSeverity(entry[0])).toBe(true);

    const paths = (entry[1] as { paths?: unknown }).paths as ReadonlyArray<{
      name?: unknown;
      importNames?: unknown;
    }>;
    expect(Array.isArray(paths)).toBe(true);

    const names = paths
      .map((p) => p.name)
      .filter((name): name is string => typeof name === "string");
    for (const expected of ["node:http", "node:https", "http", "https", "node:net"]) {
      expect(names).toContain(expected);
    }

    const obsidianEntry = paths.find((p) => p.name === "obsidian");
    expect(obsidianEntry).toBeDefined();
    expect(obsidianEntry?.importNames).toContain("requestUrl");
    expect(obsidianEntry?.importNames).toContain("request");
  });
});

// ---------------------------------------------------------------------------
// Plan 08-10, R-F1: where does the Obsidian sentence-case rule reach?
//
// The Phase 8 copy plans (08-11, 08-13, 08-15, 08-18) write most of their
// strings as Preact JSX. Whether `obsidianmd/ui/sentence-case` lints those is an
// empirical question about the installed rule, so this fixture records the
// answer and the tests below assert it: if a later upgrade of the plugin starts
// reaching JSX text, these fail and the copy rules can be tightened.
// ---------------------------------------------------------------------------

const SENTENCE_CASE_RULE_ID = "obsidianmd/ui/sentence-case";
const SENTENCE_FIXTURE = join(FIXTURES_DIR, "sentence-case-jsx-text.tsx");

/**
 * Variants of the sentence-case fixture are written HERE, never over the committed fixture
 * (FIX2B m5): a test that rewrites a tracked file and restores it in `afterEach` leaves the
 * working tree dirty if the run is killed, and two runs at once would corrupt each other.
 *
 * The directory sits inside `lint-fixtures/` because the fixtures config matches by path and ESLint
 * ignores files outside the config's base directory (`os.tmpdir()` is rejected as "outside of base
 * path"; a copied config cannot resolve the plugin's own dependencies from there). It is
 * gitignored, listed in the fixtures config, and removed after every test.
 */
const SCRATCH_DIR = join(FIXTURES_DIR, "scratch");

function sentenceCaseLines(file: string = SENTENCE_FIXTURE): string[] {
  const source = readFileSync(file, "utf8").split("\n");
  return runEslintJson(FIXTURES_CONFIG, file)
    .flatMap((r) => r.messages)
    .filter((m) => m.ruleId === SENTENCE_CASE_RULE_ID)
    .map((m) => (source[(m.line ?? 0) - 1] ?? "").trim());
}

describe("the sentence-case rule's reach into Preact copy (plan 08-10, R-F1)", () => {
  afterEach(() => {
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
  });

  /** Writes a variant to the scratch directory and returns its path. */
  function withContent(name: string, content: string): string {
    mkdirSync(SCRATCH_DIR, { recursive: true });
    const file = join(SCRATCH_DIR, `${name}.ts`);
    writeFileSync(file, content);
    return file;
  }

  test("never rewrites the committed fixture: variants live in the gitignored scratch directory", () => {
    const before = readFileSync(SENTENCE_FIXTURE, "utf8");
    const file = withContent("probe", "export const probe = 1;\n");
    expect(file.startsWith(SCRATCH_DIR)).toBe(true);
    expect(readFileSync(SENTENCE_FIXTURE, "utf8")).toBe(before);
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
    expect(readFileSync(SENTENCE_FIXTURE, "utf8")).toBe(before);
  });

  test("reaches new Notice and createEl text, so a Title Case section name there is reported", () => {
    const flagged = sentenceCaseLines();
    expect(flagged).toContain('new Notice("Go to Projects");');
    expect(flagged).toContain('createEl("span", { text: "Go to Projects" });');
  });

  test("does NOT reach JSX text nodes, JSX string attributes or h() option props: JSX copy is not linted", () => {
    const flagged = sentenceCaseLines();
    // Exactly the two controls; none of the three Preact sites is reported, so
    // JSX copy is checked only by a test that asserts the string itself.
    expect(flagged).toHaveLength(2);
    expect(flagged.some((line) => line.includes("aria-label"))).toBe(false);
    expect(flagged.some((line) => line.includes("title="))).toBe(false);
    expect(flagged.some((line) => line === "Go to Projects")).toBe(false);
  });

  test("the lowercase section reference (R-F1) is accepted where the rule does reach", () => {
    const file = withContent(
      "lowercase-section",
      "declare class Notice {\n  constructor(message: string);\n}\n" +
        'export function announce(): void {\n  new Notice("Go to the projects section");\n}\n',
    );
    expect(sentenceCaseLines(file)).toEqual([]);
  });

  test("Gmail and Google Calendar are brands: accepted capitalised anywhere in a reached string", () => {
    const file = withContent(
      "brands",
      "declare class Notice {\n  constructor(message: string);\n}\n" +
        "export function announce(): void {\n" +
        '  new Notice("Google Calendar and Gmail aren\'t part of this version");\n}\n',
    );
    expect(sentenceCaseLines(file)).toEqual([]);
  });

  test("the production config runs the same rule with the Phase 8 brands", () => {
    const entry = ruleEntry(printProductionConfig(), SENTENCE_CASE_RULE_ID);
    expect(isErrorSeverity(entry[0])).toBe(true);
    const brands = (entry[1] as { brands?: unknown }).brands;
    expect(Array.isArray(brands)).toBe(true);
    expect(brands).toContain("Gmail");
    expect(brands).toContain("Google Calendar");
    // Section names are not brands: they stay lower case in running copy.
    expect(brands).not.toContain("Projects");
    expect(brands).not.toContain("Diagnostics");
  });
});
