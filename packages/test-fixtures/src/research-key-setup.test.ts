// The owner-run key setup script (plan 07-10 Task 3, research Pitfall 16): the Anthropic key is
// stored in the macOS Keychain from standard input, never from argv, and `--check` reports whether
// it is set without printing it. These tests inject a secret-store stub; none touches the real
// Keychain, and the key-shaped strings here are dummies.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RESEARCH_API_KEY_ACCOUNT } from "@ccc/service/research-summariser";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "research-key-setup.mjs");
const SERVICE = "com.claude-command-center";
const DUMMY_KEY = "dummy-key-not-real_0123456789";

interface Deps {
  argv: string[];
  readKey: () => Promise<string>;
  store: {
    get(account: string): Promise<string | null>;
    set(account: string, value: string): Promise<void>;
  };
  serviceName: string;
  out: (line: string) => void;
  err: (line: string) => void;
}
interface ScriptModule {
  main(deps: Deps): Promise<number>;
  readKeyFromStream(stream: AsyncIterable<Buffer | string>): Promise<string>;
  RESEARCH_KEY_ACCOUNT: string;
}

async function load(): Promise<ScriptModule> {
  return (await import(pathToFileURL(SCRIPT).href)) as ScriptModule;
}

interface Harness {
  deps: Deps;
  sets: { account: string; value: string }[];
  gets: string[];
  stdout: string[];
  stderr: string[];
  keyReads: number;
}

function harness(
  options: { argv?: string[]; key?: string; stored?: string | null; setError?: Error } = {},
): Harness {
  const h: Harness = {
    sets: [],
    gets: [],
    stdout: [],
    stderr: [],
    keyReads: 0,
    deps: undefined as never,
  };
  h.deps = {
    argv: options.argv ?? [],
    readKey: async () => {
      h.keyReads += 1;
      return options.key ?? DUMMY_KEY;
    },
    store: {
      async get(account) {
        h.gets.push(account);
        return options.stored ?? null;
      },
      async set(account, value) {
        if (options.setError !== undefined) throw options.setError;
        h.sets.push({ account, value });
      },
    },
    serviceName: SERVICE,
    out: (line) => h.stdout.push(line),
    err: (line) => h.stderr.push(line),
  };
  return h;
}

const everything = (h: Harness): string => [...h.stdout, ...h.stderr].join("\n");

describe("Test 1: an argument that is not --check or --help is refused", () => {
  for (const argv of [
    [DUMMY_KEY],
    ["--key", DUMMY_KEY],
    [`--key=${DUMMY_KEY}`],
    ["-w", DUMMY_KEY],
    ["--check", DUMMY_KEY],
    ["--help", "--check"],
    ["--check", "--check"],
    [""],
    ["--HELP"],
    ["-h"],
  ]) {
    it(`refuses ${JSON.stringify(argv).replace(DUMMY_KEY, "<arg>")}`, async () => {
      const { main } = await load();
      const h = harness({ argv });
      const code = await main(h.deps);
      expect(code).not.toBe(0);
      expect(h.sets).toEqual([]);
      expect(h.gets).toEqual([]);
      expect(h.keyReads).toBe(0);
      expect(everything(h)).not.toContain(DUMMY_KEY);
      expect(h.stderr.join("\n")).toContain("standard input");
    });
  }

  it("a spawned process with a stray argument exits non-zero and echoes nothing", () => {
    const result = spawnSync(process.execPath, [SCRIPT, DUMMY_KEY], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(DUMMY_KEY);
  });
});

describe("Test 2: the key from standard input is stored once", () => {
  it("passes the key to set(account, key) and names the account and service, never the key", async () => {
    const { main } = await load();
    const h = harness();
    const code = await main(h.deps);
    expect(code).toBe(0);
    expect(h.sets).toEqual([{ account: RESEARCH_API_KEY_ACCOUNT, value: DUMMY_KEY }]);
    expect(h.keyReads).toBe(1);
    const text = everything(h);
    expect(text).toContain(RESEARCH_API_KEY_ACCOUNT);
    expect(text).toContain(SERVICE);
    expect(text).not.toContain(DUMMY_KEY);
  });

  it("an empty key stores nothing", async () => {
    const { main } = await load();
    for (const key of ["", "\n"]) {
      const h = harness({ key });
      const code = await main(h.deps);
      expect(code).not.toBe(0);
      expect(h.sets).toEqual([]);
    }
  });

  it("a store failure is reported with a fixed message and no detail, and exits non-zero", async () => {
    const { main } = await load();
    const h = harness({ setError: new Error(`security said ${DUMMY_KEY}`) });
    const code = await main(h.deps);
    expect(code).not.toBe(0);
    expect(everything(h)).not.toContain(DUMMY_KEY);
    expect(h.stderr.join("\n")).toContain("could not store");
  });

  it("the script's account literal equals the service's constant", async () => {
    const mod = await load();
    expect(mod.RESEARCH_KEY_ACCOUNT).toBe(RESEARCH_API_KEY_ACCOUNT);
  });
});

describe("the key reader trims one trailing newline and nothing else", () => {
  it("reads a piped stream", async () => {
    const { readKeyFromStream } = await load();
    expect(await readKeyFromStream(Readable.from([Buffer.from(`${DUMMY_KEY}\n`)]))).toBe(DUMMY_KEY);
    expect(await readKeyFromStream(Readable.from([Buffer.from(`${DUMMY_KEY}\r\n`)]))).toBe(
      DUMMY_KEY,
    );
    expect(await readKeyFromStream(Readable.from([Buffer.from("ab"), Buffer.from("cd\n")]))).toBe(
      "abcd",
    );
    expect(await readKeyFromStream(Readable.from([Buffer.from(` ${DUMMY_KEY} \n`)]))).toBe(
      ` ${DUMMY_KEY} `,
    );
    expect(await readKeyFromStream(Readable.from([Buffer.from("a\n\n")]))).toBe("a\n");
  });

  it("refuses an unreasonably long input", async () => {
    const { readKeyFromStream } = await load();
    await expect(readKeyFromStream(Readable.from([Buffer.alloc(4096, 0x61)]))).rejects.toThrow(
      /too long/,
    );
  });
});

describe("Test 3: --check reports configured or not configured", () => {
  it("configured when the store holds a value, without printing it", async () => {
    const { main } = await load();
    const h = harness({ argv: ["--check"], stored: DUMMY_KEY });
    const code = await main(h.deps);
    expect(code).toBe(0);
    expect(h.gets).toEqual([RESEARCH_API_KEY_ACCOUNT]);
    expect(h.sets).toEqual([]);
    expect(h.keyReads).toBe(0);
    expect(h.stdout).toEqual([
      `research API key: configured (account ${RESEARCH_API_KEY_ACCOUNT})`,
    ]);
    expect(everything(h)).not.toContain(DUMMY_KEY);
  });

  it("not configured when the store holds nothing", async () => {
    const { main } = await load();
    const h = harness({ argv: ["--check"], stored: null });
    const code = await main(h.deps);
    expect(code).not.toBe(0);
    expect(h.stdout).toEqual([
      `research API key: not configured (account ${RESEARCH_API_KEY_ACCOUNT})`,
    ]);
  });

  it("an empty stored value counts as not configured", async () => {
    const { main } = await load();
    const h = harness({ argv: ["--check"], stored: "" });
    await main(h.deps);
    expect(h.stdout.join("")).toContain("not configured");
  });
});

describe("Test 4: a key the keychain wrapper refuses", () => {
  it("exits non-zero with the fixed message and does not echo the key", async () => {
    const { main } = await load();
    const refusal = Object.assign(new Error(`value does not match ${DUMMY_KEY}`), {
      name: "UnsafeSecretInputError",
    });
    const h = harness({ setError: refusal, key: DUMMY_KEY });
    const code = await main(h.deps);
    expect(code).not.toBe(0);
    expect(h.stderr).toContain("the key contains characters the keychain wrapper refuses");
    expect(everything(h)).not.toContain(DUMMY_KEY);
  });
});

describe("Test 5: --help", () => {
  it("says the key is read from standard input, that macOS may ask once, and names the account", async () => {
    const { main } = await load();
    const h = harness({ argv: ["--help"] });
    const code = await main(h.deps);
    expect(code).toBe(0);
    const text = h.stdout.join("\n");
    expect(text).toContain("standard input");
    expect(text).toMatch(/macOS may ask once to allow keychain access/);
    expect(text).toContain(RESEARCH_API_KEY_ACCOUNT);
    expect(text).toContain("--check");
    expect(h.sets).toEqual([]);
    expect(h.keyReads).toBe(0);
  });

  it("`node scripts/research-key-setup.mjs --help` exits 0 and names the account", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "--help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(RESEARCH_API_KEY_ACCOUNT);
  });
});

describe("the script's source", () => {
  const source = readFileSync(SCRIPT, "utf8");

  it("reaches the Keychain only through the keychain wrapper", () => {
    expect(source).not.toMatch(/add-generic-password|find-generic-password/);
    expect(source).not.toMatch(/child_process|execa|spawn|exec\(/);
  });

  it("never passes an argument to the store", () => {
    expect(source).not.toMatch(/set\([^)]*argv/);
    expect(source).not.toMatch(/process\.argv\[[2-9]\]/);
  });
});
