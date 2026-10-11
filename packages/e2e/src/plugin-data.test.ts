import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertPluginDataKeys,
  buildPluginData,
  PLUGIN_DATA_KEYS,
  PLUGIN_ID,
  seedPluginData,
  stagePlugin,
} from "./plugin-data.js";

const SOCKET = "/tmp/ccc-uat-x/svc.sock";
let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ccc-plugin-data-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const mode = (path: string) => statSync(path).mode & 0o777;

describe("buildPluginData and assertPluginDataKeys (Test 1)", () => {
  it("returns exactly the four settings keys, pointing at the sandbox socket", () => {
    expect(buildPluginData({ socketPath: SOCKET })).toEqual({
      socketPathOverride: SOCKET,
      lastOpenedDestination: "overview",
      reducedMotion: "auto",
      notifyApprovals: true,
    });
    expect([...PLUGIN_DATA_KEYS].sort()).toEqual(
      ["lastOpenedDestination", "notifyApprovals", "reducedMotion", "socketPathOverride"].sort(),
    );
  });

  it("refuses an empty or relative socket path", () => {
    expect(() => buildPluginData({ socketPath: "" })).toThrow();
    expect(() => buildPluginData({ socketPath: "svc.sock" })).toThrow();
  });

  it("rejects an extra key and any credential-shaped key", () => {
    const base = buildPluginData({ socketPath: SOCKET });
    expect(() => assertPluginDataKeys(base)).not.toThrow();
    expect(() => assertPluginDataKeys({ ...base, extra: 1 })).toThrow();
    for (const key of ["token", "installSecret", "Password", "authorization"]) {
      expect(() => assertPluginDataKeys({ ...base, [key]: "x" })).toThrow();
    }
  });

  it("rejects a missing key", () => {
    const { notifyApprovals: _omit, ...rest } = buildPluginData({ socketPath: SOCKET });
    expect(() => assertPluginDataKeys(rest)).toThrow();
  });
});

describe("seedPluginData (Test 1)", () => {
  it("writes data.json at mode 0600 inside the vault's plugin folder", () => {
    const vault = join(root, "vaults", "live");
    mkdirSync(vault, { recursive: true });
    const written = seedPluginData({
      runRoot: root,
      vaultDir: vault,
      data: buildPluginData({ socketPath: SOCKET }),
    });
    expect(written).toBe(join(vault, ".obsidian", "plugins", PLUGIN_ID, "data.json"));
    expect(mode(written)).toBe(0o600);
    expect(JSON.parse(readFileSync(written, "utf8"))).toEqual(
      buildPluginData({ socketPath: SOCKET }),
    );
  });

  it("refuses a vault folder outside the run root, before writing anything", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "ccc-outside-")));
    try {
      expect(() =>
        seedPluginData({
          runRoot: root,
          vaultDir: outside,
          data: buildPluginData({ socketPath: SOCKET }),
        }),
      ).toThrow(/run root/);
      expect(existsSync(join(outside, ".obsidian"))).toBe(false);
      // The run root itself is not "inside" itself.
      expect(() =>
        seedPluginData({
          runRoot: root,
          vaultDir: root,
          data: buildPluginData({ socketPath: SOCKET }),
        }),
      ).toThrow(/run root/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a vault folder that reaches outside through a dot-dot segment", () => {
    mkdirSync(join(root, "vaults"), { recursive: true });
    expect(() =>
      seedPluginData({
        runRoot: join(root, "vaults"),
        vaultDir: join(root, "vaults", "..", "elsewhere"),
        data: buildPluginData({ socketPath: SOCKET }),
      }),
    ).toThrow(/run root/);
  });

  it("refuses data that fails the key check", () => {
    const vault = join(root, "vaults", "live");
    mkdirSync(vault, { recursive: true });
    expect(() =>
      seedPluginData({
        runRoot: root,
        vaultDir: vault,
        data: { ...buildPluginData({ socketPath: SOCKET }), token: "x" } as never,
      }),
    ).toThrow();
    expect(existsSync(join(vault, ".obsidian"))).toBe(false);
  });
});

describe("seedPluginData and links (Codex re-review finding 1)", () => {
  it("refuses a plugin folder or data.json that is a link, leaving the target alone", () => {
    for (const linkAt of ["plugin-folder", "data-json", "obsidian"]) {
      const vault = join(root, "vaults", `v-${linkAt}`);
      const owner = join(root, `owner-${linkAt}`);
      mkdirSync(join(owner, "plugins", PLUGIN_ID), { recursive: true });
      mkdirSync(vault, { recursive: true });
      if (linkAt === "obsidian") {
        symlinkSync(owner, join(vault, ".obsidian"));
      } else if (linkAt === "plugin-folder") {
        mkdirSync(join(vault, ".obsidian", "plugins"), { recursive: true });
        symlinkSync(
          join(owner, "plugins", PLUGIN_ID),
          join(vault, ".obsidian", "plugins", PLUGIN_ID),
        );
      } else {
        mkdirSync(join(vault, ".obsidian", "plugins", PLUGIN_ID), { recursive: true });
        writeFileSync(join(owner, "data.json"), "owner");
        symlinkSync(
          join(owner, "data.json"),
          join(vault, ".obsidian", "plugins", PLUGIN_ID, "data.json"),
        );
      }
      expect(() =>
        seedPluginData({
          runRoot: root,
          vaultDir: vault,
          data: buildPluginData({ socketPath: SOCKET }),
        }),
      ).toThrow(/symbolic link/);
      expect(readdirSync(join(owner, "plugins", PLUGIN_ID))).toEqual([]);
      if (linkAt === "data-json")
        expect(readFileSync(join(owner, "data.json"), "utf8")).toBe("owner");
    }
  });
});

describe("stagePlugin (Test 2)", () => {
  function makeBuild(extra: Record<string, string> = {}): string {
    const build = join(root, "build");
    mkdirSync(build, { recursive: true });
    writeFileSync(join(build, "main.js"), "// main");
    writeFileSync(join(build, "manifest.json"), '{"id":"x"}');
    writeFileSync(join(build, "styles.css"), "/* css */");
    for (const [name, body] of Object.entries(extra)) writeFileSync(join(build, name), body);
    return build;
  }

  it("copies exactly the three build outputs, ignoring data.json and layout.json", () => {
    const build = makeBuild({ "data.json": "{}", "layout.json": "{}", "package.json": "{}" });
    const stage = join(root, "stage");
    stagePlugin({ buildDir: build, stageDir: stage });
    expect(readdirSync(stage).sort()).toEqual(["main.js", "manifest.json", "styles.css"]);
    expect(mode(stage)).toBe(0o700);
    for (const name of readdirSync(stage)) expect(mode(join(stage, name))).toBe(0o600);
    expect(readFileSync(join(stage, "main.js"), "utf8")).toBe("// main");
  });

  it("throws a fixed message naming the missing file", () => {
    const build = makeBuild();
    rmSync(join(build, "styles.css"));
    expect(() => stagePlugin({ buildDir: build, stageDir: join(root, "stage") })).toThrow(
      "Plugin build output is missing styles.css; build the plugin first.",
    );
    expect(existsSync(join(root, "stage"))).toBe(false);
  });

  it("refuses a stage folder that already holds files", () => {
    const build = makeBuild();
    const stage = join(root, "stage");
    mkdirSync(stage);
    writeFileSync(join(stage, "data.json"), "{}");
    expect(() => stagePlugin({ buildDir: build, stageDir: stage })).toThrow(/not empty/);
  });

  it("refuses a stage folder that is a link to an empty folder elsewhere", () => {
    const build = makeBuild();
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    const stage = join(root, "stage-link");
    symlinkSync(elsewhere, stage);
    expect(() => stagePlugin({ buildDir: build, stageDir: stage })).toThrow(/symbolic link/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});
