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
import { fileURLToPath, pathToFileURL } from "node:url";
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

// Phase 6 elements (plan 06-02, task 2; D-01, D-03, A-4). `approval` is the
// engine folder, `approval-minter` the single file that will hold the token
// cast, `executors` the effect code. Every FIRES case has a control in which
// the forbidden import is replaced by a type import from @ccc/domain and no
// boundaries/ message remains; the QUIET cases prove the allowed edges.
interface FireCase {
  readonly name: string;
  readonly importer: string;
  readonly specifier: string;
}

const MINTER = "../approval/mint/mint-token.js";
const FIRES: readonly FireCase[] = [
  {
    name: "service file -> minter",
    importer: "packages/service/src/probe.ts",
    specifier: "./approval/mint/mint-token.js",
  },
  {
    name: "service file -> executors index",
    importer: "packages/service/src/probe.ts",
    specifier: "./executors/index.js",
  },
  {
    name: "composition root -> minter",
    importer: "packages/service/src/main.ts",
    specifier: "./approval/mint/mint-token.js",
  },
  {
    name: "approval file -> executors index",
    importer: "packages/service/src/approval/probe.ts",
    specifier: "../executors/index.js",
  },
  {
    name: "approval file -> service file",
    importer: "packages/service/src/approval/probe.ts",
    specifier: "../logging.js",
  },
  {
    name: "approval file -> operational store",
    importer: "packages/service/src/approval/probe.ts",
    specifier: "@ccc/operational-store",
  },
  {
    name: "executors file -> service file",
    importer: "packages/service/src/executors/probe.ts",
    specifier: "../logging.js",
  },
  {
    name: "executors file -> approval index",
    importer: "packages/service/src/executors/probe.ts",
    specifier: "../approval/index.js",
  },
  {
    name: "untrusted file -> minter",
    importer: "packages/service/src/untrusted/probe.ts",
    specifier: MINTER,
  },
  {
    name: "plugin file -> approval index",
    importer: "packages/plugin/src/probe.ts",
    specifier: "../../service/src/approval/index.js",
  },
  {
    name: "test-fixtures file -> minter",
    importer: "packages/test-fixtures/src/probe.ts",
    specifier: "../../service/src/approval/mint/mint-token.js",
  },
  {
    name: "approval public door -> minter (review MAJOR-2)",
    importer: "packages/service/src/approval/index.ts",
    specifier: "./mint/mint-token.js",
  },
  {
    name: "minter file -> approval index",
    importer: "packages/service/src/approval/mint/probe.ts",
    specifier: "../index.js",
  },
];

const QUIET: readonly FireCase[] = [
  {
    name: "approval file -> minter",
    importer: "packages/service/src/approval/probe.ts",
    specifier: "./mint/mint-token.js",
  },
  {
    name: "service file -> approval public entry",
    importer: "packages/service/src/probe.ts",
    specifier: "./approval/index.js",
  },
  {
    name: "composition root -> executors index",
    importer: "packages/service/src/main.ts",
    specifier: "./executors/index.js",
  },
  {
    name: "composition root -> approval public entry",
    importer: "packages/service/src/main.ts",
    specifier: "./approval/index.js",
  },
  {
    name: "approval file -> domain",
    importer: "packages/service/src/approval/probe.ts",
    specifier: "@ccc/domain",
  },
  {
    name: "executors file -> domain",
    importer: "packages/service/src/executors/probe.ts",
    specifier: "@ccc/domain",
  },
  {
    name: "minter file -> domain",
    importer: "packages/service/src/approval/mint/probe.ts",
    specifier: "@ccc/domain",
  },
];

describe("approval, approval-minter and executors elements (D-01, D-03, A-4)", () => {
  for (const c of FIRES) {
    test(`FIRES: ${c.name}`, async () => {
      const messages = await boundariesFor(c.importer, `import "${c.specifier}";\n`);
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.map((m) => m.ruleId)).toContain("boundaries/dependencies");
    });
    test(`quiet half of "${c.name}": the import replaced by a domain type import`, async () => {
      expect(await boundariesFor(c.importer, DOMAIN_TYPE_IMPORT)).toHaveLength(0);
    });
  }
  for (const c of QUIET) {
    test(`QUIET: ${c.name}`, async () => {
      expect(await boundariesFor(c.importer, `import "${c.specifier}";\n`)).toHaveLength(0);
    });
  }
});

/** Every lint message (any rule) for `code` linted as `virtualPath`. */
async function allMessagesFor(virtualPath: string, code: string): Promise<EslintMessage[]> {
  const results = await lintEngine.lintText(code, { filePath: join(REPO_ROOT, virtualPath) });
  return results.flatMap((r) => r.messages);
}

describe("non-literal and require-form imports are refused in the service (review MAJOR-1)", () => {
  const BT = "`";
  const ROUTE = "packages/service/src/routes/x.ts";
  const cases: ReadonlyArray<readonly [string, string]> = [
    [
      "template literal without substitution",
      `await import(${BT}../approval/mint/mint-token.js${BT});\n`,
    ],
    [
      "template literal with substitution",
      `const n = "mint-token";\nawait import(${BT}../approval/mint/${"$"}{n}.js${BT});\n`,
    ],
    ["computed specifier", `const n = "../approval/mint/mint-token.js";\nawait import(n);\n`],
    [
      "import-equals require",
      `import m = require("../approval/mint/mint-token.js");\nexport { m };\n`,
    ],
  ];
  for (const [name, code] of cases) {
    test(`FIRES: ${name}`, async () => {
      const messages = await allMessagesFor(ROUTE, code);
      expect(messages.map((m) => m.ruleId)).toContain("no-restricted-syntax");
    });
  }
  test("QUIET: a string-literal dynamic import of an allowed module", async () => {
    const messages = await allMessagesFor(ROUTE, 'await import("@ccc/domain");\n');
    expect(messages.filter((m) => m.ruleId === "no-restricted-syntax")).toHaveLength(0);
  });
});

describe("computed imports are refused in every service module extension (Codex review MAJOR)", () => {
  const CODE = `const n = "../approval/mint/mint-token.js";\nawait import(n);\n`;
  for (const ext of ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]) {
    test(`FIRES: computed import in a .${ext} service file`, async () => {
      const messages = await allMessagesFor(`packages/service/src/routes/x.${ext}`, CODE);
      expect(messages.map((m) => m.ruleId)).toContain("no-restricted-syntax");
    });
  }
  for (const ext of ["ts", "tsx", "mts", "cts", "mjs", "cjs"]) {
    test(`QUIET: literal import in a .${ext} service file`, async () => {
      const messages = await allMessagesFor(
        `packages/service/src/routes/x.${ext}`,
        'await import("@ccc/domain");\n',
      );
      expect(messages).toHaveLength(0);
    });
  }
});

describe("computed require and createRequire are refused in the service (Codex review MAJOR)", () => {
  const ROUTE = "packages/service/src/routes/x.ts";
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["computed require argument", `declare const n: string;\nrequire(n);\n`],
    ["template require argument", `declare const n: string;\nrequire(${"`"}../${"$"}{n}${"`"});\n`],
    ["require of the minter path", `require("../approval/mint/mint-token.js");\n`],
    ["require of an executor path", `require("../executors/index.js");\n`],
    ["createRequire named import", `import { createRequire } from "node:module";\nexport const r = createRequire;\n`],
    ["createRequire via dynamic import", `const m = await import("node:module");\nexport const r = m.createRequire;\n`],
    ["createRequire via namespace import", `import * as m from "node:module";\nexport const r = m;\n`],
    ["module.require", `declare const n: string;\nmodule.require(n);\n`],
  ];
  for (const [name, code] of cases) {
    test(`FIRES: ${name}`, async () => {
      const messages = await allMessagesFor(ROUTE, code);
      expect(messages.map((m) => m.ruleId)).toContain("no-restricted-syntax");
    });
  }
  test("QUIET: a string-literal require of an allowed module and an unrelated identifier", async () => {
    const messages = await allMessagesFor(
      ROUTE,
      'const require2 = (x: string) => x;\nrequire2("a");\nrequire("@ccc/domain");\n',
    );
    expect(messages.filter((m) => m.ruleId === "no-restricted-syntax")).toHaveLength(0);
  });
});

describe("the approval public door never re-exports the minter (review MAJOR-2)", () => {
  const DOOR = "packages/service/src/approval/index.ts";
  test("FIRES: export * from the minter", async () => {
    const messages = await boundariesFor(DOOR, 'export * from "./mint/mint-token.js";\n');
    expect(messages.map((m) => m.ruleId)).toContain("boundaries/dependencies");
  });
  test("QUIET: export * from an engine file", async () => {
    expect(await boundariesFor(DOOR, 'export * from "./engine.js";\n')).toHaveLength(0);
  });
});

describe("element list and config shape (plan 06-02)", () => {
  type ConfigBlock = Record<string, unknown>;
  interface Descriptor {
    readonly type: string;
    readonly pattern: string;
  }
  async function loadConfig(): Promise<ConfigBlock[]> {
    const mod = (await import(pathToFileURL(ESLINT_CONFIG).href)) as { default: ConfigBlock[] };
    return mod.default;
  }
  async function loadDescriptors(): Promise<Descriptor[]> {
    for (const block of await loadConfig()) {
      const settings = block.settings as Record<string, unknown> | undefined;
      const elements = settings?.["boundaries/elements"];
      if (Array.isArray(elements)) return elements as Descriptor[];
    }
    throw new Error("no boundaries/elements settings block in eslint.config.mjs");
  }
  const EXPECTED_ELEMENT_TYPES = [
    "adapters",
    "approval",
    "approval-minter",
    "collectors",
    "domain",
    "executors",
    "keychain",
    "launchers",
    "operational-store",
    "plugin",
    "scheduler",
    "service",
    "service-api-client",
    "test-fixtures",
    "untrusted",
    "vault-repo",
  ];

  test("the element descriptors cover exactly the sixteen asserted types", async () => {
    const elements = await loadDescriptors();
    expect([...new Set(elements.map((e) => e.type))].sort()).toEqual(EXPECTED_ELEMENT_TYPES);
    expect(EXPECTED_ELEMENT_TYPES).toHaveLength(16);
  });

  test("the three new types and untrusted are never generated as package descriptors", async () => {
    const elements = await loadDescriptors();
    for (const t of ["approval", "approval-minter", "executors", "untrusted"]) {
      expect(elements.some((e) => e.pattern === `packages/${t}`)).toBe(false);
      expect(elements.some((e) => e.pattern === `node_modules/@ccc/${t}`)).toBe(false);
    }
  });

  test("nested exclusive descriptors are listed before every package descriptor, most specific first", async () => {
    const patterns = (await loadDescriptors()).map((e) => e.pattern);
    const firstPackage = patterns.indexOf("packages/domain");
    for (const nested of [
      "packages/service/src/untrusted",
      "packages/service/src/approval/mint",
      "packages/service/src/approval",
      "packages/service/src/executors",
    ]) {
      expect(patterns.indexOf(nested)).toBeGreaterThanOrEqual(0);
      expect(patterns.indexOf(nested)).toBeLessThan(firstPackage);
    }
    expect(patterns.indexOf("packages/service/src/approval/mint")).toBeLessThan(
      patterns.indexOf("packages/service/src/approval"),
    );
  });

  test("a single boundaries/dependencies block exists and no-restricted-syntax keeps one block", async () => {
    const config = await loadConfig();
    const ruleCount = (id: string) =>
      config.filter((b) => (b.rules as Record<string, unknown> | undefined)?.[id] !== undefined)
        .length;
    expect(ruleCount("boundaries/dependencies")).toBe(1);
    expect(ruleCount("no-restricted-syntax")).toBe(1);
  });
});
