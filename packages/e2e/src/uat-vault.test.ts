import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GENERATOR_SCRIPT } from "./repo-paths.js";
import {
  generateUatVault,
  parseGeneratedCount,
  UAT_CLOCK,
  UAT_SEED,
  UAT_ZONE,
} from "./uat-vault.js";

const SOCKET = "/tmp/ccc-uat-y/svc.sock";
let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ccc-uat-vault-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("constants and output parsing", () => {
  it("pins a fixed seed, an instant on 2026-10-08 and the UTC zone", () => {
    expect(UAT_SEED).toMatch(/^[0-9]{1,9}$/);
    expect(UAT_CLOCK.startsWith("2026-10-08T")).toBe(true);
    expect(UAT_CLOCK.endsWith("Z")).toBe(true);
    expect(UAT_ZONE).toBe("UTC");
  });

  it("parses the generated-N line and rejects anything else with a fixed message", () => {
    expect(
      parseGeneratedCount("generated 300 task notes plus 6 live-check notes in 4 scopes\n"),
    ).toBe(300);
    expect(parseGeneratedCount("generated 12 task notes in 2 scopes")).toBe(12);
    expect(() => parseGeneratedCount("nothing here")).toThrow(
      "Vault generator output was not understood.",
    );
  });
});

describe("generateUatVault with the real generator (Test 3)", () => {
  it("creates <runRoot>/vaults/live, seeds the plugin data and returns the facts", async () => {
    const result = await generateUatVault({
      runRoot: root,
      kind: "live",
      profile: "standard",
      socketPath: SOCKET,
      countOverride: 7,
    });
    expect(result.vaultPath).toBe(join(root, "vaults", "live"));
    expect(result.taskCount).toBe(7);
    expect(result.clock).toBe(UAT_CLOCK);
    expect(readdirSync(result.vaultPath).length).toBeGreaterThan(1);
    const data = JSON.parse(
      readFileSync(
        join(result.vaultPath, ".obsidian", "plugins", "claude-command-center", "data.json"),
        "utf8",
      ),
    );
    expect(data.socketPathOverride).toBe(SOCKET);
  }, 60000);

  it("throws before running the generator for an output folder outside the run root", async () => {
    let ran = false;
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "ccc-outside-")));
    try {
      await expect(
        generateUatVault({
          runRoot: root,
          kind: "live",
          profile: "standard",
          socketPath: SOCKET,
          outDir: join(outside, "live"),
          deps: {
            runGenerator: async () => {
              ran = true;
              return { stdout: "" };
            },
          },
        }),
      ).rejects.toThrow(/run root/);
      expect(ran).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("throws before running the generator for a non-empty existing folder", async () => {
    let ran = false;
    const dir = join(root, "vaults", "live");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "keep.md"), "x");
    await expect(
      generateUatVault({
        runRoot: root,
        kind: "live",
        profile: "standard",
        socketPath: SOCKET,
        deps: {
          runGenerator: async () => {
            ran = true;
            return { stdout: "" };
          },
        },
      }),
    ).rejects.toThrow(/not empty/);
    expect(ran).toBe(false);
    expect(existsSync(join(dir, ".obsidian"))).toBe(false);
  });
});

describe("profile guard (Test 4)", () => {
  it("refuses the big vault unless the profile is full, and never runs the generator", async () => {
    let ran = false;
    await expect(
      generateUatVault({
        runRoot: root,
        kind: "big",
        profile: "standard",
        socketPath: SOCKET,
        deps: {
          runGenerator: async () => {
            ran = true;
            return { stdout: "" };
          },
        },
      }),
    ).rejects.toThrow("The 10,000-task vault is only generated with --profile full.");
    expect(ran).toBe(false);
    expect(existsSync(join(root, "vaults"))).toBe(false);
  });

  it("runs the generator for big with profile full: count 10000, no live-check flag", async () => {
    const calls: string[][] = [];
    const result = await generateUatVault({
      runRoot: root,
      kind: "big",
      profile: "full",
      socketPath: SOCKET,
      deps: {
        runGenerator: async (argv) => {
          calls.push([...argv]);
          return { stdout: "generated 10000 task notes in 9 scopes\n" };
        },
      },
    });
    expect(calls).toHaveLength(1);
    const argv = calls[0] ?? [];
    expect(argv[0]).toBe(GENERATOR_SCRIPT);
    const flag = (name: string) => argv[argv.indexOf(name) + 1];
    expect(flag("--out")).toBe(join(root, "vaults", "big"));
    expect(flag("--count")).toBe("10000");
    expect(flag("--seed")).toBe(UAT_SEED);
    expect(flag("--clock")).toBe(UAT_CLOCK);
    expect(flag("--zone")).toBe(UAT_ZONE);
    expect(argv).not.toContain("--live-check");
    expect(result.taskCount).toBe(10000);
  });

  it("runs live with count 300 and the live-check flag by default", async () => {
    const calls: string[][] = [];
    await generateUatVault({
      runRoot: root,
      kind: "live",
      profile: "standard",
      socketPath: SOCKET,
      deps: {
        runGenerator: async (argv) => {
          calls.push([...argv]);
          return { stdout: "generated 300 task notes plus 6 live-check notes in 4 scopes\n" };
        },
      },
    });
    const argv = calls[0] ?? [];
    expect(argv[argv.indexOf("--count") + 1]).toBe("300");
    expect(argv).toContain("--live-check");
  });
});
