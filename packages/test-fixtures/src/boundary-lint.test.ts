// REPO-03: proves the import-boundary lint (eslint.config.mjs) fires on each
// known-bad violation fixture and is silent once the forbidden import is
// removed -- the second half is what proves the rule discriminates instead
// of always failing. See eslint.config.mjs's "violation fixtures" element
// descriptors for how these files are reclassified away from
// `test-fixtures` (which is allowed to import everything) into the element
// type each fixture is meant to impersonate.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { stdout?: unknown }).stdout === "string"
  );
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
  return results
    .flatMap((r) => r.messages)
    .filter((m) => m.ruleId?.startsWith("boundaries/") === true);
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

// D-18 (PROJ-13): the root config's process-spawn `no-restricted-syntax`
// block for packages/launchers and packages/service also covers
// boundary-violations/service/, so the committed fixture there must fire it,
// and the same file rewritten to execFile with an argv array must not.
const SHELL_EXEC_FIXTURE = join(FIXTURES_DIR, "service", "shell-exec-in-service.ts");
const SHELL_FREE_BODY = `import { execFile } from "node:child_process";

export function listProjectFolder(): void {
  execFile("ls", ["-la"], () => {});
}
`;

function restrictedSyntaxMessages(results: EslintFileResult[]): EslintMessage[] {
  return results.flatMap((r) => r.messages).filter((m) => m.ruleId === "no-restricted-syntax");
}

describe("process-spawn lint (D-18)", () => {
  const restorers: Array<() => void> = [];
  afterEach(() => {
    while (restorers.length > 0) restorers.pop()?.();
  });

  test("shell-exec-in-service.ts (as committed) fires the named-import and bare-call selectors", () => {
    const original = readFileSync(SHELL_EXEC_FIXTURE, "utf8");
    expect(original).toContain('from "node:child_process"');

    const messages = restrictedSyntaxMessages(runEslintJson(SHELL_EXEC_FIXTURE));
    expect(messages.length).toBeGreaterThanOrEqual(2);
  });

  test("shell-exec-in-service.ts rewritten to execFile with an argv array passes -- the rule discriminates", () => {
    const original = readFileSync(SHELL_EXEC_FIXTURE, "utf8");
    writeFileSync(SHELL_EXEC_FIXTURE, SHELL_FREE_BODY);
    restorers.push(() => writeFileSync(SHELL_EXEC_FIXTURE, original));

    const messages = restrictedSyntaxMessages(runEslintJson(SHELL_EXEC_FIXTURE));
    expect(messages).toHaveLength(0);
  });
});

// Research C-1 / defects A and B (plan 06-02, task 1). The committed config used
// to classify every file under packages/service/src/untrusted/ as plain
// `service` (exclusive descriptors were listed after the package descriptors)
// and could not resolve a `./x.js` specifier to its `x.ts` source, so every
// intra-package edge was invisible to `boundaries/dependencies`. These cases
// use ESLint#lintText with a VIRTUAL importer path and a REAL target: no
// physical violation fixture is needed, and each firing case has a quiet half.
const requireFromRoot = createRequire(join(REPO_ROOT, "package.json"));
const { ESLint } = requireFromRoot("eslint") as {
  ESLint: new (options: {
    cwd: string;
    overrideConfigFile: string;
  }) => {
    lintText(
      code: string,
      options: { filePath: string },
    ): Promise<Array<{ messages: EslintMessage[] }>>;
  };
};
const lintEngine = new ESLint({ cwd: REPO_ROOT, overrideConfigFile: ESLINT_CONFIG });

/** Lints `code` as if it lived at `virtualPath` (relative to the repo root). */
async function boundariesFor(virtualPath: string, code: string): Promise<EslintMessage[]> {
  const results = await lintEngine.lintText(code, { filePath: join(REPO_ROOT, virtualPath) });
  return results
    .flatMap((r) => r.messages)
    .filter((m) => m.ruleId?.startsWith("boundaries/") === true);
}

const DOMAIN_TYPE_IMPORT = 'import type { RunId } from "@ccc/domain";\nexport type X = RunId;\n';

describe("boundary classification and resolver (research C-1, defects A and B)", () => {
  test("a file under packages/service/src/untrusted/ is the untrusted element: importing the operational store fires", async () => {
    const messages = await boundariesFor(
      "packages/service/src/untrusted/probe.ts",
      'import "@ccc/operational-store";\n',
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  test("the same untrusted file importing only @ccc/domain is quiet", async () => {
    expect(
      await boundariesFor("packages/service/src/untrusted/probe.ts", DOMAIN_TYPE_IMPORT),
    ).toHaveLength(0);
  });

  test("an intra-service ./x.js edge from the untrusted folder is evaluated and fires", async () => {
    const messages = await boundariesFor(
      "packages/service/src/untrusted/probe.ts",
      'import { createLogger } from "../logging.js";\nexport const l = createLogger;\n',
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  test("the same untrusted file importing a domain type instead is quiet", async () => {
    expect(
      await boundariesFor("packages/service/src/untrusted/probe.ts", DOMAIN_TYPE_IMPORT),
    ).toHaveLength(0);
  });

  test("a plain service file importing a sibling .js is quiet (service may import service)", async () => {
    expect(
      await boundariesFor(
        "packages/service/src/probe.ts",
        'import { createLogger } from "./logging.js";\nexport const l = createLogger;\n',
      ),
    ).toHaveLength(0);
  });
});

describe("local .js-to-.ts resolver (research defect B)", () => {
  const resolverPath = join(REPO_ROOT, "eslint.boundary-resolver.cjs");
  const loadResolver = () =>
    requireFromRoot(resolverPath) as {
      interfaceVersion: number;
      resolve(source: string, file: string): { found: boolean; path?: string | null };
    };
  const importer = join(REPO_ROOT, "packages", "service", "src", "untrusted", "probe.ts");

  test("declares interface version 2", () => {
    expect(loadResolver().interfaceVersion).toBe(2);
  });

  test("maps a ./x.js specifier to the real x.ts sibling", () => {
    const result = loadResolver().resolve("../logging.js", importer);
    expect(result.found).toBe(true);
    expect(result.path?.endsWith(join("service", "src", "logging.ts"))).toBe(true);
  });

  test("reports not found for a nonexistent relative specifier", () => {
    expect(loadResolver().resolve("../does-not-exist.js", importer).found).toBe(false);
  });

  test("treats a Node built-in as found with a null path", () => {
    expect(loadResolver().resolve("node:fs", importer)).toEqual({ found: true, path: null });
  });

  test("resolves a bare workspace package through the importer's own node_modules", () => {
    const result = loadResolver().resolve("@ccc/domain", importer);
    expect(result.found).toBe(true);
    expect(typeof result.path).toBe("string");
  });
});
