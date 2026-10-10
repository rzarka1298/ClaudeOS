import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodexBridgeStatusSchema } from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BridgeFixture, createBridgeFixture } from "../test-support/bridge-fixtures.js";
import {
  type BridgeStateFs,
  coveringWindow,
  coveringWindows,
  hasAgentCapability,
  nodeBridgeStateFs,
  readBridgeStatus,
  toBridgeStatusView,
} from "./bridge-state.js";

let fx: BridgeFixture;

beforeEach(() => {
  fx = createBridgeFixture();
});

afterEach(() => {
  fx.cleanup();
});

const status = (now?: number) =>
  readBridgeStatus({ env: {}, home: fx.home, ...(now === undefined ? {} : { now }) });

describe("readBridgeStatus classification", () => {
  it("no launcher is not-installed, even with a marker", async () => {
    fx.installMarker();
    const s = await status();
    expect(s.state).toBe("not-installed");
    expect(s.launcherPresent).toBe(false);
  });

  it("launcher and a marker with the agent capability and no windows is installed-idle", async () => {
    fx.installLauncher();
    fx.installMarker();
    const s = await status();
    expect(s.state).toBe("installed-idle");
    expect(s.protocol).toBe(2);
    expect(s.capabilities).toContain("agent");
    expect(s.windows).toEqual([]);
    expect(s.dir).toBe(fx.stateDir);
    expect(s.dirSource).toBe("primary");
  });

  it("a covering fresh current heartbeat is installed", async () => {
    fx.installLauncher();
    fx.installMarker();
    fx.simulator("current").heartbeat();
    const s = await status();
    expect(s.state).toBe("installed");
    expect(s.windows).toHaveLength(1);
    expect(s.windows[0]?.protocol).toBe(2);
    expect(s.windows[0]?.capabilities).toContain("agent");
    expect(await coveringWindow(s, fx.projectDir)).not.toBeNull();
  });

  it("a covering heartbeat with no protocol field (the installed 0.1.0 extension) is outdated", async () => {
    fx.installLauncher();
    fx.installMarker();
    fx.simulator("outdated").heartbeat();
    const s = await status();
    expect(s.state).toBe("outdated");
    expect(s.windows[0]?.protocol).toBeNull();
    expect(s.windows[0]?.capabilities).toBeNull();
    const covering = await coveringWindow(s, fx.projectDir);
    expect(covering).not.toBeNull();
    expect(hasAgentCapability(covering as NonNullable<typeof covering>)).toBe(false);
  });

  it("a marker without the agent capability is outdated", async () => {
    fx.installLauncher();
    fx.installMarker({ protocol: 1, capabilities: ["follow", "tui"] });
    const s = await status();
    expect(s.state).toBe("outdated");
    expect(s.protocol).toBe(1);
  });

  it("a launcher with neither a marker nor a heartbeat is outdated", async () => {
    fx.installLauncher();
    const s = await status();
    expect(s.state).toBe("outdated");
    expect(s.protocol).toBeNull();
    expect(s.capabilities).toBeNull();
  });

  it("a malformed marker counts as no marker", async () => {
    fx.installLauncher();
    mkdirSync(fx.stateDir, { recursive: true });
    writeFileSync(join(fx.stateDir, "protocol.json"), '{"protocol":"2"}');
    expect((await status()).state).toBe("outdated");
  });

  it("a stale heartbeat (older than 90 seconds) does not count as a window", async () => {
    fx.installLauncher();
    fx.installMarker();
    const now = Date.now();
    fx.simulator("current", { now: now - 120_000 }).heartbeat();
    const s = await status(now);
    expect(s.windows).toEqual([]);
    expect(s.state).toBe("installed-idle");
    expect(await coveringWindow(s, fx.projectDir)).toBeNull();
  });

  it("a heartbeat just inside the 90 seconds counts", async () => {
    fx.installLauncher();
    fx.installMarker();
    const now = Date.now();
    fx.simulator("current", { now: now - 89_000 }).heartbeat();
    expect((await status(now)).windows).toHaveLength(1);
  });

  it("a capable heartbeat without a marker proves the kit and is installed", async () => {
    fx.installLauncher();
    fx.simulator("current").heartbeat();
    expect((await status()).state).toBe("installed");
  });

  it("a closed window writes nothing", async () => {
    fx.installLauncher();
    fx.installMarker();
    fx.simulator("closed").heartbeat();
    expect((await status()).windows).toEqual([]);
  });

  it("an outdated window on another project still makes the overall state outdated, but does not cover this project", async () => {
    fx.installLauncher();
    fx.installMarker();
    const other = join(fx.base, "elsewhere");
    mkdirSync(other);
    fx.simulator("outdated", { folders: [other] }).heartbeat();
    const s = await status();
    expect(s.state).toBe("outdated");
    expect(await coveringWindows(s, fx.projectDir)).toEqual([]);
  });
});

describe("state directory candidates (R6, T-05.1-28)", () => {
  it("uses the primary directory from the service environment when it has the bridge", async () => {
    fx.installLauncher();
    const primary = join(fx.home, "custom-state", "codex-bridge");
    mkdirSync(primary, { recursive: true });
    writeFileSync(
      join(primary, "protocol.json"),
      JSON.stringify({ protocol: 2, capabilities: ["follow", "tui", "agent"], kit: "k" }),
    );
    const s = await readBridgeStatus({
      env: { XDG_STATE_HOME: join(fx.home, "custom-state") },
      home: fx.home,
    });
    expect(s.dir).toBe(primary);
    expect(s.dirSource).toBe("primary");
    expect(toBridgeStatusView(s).state).toBe("installed-idle");
  });

  it("falls back to the default under HOME when the primary has nothing, and reports different-folder", async () => {
    fx.installLauncher();
    fx.installMarker();
    const s = await readBridgeStatus({
      env: { XDG_STATE_HOME: join(fx.home, "custom-state") },
      home: fx.home,
    });
    expect(s.dir).toBe(fx.stateDir);
    expect(s.dirSource).toBe("default-fallback");
    expect(s.state).toBe("installed-idle");
    const view = toBridgeStatusView(s);
    expect(view.state).toBe("different-folder");
    expect(CodexBridgeStatusSchema.safeParse(view).success).toBe(true);
  });

  it("with nothing in either place the primary is kept and nothing is called a fallback", async () => {
    fx.installLauncher();
    const primary = join(fx.home, "custom-state", "codex-bridge");
    const s = await readBridgeStatus({
      env: { XDG_STATE_HOME: join(fx.home, "custom-state") },
      home: fx.home,
    });
    expect(s.dir).toBe(primary);
    expect(s.dirSource).toBe("primary");
    expect(s.state).toBe("outdated");
  });

  it("never accepts, or even reads, a candidate directory outside HOME", async () => {
    fx.installLauncher();
    fx.installMarker();
    const outside = join(fx.base, "outside-state");
    mkdirSync(join(outside, "codex-bridge"), { recursive: true });
    writeFileSync(
      join(outside, "codex-bridge", "protocol.json"),
      JSON.stringify({ protocol: 2, capabilities: ["follow", "tui", "agent"], kit: "k" }),
    );
    const touched: string[] = [];
    const real = nodeBridgeStateFs;
    const note = (p: string): string => {
      touched.push(p);
      return p;
    };
    const spy: BridgeStateFs = {
      readdir: (p) => real.readdir(note(p)),
      readFile: (p) => real.readFile(note(p)),
      stat: (p) => real.stat(note(p)),
      realpath: (p) => real.realpath(note(p)),
    };
    const s = await readBridgeStatus({ env: { XDG_STATE_HOME: outside }, home: fx.home, fs: spy });
    expect(s.dir).toBe(fx.stateDir);
    expect(touched.some((p) => p.startsWith(outside))).toBe(false);
    // The directory traversal spelling is the same outside directory.
    const traversal = await readBridgeStatus({
      env: { XDG_STATE_HOME: `${fx.home}/../outside-state` },
      home: fx.home,
      fs: spy,
    });
    expect(traversal.dir).toBe(fx.stateDir);
    expect(touched.some((p) => p.startsWith(outside))).toBe(false);
  });

  it("rejects a candidate under HOME that is a symlink to a directory outside HOME", async () => {
    fx.installLauncher();
    const outside = join(fx.base, "outside-state");
    mkdirSync(join(outside, "codex-bridge"), { recursive: true });
    writeFileSync(
      join(outside, "codex-bridge", "protocol.json"),
      JSON.stringify({ protocol: 2, capabilities: ["follow", "tui", "agent"], kit: "k" }),
    );
    symlinkSync(outside, join(fx.home, "linked-state"));
    const s = await readBridgeStatus({
      env: { XDG_STATE_HOME: join(fx.home, "linked-state") },
      home: fx.home,
    });
    expect(s.dir).toBe(fx.stateDir);
    expect(s.state).toBe("outdated");
  });

  it("a default bridge dir that is a symlink outside HOME is non-launchable and never read", async () => {
    fx.installLauncher();
    const outside = join(fx.base, "outside-bridge");
    mkdirSync(join(outside, "windows"), { recursive: true });
    writeFileSync(
      join(outside, "protocol.json"),
      JSON.stringify({ protocol: 2, capabilities: ["follow", "tui", "agent"], kit: "k" }),
    );
    mkdirSync(join(fx.home, ".local", "state"), { recursive: true });
    symlinkSync(outside, fx.stateDir);
    const reads: string[] = [];
    const fs: BridgeStateFs = {
      ...nodeBridgeStateFs,
      readFile(path) {
        reads.push(path);
        return nodeBridgeStateFs.readFile(path);
      },
      readdir(path) {
        reads.push(path);
        return nodeBridgeStateFs.readdir(path);
      },
    };
    const s = await readBridgeStatus({ env: {}, home: fx.home, fs });
    expect(s.launchable).toBe(false);
    expect(s.state).toBe("not-installed");
    expect(s.protocol).toBeNull();
    expect(s.windows).toEqual([]);
    expect(reads.some((p) => p.startsWith(fx.stateDir) || p.startsWith(outside))).toBe(false);
  });

  it("a relative XDG_STATE_HOME is ignored, as the bridge ignores it", async () => {
    fx.installLauncher();
    fx.installMarker();
    const s = await readBridgeStatus({ env: { XDG_STATE_HOME: "relative/dir" }, home: fx.home });
    expect(s.dir).toBe(fx.stateDir);
    expect(s.dirSource).toBe("primary");
  });
});

describe("toBridgeStatusView", () => {
  it("maps each state and reports the newest window time", async () => {
    fx.installLauncher();
    fx.installMarker();
    const idle = toBridgeStatusView(await status());
    expect(idle).toEqual({ state: "installed-idle", lastWindowAt: null });
    const t = Date.UTC(2026, 9, 10, 12, 0, 0);
    fx.simulator("current", { now: t - 5_000, key: "a" }).heartbeat();
    fx.simulator("current", { now: t - 1_000, key: "b" }).heartbeat();
    const live = toBridgeStatusView(await status(t));
    expect(live.state).toBe("installed");
    expect(live.lastWindowAt).toBe(new Date(t - 1_000).toISOString());
    expect(CodexBridgeStatusSchema.safeParse(live).success).toBe(true);
  });

  it("not-installed has no window time", async () => {
    expect(toBridgeStatusView(await status())).toEqual({
      state: "not-installed",
      lastWindowAt: null,
    });
  });
});

describe("coveringWindow by real path", () => {
  const withWindow = async (folders: string[]) => {
    fx.installLauncher();
    fx.installMarker();
    fx.simulator("current", { folders }).heartbeat();
    return await status();
  };

  it("a window whose folder equals the project covers it", async () => {
    expect(await coveringWindow(await withWindow([fx.projectDir]), fx.projectDir)).not.toBeNull();
  });

  it("a window whose folder contains the project covers it", async () => {
    expect(await coveringWindow(await withWindow([fx.base]), fx.projectDir)).not.toBeNull();
  });

  it("a window on another folder, or on a sibling sharing a name prefix, does not", async () => {
    const sibling = join(fx.base, "project-two");
    mkdirSync(sibling);
    const s = await withWindow([sibling]);
    expect(await coveringWindow(s, fx.projectDir)).toBeNull();
    const other = join(fx.base, "other");
    mkdirSync(other);
    expect(await coveringWindow(s, other)).toBeNull();
  });

  it("a window opened on a project inside the asked folder does not cover the parent", async () => {
    expect(await coveringWindow(await withWindow([fx.projectDir]), fx.base)).toBeNull();
  });

  it("a symlinked project resolves through realpath, in either direction", async () => {
    const link = join(fx.base, "project-link");
    symlinkSync(fx.projectDir, link);
    expect(await coveringWindow(await withWindow([fx.projectDir]), link)).not.toBeNull();
    const second = createBridgeFixture();
    try {
      second.installLauncher();
      second.installMarker();
      const alias = join(second.base, "alias");
      symlinkSync(second.projectDir, alias);
      second.simulator("current", { folders: [alias] }).heartbeat();
      const s = await readBridgeStatus({ env: {}, home: second.home });
      expect(await coveringWindow(s, second.projectDir)).not.toBeNull();
    } finally {
      second.cleanup();
    }
  });

  it("a folder that does not exist covers nothing, and a relative project root covers nothing", async () => {
    const s = await withWindow([join(fx.base, "gone")]);
    expect(await coveringWindow(s, fx.projectDir)).toBeNull();
    expect(await coveringWindow(await withWindow([fx.projectDir]), "project")).toBeNull();
  });

  it("returns every covering window in file-name order", async () => {
    fx.installLauncher();
    fx.installMarker();
    fx.simulator("current", { key: "b-window" }).heartbeat();
    fx.simulator("outdated", { key: "a-window" }).heartbeat();
    const covering = await coveringWindows(await status(), fx.projectDir);
    expect(covering.map((w) => w.key)).toEqual(["a-window", "b-window"]);
  });
});

describe("containing: the candidate directory that holds a given path", () => {
  it("picks the default directory that contains the path even when the custom one has the bridge", async () => {
    fx.installLauncher();
    fx.installMarker();
    const custom = join(fx.home, "custom-state");
    const env = { XDG_STATE_HOME: custom };
    const dir = join(custom, "codex-bridge");
    for (const name of ["windows", "requests", "claimed"]) {
      mkdirSync(join(dir, name), { recursive: true });
    }
    writeFileSync(
      join(dir, "protocol.json"),
      JSON.stringify({ protocol: 2, capabilities: ["follow", "tui", "agent"], kit: "test-kit" }),
    );
    const inDefault = join(fx.stateDir, "projects", "p-abc");
    mkdirSync(inDefault, { recursive: true });
    const plain = await readBridgeStatus({ env, home: fx.home });
    expect(plain.dir).toBe(join(custom, "codex-bridge"));
    const narrowed = await readBridgeStatus({ env, home: fx.home, containing: inDefault });
    expect(narrowed.dir).toBe(fx.stateDir);
    expect(narrowed.launchable).toBe(true);
  });

  it("is not launchable when no candidate directory contains the path", async () => {
    fx.installLauncher();
    fx.installMarker();
    const narrowed = await readBridgeStatus({
      env: {},
      home: fx.home,
      containing: join(fx.home, "somewhere-else", "projects", "p"),
    });
    expect(narrowed.launchable).toBe(false);
    expect(narrowed.windows).toEqual([]);
  });
});
