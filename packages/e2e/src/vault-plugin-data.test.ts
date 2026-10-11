import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  evaluateSocketIsolation,
  isolatePluginData,
  MSG_DATA_MALFORMED,
  MSG_DATA_VERIFY,
  MSG_PATH_LINK,
  MSG_SOCKET_OUTSIDE,
  MSG_VAULT_OUTSIDE,
  PLUGIN_DATA_RELATIVE,
  type PluginDataFs,
  planPluginData,
} from "./vault-plugin-data.js";

// Run roots must be a direct child of /tmp named ccc-uat.*, so the real-filesystem tests make one.
const created: string[] = [];
function makeRunRoot(): string {
  const root = realpathSync(mkdtempSync("/tmp/ccc-uat."));
  created.push(root);
  return root;
}
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

const HOME = "/Users/USERNAME";

function setup(): { runRoot: string; vault: string; socket: string; dataPath: string } {
  const runRoot = makeRunRoot();
  const vault = join(runRoot, "vaults", "live");
  mkdirSync(vault, { recursive: true });
  return {
    runRoot,
    vault,
    socket: join(runRoot, "svc.sock"),
    dataPath: join(vault, PLUGIN_DATA_RELATIVE),
  };
}

const read = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

describe("planPluginData (pure merge, Codex finding 1)", () => {
  it("creates the settings object when there is no data.json", () => {
    const plan = planPluginData(null, "/tmp/ccc-uat.X/svc.sock");
    expect(JSON.parse(plan.text)).toEqual({ socketPathOverride: "/tmp/ccc-uat.X/svc.sock" });
    expect(plan.replacedPrevious).toBe(false);
  });

  it("replaces a conflicting socketPathOverride and keeps every other key", () => {
    const live = "/Users/USERNAME/.claude-command-center/svc.sock";
    const plan = planPluginData(
      JSON.stringify({ socketPathOverride: live, reducedMotion: "reduce", notifyApprovals: true }),
      "/tmp/ccc-uat.X/svc.sock",
    );
    expect(JSON.parse(plan.text)).toEqual({
      socketPathOverride: "/tmp/ccc-uat.X/svc.sock",
      reducedMotion: "reduce",
      notifyApprovals: true,
    });
    expect(plan.replacedPrevious).toBe(true);
  });

  it("does not count an already identical or null value as a replacement", () => {
    expect(
      planPluginData(JSON.stringify({ socketPathOverride: "/s" }), "/s").replacedPrevious,
    ).toBe(false);
    expect(
      planPluginData(JSON.stringify({ socketPathOverride: null }), "/s").replacedPrevious,
    ).toBe(false);
  });

  it("refuses unparsable text and any non-object JSON without echoing it", () => {
    for (const text of ["{nope", "[]", "null", '"str"', "12"]) {
      expect(() => planPluginData(text, "/s")).toThrowError(MSG_DATA_MALFORMED);
    }
  });
});

describe("isolatePluginData (writes the sandbox vault's data.json before launch)", () => {
  it("writes a data.json whose socketPathOverride equals CCC_SOCKET_PATH when none exists", () => {
    const { runRoot, vault, socket, dataPath } = setup();
    const result = isolatePluginData({ vaultPath: vault, runRoot, socketPath: socket });
    expect(read(dataPath)).toEqual({ socketPathOverride: socket });
    expect(result.replacedPrevious).toBe(false);
  });

  it("replaces a persisted override that points at the owner's live socket, keeping other keys", () => {
    const { runRoot, vault, socket, dataPath } = setup();
    mkdirSync(dirname(dataPath), { recursive: true });
    writeFileSync(
      dataPath,
      JSON.stringify({
        socketPathOverride: `${HOME}/.claude-command-center/svc.sock`,
        lastOpenedDestination: "tasks",
      }),
    );
    const result = isolatePluginData({ vaultPath: vault, runRoot, socketPath: socket });
    expect(read(dataPath)).toEqual({ socketPathOverride: socket, lastOpenedDestination: "tasks" });
    expect(result.replacedPrevious).toBe(true);
  });

  it("refuses a socket outside the run root, the live socket and a socket reached through a link", () => {
    const { runRoot, vault, dataPath } = setup();
    const outside = makeRunRoot();
    for (const socketPath of [
      join(outside, "svc.sock"),
      runRoot,
      "relative.sock",
      join(HOME, ".claude-command-center", "svc.sock"),
    ]) {
      expect(() =>
        isolatePluginData({ vaultPath: vault, runRoot, socketPath, homeDir: HOME }),
      ).toThrowError(MSG_SOCKET_OUTSIDE);
    }
    // a directory inside the run root that links out of it
    symlinkSync(outside, join(runRoot, "linked"));
    expect(() =>
      isolatePluginData({ vaultPath: vault, runRoot, socketPath: join(runRoot, "linked", "s") }),
    ).toThrowError(MSG_SOCKET_OUTSIDE);
    expect(existsSync(dataPath)).toBe(false);
  });

  it("refuses a vault outside the run root, including one reached through a link", () => {
    const { runRoot, socket } = setup();
    const outside = makeRunRoot();
    symlinkSync(outside, join(runRoot, "vlink"));
    for (const vaultPath of [outside, join(runRoot, "vlink"), runRoot]) {
      expect(() => isolatePluginData({ vaultPath, runRoot, socketPath: socket })).toThrowError(
        MSG_VAULT_OUTSIDE,
      );
    }
    expect(existsSync(join(outside, PLUGIN_DATA_RELATIVE))).toBe(false);
  });

  it("refuses a malformed existing data.json and leaves it untouched", () => {
    const { runRoot, vault, socket, dataPath } = setup();
    mkdirSync(dirname(dataPath), { recursive: true });
    writeFileSync(dataPath, "{broken");
    expect(() => isolatePluginData({ vaultPath: vault, runRoot, socketPath: socket })).toThrowError(
      MSG_DATA_MALFORMED,
    );
    expect(readFileSync(dataPath, "utf8")).toBe("{broken");
  });

  it("verifies after the write and fails loudly when the file does not hold the isolated socket", () => {
    const { runRoot, vault, socket } = setup();
    const lying: PluginDataFs = {
      readFile: () => JSON.stringify({ socketPathOverride: "/somewhere/else.sock" }),
      writeFileAtomic: () => undefined,
      mkdirp: () => undefined,
      isSymlink: () => false,
    };
    expect(() =>
      isolatePluginData({ vaultPath: vault, runRoot, socketPath: socket, fs: lying }),
    ).toThrowError(MSG_DATA_VERIFY);
  });
});

describe("isolatePluginData refuses a link on the way to data.json (Codex re-review finding 1)", () => {
  // An owner plugin folder that holds a data.json the run must never touch.
  function ownerPluginDir(): { dir: string; dataPath: string; before: string } {
    const owner = makeRunRoot();
    const dir = join(owner, "owner-plugin");
    mkdirSync(dir, { recursive: true });
    const dataPath = join(dir, "data.json");
    const before = JSON.stringify({ socketPathOverride: "/owner/live.sock", keep: 1 });
    writeFileSync(dataPath, before);
    return { dir, dataPath, before };
  }

  const run = (vault: string, runRoot: string, socket: string): void => {
    isolatePluginData({ vaultPath: vault, runRoot, socketPath: socket });
  };

  it("refuses a plugin folder that links to an owner folder and leaves the owner file alone", () => {
    const { runRoot, vault, socket } = setup();
    const owner = ownerPluginDir();
    mkdirSync(join(vault, ".obsidian", "plugins"), { recursive: true });
    symlinkSync(owner.dir, join(vault, ".obsidian", "plugins", "claude-command-center"));
    expect(() => run(vault, runRoot, socket)).toThrowError(MSG_PATH_LINK);
    expect(readFileSync(owner.dataPath, "utf8")).toBe(owner.before);
    expect(readdirSync(owner.dir)).toEqual(["data.json"]);
  });

  it("refuses a link at .obsidian or at plugins, whatever they point at", () => {
    for (const linked of [[".obsidian"], [".obsidian", "plugins"]]) {
      const { runRoot, vault, socket } = setup();
      const owner = ownerPluginDir();
      const target = join(vault, ...linked);
      mkdirSync(dirname(target), { recursive: true });
      // the link target is an owner tree that already holds plugins/claude-command-center
      const tree = join(dirname(owner.dir), "tree");
      mkdirSync(join(tree, "plugins", "claude-command-center"), { recursive: true });
      mkdirSync(join(tree, "claude-command-center"), { recursive: true });
      symlinkSync(tree, target);
      expect(() => run(vault, runRoot, socket)).toThrowError(MSG_PATH_LINK);
      expect(readdirSync(join(tree, "plugins", "claude-command-center"))).toEqual([]);
      expect(readdirSync(join(tree, "claude-command-center"))).toEqual([]);
    }
  });

  it("refuses a link that stays inside the run root too (no link is trusted)", () => {
    const { runRoot, vault, socket } = setup();
    const inside = join(runRoot, "elsewhere");
    mkdirSync(inside, { recursive: true });
    mkdirSync(join(vault, ".obsidian", "plugins"), { recursive: true });
    symlinkSync(inside, join(vault, ".obsidian", "plugins", "claude-command-center"));
    expect(() => run(vault, runRoot, socket)).toThrowError(MSG_PATH_LINK);
    expect(readdirSync(inside)).toEqual([]);
  });

  it("refuses a dangling link at the plugin folder", () => {
    const { runRoot, vault, socket } = setup();
    mkdirSync(join(vault, ".obsidian", "plugins"), { recursive: true });
    symlinkSync(
      join(runRoot, "does-not-exist"),
      join(vault, ".obsidian", "plugins", "claude-command-center"),
    );
    expect(() => run(vault, runRoot, socket)).toThrowError(MSG_PATH_LINK);
    expect(existsSync(join(runRoot, "does-not-exist"))).toBe(false);
  });

  it("refuses data.json itself being a link and leaves its target alone", () => {
    const { runRoot, vault, socket, dataPath } = setup();
    const owner = ownerPluginDir();
    mkdirSync(dirname(dataPath), { recursive: true });
    symlinkSync(owner.dataPath, dataPath);
    expect(() => run(vault, runRoot, socket)).toThrowError(MSG_PATH_LINK);
    expect(readFileSync(owner.dataPath, "utf8")).toBe(owner.before);
  });

  it("checks before reading or writing anything", () => {
    const { runRoot, vault, socket } = setup();
    const calls: string[] = [];
    const spy: PluginDataFs = {
      readFile: (path) => (calls.push(`read ${path}`), null),
      writeFileAtomic: (path) => void calls.push(`write ${path}`),
      mkdirp: (path) => void calls.push(`mkdirp ${path}`),
      isSymlink: (path) => path.endsWith("plugins"),
    };
    expect(() =>
      isolatePluginData({ vaultPath: vault, runRoot, socketPath: socket, fs: spy }),
    ).toThrowError(MSG_PATH_LINK);
    expect(calls).toEqual([]);
  });

  it("still writes through plain directories", () => {
    const { runRoot, vault, socket, dataPath } = setup();
    mkdirSync(dirname(dataPath), { recursive: true });
    writeFileSync(dataPath, JSON.stringify({ reducedMotion: "auto" }));
    run(vault, runRoot, socket);
    expect(read(dataPath)).toEqual({ reducedMotion: "auto", socketPathOverride: socket });
  });
});

describe("evaluateSocketIsolation (the S0 and S1 gate)", () => {
  const expected = "/tmp/ccc-uat.X/svc.sock";

  it("passes only when the renderer env and the persisted override both equal the run-root socket", () => {
    expect(
      evaluateSocketIsolation({
        expected,
        seenByRenderer: expected,
        persistedOverride: expected,
      }).ok,
    ).toBe(true);
    // an absent override is acceptable: CCC_SOCKET_PATH then decides
    expect(
      evaluateSocketIsolation({ expected, seenByRenderer: expected, persistedOverride: null }).ok,
    ).toBe(true);
  });

  it("fails loudly on a missing, different or unreadable renderer value", () => {
    for (const seenByRenderer of [null, "/Users/USERNAME/.claude-command-center/svc.sock", ""]) {
      const verdict = evaluateSocketIsolation({
        expected,
        seenByRenderer,
        persistedOverride: expected,
      });
      expect(verdict.ok).toBe(false);
    }
  });

  it("fails on a persisted override that differs, even when the renderer env is right", () => {
    const verdict = evaluateSocketIsolation({
      expected,
      seenByRenderer: expected,
      persistedOverride: "/Users/USERNAME/.claude-command-center/svc.sock",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).not.toContain("USERNAME");
  });

  it("fails when the expected socket itself is not set", () => {
    expect(
      evaluateSocketIsolation({
        expected: undefined,
        seenByRenderer: null,
        persistedOverride: null,
      }).ok,
    ).toBe(false);
  });
});

describe("wdio.smoke.conf.ts and the smoke specs (source order)", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const conf = readFileSync(join(dir, "wdio.smoke.conf.ts"), "utf8");

  it("isolates the vault's plugin data after the env guards and before building capabilities", () => {
    const build = conf.indexOf("buildLaunchCapabilities({");
    const isolate = conf.indexOf("isolatePluginData(");
    const guard = conf.indexOf("assertIsolatedEnv(");
    expect(isolate).toBeGreaterThan(-1);
    expect(isolate).toBeGreaterThan(guard);
    expect(isolate).toBeLessThan(build);
  });

  it("makes S0 and S1 assert the socket isolation facts with the shared evaluator", () => {
    for (const file of ["smoke/smoke.e2e.ts", "smoke/spikes.e2e.ts"]) {
      expect(readFileSync(join(dir, file), "utf8"), file).toContain("evaluateSocketIsolation(");
    }
    const spikes = readFileSync(join(dir, "smoke/spikes.e2e.ts"), "utf8");
    // S1 must check isolation before it clicks the test-approval button
    expect(spikes.indexOf("evaluateSocketIsolation(")).toBeLessThan(
      spikes.indexOf("Send a test approval"),
    );
  });
});
