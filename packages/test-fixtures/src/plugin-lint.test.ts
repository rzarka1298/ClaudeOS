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
import { readFileSync, writeFileSync } from "node:fs";
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
});
