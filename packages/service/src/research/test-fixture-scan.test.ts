import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Source scan (plan 07-14 Task 3, Tests 1 and 2; D-04, D-27, research Pitfall 15, T-07-34): the
 * research test variables are read in exactly one module, the installed service's environment
 * never names them, and the Anthropic key is confined to the composition root. Mirrors the
 * approval override scan.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const GUARD_MODULE = join(HERE, "test-fixture-guard.ts");
const MAIN = join(HERE, "..", "main.ts");

const FLAG = "CCC_ENABLE_TEST_OVERRIDES";
const VARIABLES = [
  "CCC_RESEARCH_TEST_FIXTURE_DIR",
  "CCC_RESEARCH_TEST_SUMMARISER",
  "CCC_RESEARCH_KEY_ACCOUNT",
] as const;

/**
 * The exact files permitted to name the research test variables, each pinned to the variables it
 * names (plan 07-17). Two files, no more: the guard that READS them, and the live-UAT runner's
 * fixture module that SETS them for the throwaway service of an automated run (the runner is the
 * one other party that must name them). Every entry is an exact repository-relative file path:
 * no glob, no directory, no pattern. The scan below fails when a file outside this list names a
 * variable, when a listed file no longer names the variable it is pinned to (a stale entry), when
 * a listed path is not an existing regular file, and when an entry looks like a pattern or a
 * directory. Widening this list is a reviewed change to this one table.
 */
export const RESEARCH_VARIABLE_FILES: Readonly<
  Record<string, readonly (typeof VARIABLES)[number][]>
> = {
  "packages/service/src/research/test-fixture-guard.ts": [...VARIABLES],
  "packages/e2e/src/research-uat-fixture.ts": [...VARIABLES],
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function sourceFiles(): string[] {
  const files: string[] = [];
  for (const pkg of readdirSync(join(REPO, "packages"))) {
    try {
      walk(join(REPO, "packages", pkg, "src"), files);
    } catch {
      // a package without a src folder
    }
  }
  // The wdio specs, smoke probes and the runner's wdio configuration run inside the live-UAT
  // runner and are source for this purpose too (plan 07-17): a spec naming a variable fails here
  // like a module.
  for (const pkg of readdirSync(join(REPO, "packages"))) {
    for (const folder of ["specs", "smoke"]) {
      try {
        walk(join(REPO, "packages", pkg, folder), files);
      } catch {
        // a package without this folder
      }
    }
    try {
      for (const entry of readdirSync(join(REPO, "packages", pkg))) {
        if (/^wdio[\w.-]*\.ts$/.test(entry)) files.push(join(REPO, "packages", pkg, entry));
      }
    } catch {
      // not a directory
    }
  }
  files.push(...walk(join(REPO, "scripts")));
  return files.filter((file) => /\.(ts|tsx|mjs|js|sh|template|plist)$/.test(file));
}

/**
 * The files the scan does not read, as an explicit set (07-FIX7). A name that merely contains
 * `test`, `test-support` or `harness` exempts nothing: a wdio spec named `x.test.e2e.ts`, a
 * `harness-x.ts` or a `harness/` folder anywhere is scanned like any other source.
 *
 * - a test file is a file whose name ends in `.test.ts` or `.test.tsx` (so `.int.test.ts` and
 *   `.audit.test.ts` are included, `.test.e2e.ts` is not);
 * - test support is one of these exact folders, or one of these exact files.
 *
 * Every entry is a plain repository-relative path, and a test below checks that each one exists, so
 * a stale entry fails and a new support folder has to be added here, in review.
 */
export const TEST_FILE_SUFFIXES: readonly string[] = [".test.ts", ".test.tsx"];
export const TEST_SUPPORT_FOLDERS: readonly string[] = [
  "packages/collectors/src/test-support/",
  "packages/operational-store/src/test-support/",
  "packages/plugin/src/test-support/",
  "packages/service/src/test-support/",
  "packages/service/src/approval/test-support/",
  "packages/service/src/executors/test-support/",
  "packages/service/src/research/fetch/test-support/",
  "packages/service/src/research/test-support/",
];
export const TEST_SUPPORT_FILES: readonly string[] = [
  "packages/test-fixtures/src/service-harness.ts",
];

const isTest = (file: string): boolean => {
  const path = relative(REPO, file).split(sep).join("/");
  return (
    TEST_FILE_SUFFIXES.some((suffix) => path.endsWith(suffix)) ||
    TEST_SUPPORT_FOLDERS.some((folder) => path.startsWith(folder)) ||
    TEST_SUPPORT_FILES.includes(path)
  );
};

const scannedFiles = (files: readonly string[]): string[] => files.filter((file) => !isTest(file));

/** A pattern character, or a trailing separator: anything that is not one plain file path. */
const NOT_A_PLAIN_FILE = /[*?[\]{}!()]|\/$|\\|^\.{0,2}\/|\.\.\/|^\//;

/**
 * Everything wrong with a pinned list, as short codes. Pure: the file system is a parameter, so
 * the control tests below can show each problem is detected on an in-memory sample.
 */
function findListProblems(
  list: Readonly<Record<string, readonly string[]>>,
  io: {
    readonly kindOf: (path: string) => "file" | "directory" | "missing";
    readonly text: (path: string) => string;
  },
): string[] {
  const problems: string[] = [];
  for (const [path, names] of Object.entries(list)) {
    if (NOT_A_PLAIN_FILE.test(path) || !/\.(ts|tsx|mjs)$/.test(path)) {
      problems.push(`not-a-plain-file ${path}`);
      continue;
    }
    const kind = io.kindOf(path);
    if (kind !== "file") {
      problems.push(`${kind === "directory" ? "directory" : "missing"} ${path}`);
      continue;
    }
    if (names.length === 0) problems.push(`no-variable ${path}`);
    const text = io.text(path);
    for (const name of names) {
      if (!text.includes(name)) problems.push(`stale ${path} ${name}`);
    }
  }
  return problems;
}

const codeOf = (file: string): string =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

describe("the research test variables are confined to their guard (Test 2)", () => {
  const files = sourceFiles();

  for (const variable of VARIABLES) {
    it(`names ${variable} in exactly the pinned non-test source files`, () => {
      const hits = scannedFiles(files)
        .filter((file) => readFileSync(file, "utf8").includes(variable))
        .map((file) => relative(REPO, file))
        .sort();
      const pinned = Object.entries(RESEARCH_VARIABLE_FILES)
        .filter(([, names]) => names.includes(variable))
        .map(([path]) => path)
        .sort();
      expect(hits).toEqual(pinned);
    });

    it(`reads ${variable} exactly once in the guard's code`, () => {
      expect(codeOf(GUARD_MODULE).match(new RegExp(variable, "g"))).toHaveLength(1);
    });
  }

  it("names each variable exactly once in the code of the runner's fixture module (its table of names)", () => {
    const fixture = join(REPO, "packages", "e2e", "src", "research-uat-fixture.ts");
    for (const variable of VARIABLES) {
      expect(codeOf(fixture).match(new RegExp(variable, "g")), variable).toHaveLength(1);
    }
  });

  it("reads the enabling flag exactly once in the guard's code", () => {
    expect(codeOf(GUARD_MODULE).match(new RegExp(FLAG, "g"))).toHaveLength(1);
  });

  it("keeps the pinned list exact: plain existing files that still name what they are pinned to", () => {
    const real = {
      kindOf: (path: string) => {
        try {
          const stat = statSync(join(REPO, path));
          return stat.isDirectory() ? ("directory" as const) : ("file" as const);
        } catch {
          return "missing" as const;
        }
      },
      text: (path: string) => readFileSync(join(REPO, path), "utf8"),
    };
    expect(findListProblems(RESEARCH_VARIABLE_FILES, real)).toEqual([]);
  });

  it("pins exactly the guard and the runner's fixture module, no third file", () => {
    expect(Object.keys(RESEARCH_VARIABLE_FILES).sort()).toEqual([
      "packages/e2e/src/research-uat-fixture.ts",
      "packages/service/src/research/test-fixture-guard.ts",
    ]);
  });

  it("scans the wdio specs and configuration too, so a spec cannot name a variable", () => {
    const scanned = scannedFiles(files).map((file) => relative(REPO, file));
    expect(scanned).toContain("packages/e2e/wdio.conf.ts");
    expect(scanned.some((file) => file.startsWith("packages/e2e/specs/"))).toBe(true);
    expect(scanned.some((file) => file.startsWith("packages/e2e/src/"))).toBe(true);
  });

  it("control: the list check flags a glob, a directory, a stale entry, a missing file and an empty pin", () => {
    const io = {
      kindOf: (path: string) =>
        path === "packages/e2e/src"
          ? ("directory" as const)
          : path.endsWith("gone.ts")
            ? ("missing" as const)
            : ("file" as const),
      text: (path: string) => (path.endsWith("stale.ts") ? "nothing here" : VARIABLES.join(" ")),
    };
    const sample = {
      "packages/e2e/src/*.ts": [VARIABLES[0]],
      "packages/e2e/src/": [VARIABLES[0]],
      "packages/e2e/src": [VARIABLES[0]],
      "packages/e2e/**/fixture.ts": [VARIABLES[0]],
      "packages/e2e/src/gone.ts": [VARIABLES[0]],
      "packages/e2e/src/stale.ts": [VARIABLES[0]],
      "packages/e2e/src/empty.ts": [],
      "packages/e2e/src/ok.ts": [VARIABLES[0]],
    };
    expect(findListProblems(sample, io)).toEqual([
      "not-a-plain-file packages/e2e/src/*.ts",
      "not-a-plain-file packages/e2e/src/",
      "not-a-plain-file packages/e2e/src",
      "not-a-plain-file packages/e2e/**/fixture.ts",
      "missing packages/e2e/src/gone.ts",
      `stale packages/e2e/src/stale.ts ${VARIABLES[0]}`,
      "no-variable packages/e2e/src/empty.ts",
    ]);
  });

  it("names none of the variables or the flag in any LaunchAgent installer file", () => {
    const installers = files.filter((file) => /launchagent/i.test(file));
    expect(installers.length).toBeGreaterThan(0);
    for (const file of installers) {
      const text = readFileSync(file, "utf8");
      for (const name of [...VARIABLES, FLAG]) expect(text, `${file} ${name}`).not.toContain(name);
    }
  });

  it("is imported by the composition root alone", () => {
    const importers = files
      .filter((file) => !isTest(file) && /\.(ts|tsx)$/.test(file) && file !== GUARD_MODULE)
      .filter((file) => /test-fixture-guard/.test(readFileSync(file, "utf8")))
      .map((file) => relative(REPO, file));
    expect(importers).toEqual(["packages/service/src/main.ts"]);
  });

  it("adds no plain-HTTP or loopback allowance to the production fetcher", () => {
    const fetchDir = join(HERE, "fetch");
    for (const file of walk(fetchDir).filter((name) => !isTest(name) && name.endsWith(".ts"))) {
      const code = codeOf(file);
      expect(code, file).not.toMatch(/\bCCC_[A-Z_]+/);
    }
  });
});

describe("the Anthropic key is read only at the composition root (Test 1)", () => {
  const serviceSrc = join(HERE, "..");
  const files = walk(serviceSrc).filter((file) => /\.(ts|tsx)$/.test(file) && !isTest(file));

  it("imports @ccc/keychain only in main.ts and the install-secret type import", () => {
    const importers = files
      .filter((file) => /from "@ccc\/keychain"/.test(readFileSync(file, "utf8")))
      .map((file) => relative(serviceSrc, file))
      .sort();
    expect(importers).toEqual(["auth/install-secret.ts", "main.ts"]);
  });

  it("has no module under research or untrusted that imports the keychain package or a secret store", () => {
    for (const file of files.filter((name) => /\/(research|untrusted)\//.test(name))) {
      const code = codeOf(file);
      expect(code, file).not.toMatch(/@ccc\/keychain|SecretStore|secretStore|security-cli/);
    }
  });

  it("hands the research wiring a closure, never a key string", () => {
    const main = codeOf(MAIN);
    expect(main).toContain("readApiKey: () => secretStore.get(researchKeyAccount)");
    expect(main.match(/secretStore\.get\(/g)?.length).toBeLessThanOrEqual(1);
    const transportSource = codeOf(join(HERE, "anthropic-transport.ts"));
    expect(transportSource).toContain("readApiKey: () => Promise<string | null>");
  });
});

describe("07-FIX7: the test-file exemption is an explicit set, not a loose path match", () => {
  const abs = (relative: string): string => join(REPO, relative);

  // Files a loose match would skip, though none is a unit test of the service or a support folder.
  const LOOSELY_NAMED = [
    "packages/e2e/specs/research-extra.test.e2e.ts",
    "packages/e2e/src/harness-extra.ts",
    "packages/e2e/src/spec-support/test-support-extra.ts",
    "packages/example/src/harness/runner.ts",
    "packages/example/src/test-support/runner.ts",
    "scripts/ci/harness.sh",
  ];
  // Files that really are tests or test support, and stay out of the scan.
  const REAL_TESTS = [
    "packages/service/src/research/pipeline.test.ts",
    "packages/plugin/src/view/research.test.tsx",
    "packages/e2e/src/research-uat-fixture.int.test.ts",
    "packages/operational-store/src/migration-research.audit.test.ts",
    "packages/service/src/research/test-support/research-kit.ts",
  ];

  it("does not exempt a file only because its name or folder contains test, harness or test-support", () => {
    for (const file of LOOSELY_NAMED) expect(isTest(abs(file)), file).toBe(false);
  });

  it("still exempts the unit and integration test files and the service's own test-support folder", () => {
    for (const file of REAL_TESTS) expect(isTest(abs(file)), file).toBe(true);
  });

  it("keeps the exempt set exact: every folder and file listed exists, and none is a pattern", () => {
    for (const folder of TEST_SUPPORT_FOLDERS) {
      expect(NOT_A_PLAIN_FILE.test(folder.replace(/\/$/, "")), folder).toBe(false);
      expect(folder.endsWith("/"), folder).toBe(true);
      expect(statSync(abs(folder)).isDirectory(), folder).toBe(true);
    }
    for (const file of TEST_SUPPORT_FILES) {
      expect(NOT_A_PLAIN_FILE.test(file), file).toBe(false);
      expect(statSync(abs(file)).isFile(), file).toBe(true);
    }
    expect([...TEST_FILE_SUFFIXES]).toEqual([".test.ts", ".test.tsx"]);
  });

  it("mutation: a variable planted in each loosely named file is found, and none planted in a real test is", () => {
    const planted = [...LOOSELY_NAMED, ...REAL_TESTS].map(abs);
    const hits = scannedFiles(planted)
      .map((file) => relative(REPO, file))
      .sort();
    expect(hits).toEqual([...LOOSELY_NAMED].sort());
  });
});
