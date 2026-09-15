// REPO-03: proves the import-boundary lint (eslint.config.mjs) fires on each
// known-bad violation fixture and is silent once the forbidden import is
// removed -- the second half is what proves the rule discriminates instead
// of always failing. See eslint.config.mjs's "violation fixtures" element
// descriptors for how these files are reclassified away from
// `test-fixtures` (which is allowed to import everything) into the element
// type each fixture is meant to impersonate.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const ESLINT_BIN = join(REPO_ROOT, "node_modules", ".bin", "eslint");
const ESLINT_CONFIG = join(REPO_ROOT, "eslint.config.mjs");
const FIXTURES_DIR = join(REPO_ROOT, "packages", "test-fixtures", "boundary-violations");

interface EslintMessage {
  readonly ruleId: string | null;
}
interface EslintFileResult {
  readonly filePath: string;
  readonly messages: EslintMessage[];
}

/** A `{ stdout }`-carrying error, the shape `execFileSync` throws on a
 * non-zero exit -- ESLint exits 1 when it reports lint errors, but the JSON
 * report is still on stdout. */
function hasStdout(err: unknown): err is { stdout: string } {
  return typeof err === "object" && err !== null && typeof (err as { stdout?: unknown }).stdout === "string";
}

function runEslintJson(filePath: string): EslintFileResult[] {
  let stdout: string;
  try {
    stdout = execFileSync(ESLINT_BIN, ["--config", ESLINT_CONFIG, "--format", "json", filePath], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
  } catch (err) {
    if (!hasStdout(err)) throw err;
    stdout = err.stdout;
  }
  return JSON.parse(stdout) as EslintFileResult[];
}

function boundariesMessages(results: EslintFileResult[]): EslintMessage[] {
  return results.flatMap((r) => r.messages).filter((m) => m.ruleId?.startsWith("boundaries/") === true);
}

interface Fixture {
  /** Path relative to FIXTURES_DIR, e.g. "service/plugin-import-from-service.ts". */
  readonly file: string;
  /** The literal forbidden import specifier expected in the committed
   * fixture, asserted before mutation so a future edit that silently
   * changes the fixture's import can't make this test vacuously pass. */
  readonly forbiddenImportSpecifier: string;
  /** A minimal, always-permitted replacement body -- every element type
   * these fixtures impersonate (service, untrusted, collectors) is allowed
   * to import `@ccc/domain`, so this proves the rule discriminates rather
   * than being silent for an unrelated reason (e.g. a parse error). */
  readonly cleanContent: string;
}

const FIXTURES: readonly Fixture[] = [
  {
    file: "service/plugin-import-from-service.ts",
    forbiddenImportSpecifier: '"@ccc/plugin"',
    cleanContent: 'export type { RunId } from "@ccc/domain";\n',
  },
  {
    file: "untrusted/untrusted-imports-adapter.ts",
    forbiddenImportSpecifier: '"@ccc/adapters"',
    cleanContent: 'export type { RunId } from "@ccc/domain";\n',
  },
  {
    file: "collectors/collector-imports-adapter.ts",
    forbiddenImportSpecifier: '"@ccc/adapters"',
    cleanContent: 'export type { RunId } from "@ccc/domain";\n',
  },
];

describe("import-boundary lint fixtures (REPO-03)", () => {
  // Each "cleaned control" test temporarily overwrites the committed
  // fixture in place (so it keeps the same element classification) and
  // restores it afterward -- restorers run even if an assertion throws.
  const restorers: Array<() => void> = [];
  afterEach(() => {
    while (restorers.length > 0) restorers.pop()?.();
  });

  for (const fixture of FIXTURES) {
    const filePath = join(FIXTURES_DIR, fixture.file);

    test(`${fixture.file} (as committed) violates the boundary rule`, () => {
      const original = readFileSync(filePath, "utf8");
      expect(original).toContain(fixture.forbiddenImportSpecifier);

      const messages = boundariesMessages(runEslintJson(filePath));
      expect(messages.length).toBeGreaterThan(0);
    });

    test(`${fixture.file} (forbidden import removed) passes -- the rule discriminates`, () => {
      const original = readFileSync(filePath, "utf8");
      writeFileSync(filePath, fixture.cleanContent);
      restorers.push(() => writeFileSync(filePath, original));

      const messages = boundariesMessages(runEslintJson(filePath));
      expect(messages).toHaveLength(0);
    });
  }
});
