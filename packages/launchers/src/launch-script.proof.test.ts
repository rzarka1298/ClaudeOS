/**
 * The D-17 injection proof (PROJ-13, T-04-01).
 *
 * The generated launch script is the only artifact in the product that a
 * shell parses. This test renders real scripts over a hostile corpus plus
 * 500 seeded random strings, executes each one through the kernel shebang
 * (exactly as Terminal.app would, with no intermediate shell of ours), and
 * asserts that:
 *
 *   - every argv element reaches the program byte-for-byte,
 *   - an exported env value reaches the program byte-for-byte,
 *   - the working directory is exactly the requested directory,
 *   - no canary file named PWNED was created anywhere under the temp root,
 *   - the script deleted itself.
 *
 * The seeded PRNG lives in this file (mulberry32); no property-testing
 * dependency is added (owner constraint 4).
 */
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CD_FAILED_MESSAGE, renderLaunchScript } from "./launch-script.js";
import { UnsafeScriptArgumentError } from "./sh-quote.js";

const NUL = String.fromCharCode(0);
const RANDOM_CASES = 500;
const SEED = 0x0c0ffee;
/**
 * Random cases run this many at a time, one reusable script inode per slot.
 *
 * macOS charges roughly 100 ms for the first exec of every new executable
 * inode (a system policy check, serialised system-wide), so 500 fresh files
 * would take about a minute. The hostile corpus still gets a fresh
 * `wx`/0o700 file per case, exactly like production. Each random case
 * rewrites its slot's pool inode with the freshly rendered script and
 * hard-links it at the case's own script path; the kernel still execs that
 * path through the shebang, and the script's own `rm -f -- "$0"` still has
 * to remove that path for the self-delete assertion to pass.
 */
const CONCURRENCY = 16;
/** A directory name is one path component: at most 255 bytes on APFS. */
const NAME_MAX_BYTES = 255;

const HOSTILE_CORPUS: readonly string[] = [
  "'",
  '"',
  "$(touch PWNED)",
  "`touch PWNED`",
  "; touch PWNED",
  "&& touch PWNED",
  "| touch PWNED",
  "> PWNED",
  "< /etc/passwd",
  "*",
  "?",
  "[a]",
  "~",
  "$HOME",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal shell parameter expansion is exactly the hostile input under test.
  "${HOME}",
  "\\",
  "'\\''",
  "!",
  "#",
  "%s",
  "-rf",
  "--",
  "{projectPath}",
  "a b\tc",
  "",
  "../../etc",
  "abc‮def",
  "café",
  "rocket \u{1F680} launch",
  "x".repeat(4096),
];

/** mulberry32: a tiny, well-known 32-bit seeded PRNG. Deterministic across runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRINTABLE_ASCII: readonly string[] = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) =>
  String.fromCharCode(0x20 + i),
);
/** Unicode sample: tab, Latin-1, combining mark, bidi override, CJK, astral emoji, NBSP. */
const UNICODE_SAMPLE: readonly string[] = [
  "\t",
  "é",
  "ß",
  "́",
  "‮",
  "中",
  "文",
  "\u{1F680}",
  " ",
  "Ω",
];
const ALPHABET: readonly string[] = [...PRINTABLE_ASCII, ...UNICODE_SAMPLE];

function generateRandomCorpus(count: number, seed: number): string[] {
  const next = mulberry32(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const length = 1 + Math.floor(next() * 40);
    let value = "";
    for (let j = 0; j < length; j += 1) {
      value += ALPHABET[Math.floor(next() * ALPHABET.length)];
    }
    out.push(value);
  }
  return out;
}

const RANDOM_CORPUS = generateRandomCorpus(RANDOM_CASES, SEED);

// The stub stands in for `claude`: it records its argv (NUL-separated), one
// exported env value, and its physical working directory.
const STUB_BODY = [
  "#!/bin/sh",
  'printf \'%s\\0\' "$@" > "$CCC_PROOF_ARGS"',
  'printf \'%s\' "$CCC_PROOF_VALUE" > "$CCC_PROOF_ENV"',
  'pwd -P > "$CCC_PROOF_CWD"',
  "",
].join("\n");

const execFileAsync = promisify(execFile);

let root = "";
let stubPath = "";
let fallbackDir = "";
let caseCounter = 0;
let executedCases = 0;

function canBeDirectoryName(value: string): boolean {
  return (
    value !== "" &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    Buffer.byteLength(value, "utf8") <= NAME_MAX_BYTES
  );
}

function findCanaries(dir: string): string[] {
  const entries = readdirSync(dir, { recursive: true, encoding: "utf8" });
  return entries.filter((entry) => basename(entry) === "PWNED");
}

interface ProofOutcome {
  /** The spawn/exit failure message, or null when the script exited 0. */
  readonly exitError: string | null;
  readonly args: string[] | null;
  readonly envValue: string | null;
  readonly cwd: string | null;
  readonly expectedCwd: string;
  readonly scriptStillExists: boolean;
  /** PWNED files under this case's own root and the shared fallback cwd (the only places the script ran). */
  readonly canaries: string[];
}

/** Renders a script for `argv` inside a case directory, executes it through its shebang, and reads back what the stub saw. */
async function runProof(
  values: readonly string[],
  envValue: string,
  dirName: string | null,
  poolSlot: number | null = null,
): Promise<ProofOutcome> {
  caseCounter += 1;
  const caseRoot = join(root, "cases", String(caseCounter));
  mkdirSync(caseRoot, { recursive: true });
  let cwd = fallbackDir;
  if (dirName !== null) {
    cwd = join(caseRoot, dirName);
    mkdirSync(cwd);
  }
  const argsFile = join(caseRoot, "args.bin");
  const envFile = join(caseRoot, "env.txt");
  const cwdFile = join(caseRoot, "cwd.txt");
  const scriptPath = join(caseRoot, "launch.command");

  const script = renderLaunchScript({
    cwd,
    argv: [stubPath, ...values],
    env: {
      CCC_PROOF_ARGS: argsFile,
      CCC_PROOF_ENV: envFile,
      CCC_PROOF_CWD: cwdFile,
      CCC_PROOF_VALUE: envValue,
    },
  });
  if (poolSlot === null) {
    writeFileSync(scriptPath, script, { flag: "wx", mode: 0o700 });
    chmodSync(scriptPath, 0o700);
  } else {
    const poolPath = join(root, "pool", String(poolSlot));
    writeFileSync(poolPath, script, { mode: 0o700 });
    linkSync(poolPath, scriptPath);
  }

  // Executed through the kernel shebang; nothing is inherited from this
  // process's environment except what is listed here. A spawn or exit
  // failure is recorded rather than thrown so it surfaces as an assertion.
  executedCases += 1;
  let exitError: string | null = null;
  try {
    await execFileAsync(scriptPath, [], {
      env: { PATH: "/usr/bin:/bin", SHELL: "/usr/bin/true" },
      timeout: 10_000,
    });
  } catch (err: unknown) {
    exitError = err instanceof Error ? err.message : String(err);
  }

  let args: string[] | null = null;
  if (existsSync(argsFile)) {
    args = readFileSync(argsFile, "utf8").split(NUL);
    // printf '%s\0' terminates every element, so the final split part is empty.
    args.pop();
  }
  const rawCwd = existsSync(cwdFile) ? readFileSync(cwdFile, "utf8") : null;
  return {
    exitError,
    args,
    envValue: existsSync(envFile) ? readFileSync(envFile, "utf8") : null,
    cwd: rawCwd?.endsWith("\n") ? rawCwd.slice(0, -1) : rawCwd,
    expectedCwd: realpathSync.native(cwd),
    scriptStillExists: existsSync(scriptPath),
    canaries: [...findCanaries(caseRoot), ...findCanaries(fallbackDir)],
  };
}

async function assertVerbatim(value: string, poolSlot: number | null = null): Promise<void> {
  const dirName = canBeDirectoryName(value) ? value : null;
  const outcome = await runProof([value], value, dirName, poolSlot);
  expect(outcome.args).toEqual([value]);
  expect(outcome.exitError).toBeNull();
  expect(outcome.envValue).toBe(value);
  expect(outcome.cwd).toBe(outcome.expectedCwd);
  if (dirName !== null) {
    expect(basename(outcome.expectedCwd)).toBe(dirName);
  }
  expect(outcome.scriptStillExists).toBe(false);
  expect(outcome.canaries).toEqual([]);
}

beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ccc-proof-")));
  mkdirSync(join(root, "bin"));
  stubPath = join(root, "bin", "claude-stub");
  writeFileSync(stubPath, STUB_BODY, { mode: 0o755 });
  chmodSync(stubPath, 0o755);
  fallbackDir = join(root, "plain dir 'q'");
  mkdirSync(fallbackDir);
  mkdirSync(join(root, "pool"));
});

afterAll(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
});

describe("launch script injection proof (D-17, PROJ-13)", () => {
  it.each(HOSTILE_CORPUS.map((value, i) => [i, value] as const))(
    "hostile case %i arrives verbatim as argv, env value and cwd",
    async (_i, value) => {
      await assertVerbatim(value);
    },
  );

  it("the whole hostile corpus arrives verbatim as one multi-element argv", async () => {
    const outcome = await runProof(HOSTILE_CORPUS, "$(touch PWNED)", null);
    expect(outcome.args).toEqual([...HOSTILE_CORPUS]);
    expect(outcome.exitError).toBeNull();
    expect(outcome.envValue).toBe("$(touch PWNED)");
    expect(outcome.scriptStillExists).toBe(false);
    expect(outcome.canaries).toEqual([]);
  });

  it(`${RANDOM_CASES} seeded random strings arrive verbatim`, async () => {
    // A generator or filter that silently produced nothing cannot pass.
    expect(RANDOM_CORPUS.length).toBeGreaterThanOrEqual(500);
    const before = executedCases;
    let directoryCases = 0;
    for (let start = 0; start < RANDOM_CORPUS.length; start += CONCURRENCY) {
      const batch = RANDOM_CORPUS.slice(start, start + CONCURRENCY);
      directoryCases += batch.filter(canBeDirectoryName).length;
      await Promise.all(batch.map((value, slot) => assertVerbatim(value, slot)));
    }
    expect(executedCases - before).toBe(RANDOM_CORPUS.length);
    // Most random strings are legal directory names, so the cwd path is exercised too.
    expect(directoryCases).toBeGreaterThan(RANDOM_CASES / 2);
  }, 120_000);

  it("no PWNED file exists anywhere under the temp root after every case ran", () => {
    expect(executedCases).toBeGreaterThanOrEqual(HOSTILE_CORPUS.length + 1 + RANDOM_CASES);
    expect(findCanaries(root)).toEqual([]);
  });

  it("a missing folder prints the constant message, exits 1, never runs the command and still self-deletes", async () => {
    const caseRoot = join(root, "missing-cwd");
    mkdirSync(caseRoot);
    const argsFile = join(caseRoot, "args.bin");
    const scriptPath = join(caseRoot, "launch.command");
    const missing = join(caseRoot, "gone $(touch PWNED)");
    const script = renderLaunchScript({
      cwd: missing,
      argv: [stubPath, "x"],
      env: {
        CCC_PROOF_ARGS: argsFile,
        CCC_PROOF_ENV: join(caseRoot, "e"),
        CCC_PROOF_CWD: join(caseRoot, "c"),
      },
    });
    writeFileSync(scriptPath, script, { flag: "wx", mode: 0o700 });
    let exitCode: unknown = 0;
    let stdout = "";
    try {
      await execFileAsync(scriptPath, [], {
        env: { PATH: "/usr/bin:/bin", SHELL: "/usr/bin/true" },
      });
    } catch (err: unknown) {
      exitCode = (err as { code?: unknown }).code;
      stdout = String((err as { stdout?: unknown }).stdout ?? "");
    }
    expect(exitCode).toBe(1);
    expect(stdout).toBe(`${CD_FAILED_MESSAGE}\n`);
    expect(existsSync(argsFile)).toBe(false);
    expect(existsSync(scriptPath)).toBe(false);
    expect(findCanaries(caseRoot)).toEqual([]);
  });

  it("refuses NUL, CR and LF before any script exists", () => {
    for (const bad of [`a${NUL}b`, "a\nb", "a\rb"]) {
      expect(() => renderLaunchScript({ cwd: fallbackDir, argv: [stubPath, bad] })).toThrow(
        UnsafeScriptArgumentError,
      );
      expect(() => renderLaunchScript({ cwd: bad, argv: [stubPath] })).toThrow(
        UnsafeScriptArgumentError,
      );
    }
  });
});
