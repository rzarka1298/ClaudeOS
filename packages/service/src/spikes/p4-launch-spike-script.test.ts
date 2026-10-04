import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The owner spike script's refusal paths (plan 04-09 Task 2 review).
 *
 * Safety: every run here uses a COPY of the script inside a throwaway
 * repository layout whose "harness" is an empty file, a throwaway HOME, and
 * a PATH whose first entries are stubs — `launchctl` records its arguments
 * and exits 97, `plutil` does nothing — so no run can ever register a launchd
 * job, open Terminal or touch the owner's real folders.
 */

const SCRIPT_SOURCE = fileURLToPath(
  new URL("../../../../scripts/spikes/p4-launch-spike.sh", import.meta.url),
);
const NODE_DIR = dirname(process.execPath);
const HAS_DEVELOPER_TOOLS = spawnSync("/usr/bin/xcode-select", ["-p"]).status === 0;

let base: string;
let home: string;
let stubDir: string;
let scriptCopy: string;
let launchctlLog: string;

function writeStub(name: string, body: string): void {
  const path = join(stubDir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "ccc-spike-sh-")));
  home = join(base, "home", "user");
  mkdirSync(join(home, "Documents"), { recursive: true });
  stubDir = join(base, "stubs");
  mkdirSync(stubDir);
  launchctlLog = join(base, "launchctl.log");
  writeStub("launchctl", `echo "$@" >> "${launchctlLog}"\nexit 97`);
  writeStub("plutil", "exit 0");

  const repo = join(base, "repo");
  mkdirSync(join(repo, "scripts", "spikes"), { recursive: true });
  mkdirSync(join(repo, "packages", "service", "dist", "spikes"), { recursive: true });
  writeFileSync(join(repo, "packages", "service", "dist", "spikes", "launch-spike.js"), "");
  scriptCopy = join(repo, "scripts", "spikes", "p4-launch-spike.sh");
  copyFileSync(SCRIPT_SOURCE, scriptCopy);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function run(spikeDir: string): { status: number | null; stderr: string } {
  const result = spawnSync("/bin/sh", [scriptCopy], {
    env: {
      HOME: home,
      PATH: `${stubDir}:${NODE_DIR}:/usr/bin:/bin`,
      CCC_P4_SPIKE_DIR: spikeDir,
    },
    encoding: "utf8",
    timeout: 20_000,
  });
  return { status: result.status, stderr: result.stderr };
}

function modeBits(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("p4-launch-spike.sh: the spike directory guard", () => {
  it("refuses HOME itself and leaves its mode alone", () => {
    chmodSync(home, 0o755);
    const { status, stderr } = run(home);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/home folder/);
    expect(modeBits(home)).toBe(0o755);
    expect(existsSync(launchctlLog)).toBe(false);
  });

  it("refuses a parent of HOME and leaves its mode alone", () => {
    const parent = dirname(home);
    chmodSync(parent, 0o755);
    const { status, stderr } = run(parent);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/home folder/);
    expect(modeBits(parent)).toBe(0o755);
    expect(existsSync(launchctlLog)).toBe(false);
  });

  it("refuses an existing folder that is not empty and carries no spike marker", () => {
    const notes = join(base, "notes");
    mkdirSync(notes, { mode: 0o755 });
    chmodSync(notes, 0o755);
    writeFileSync(join(notes, "keep.txt"), "mine");
    const { status, stderr } = run(notes);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/spike marker/);
    expect(modeBits(notes)).toBe(0o755);
    expect(readdirSync(notes)).toEqual(["keep.txt"]);
    expect(existsSync(launchctlLog)).toBe(false);
  });
});

describe("p4-launch-spike.sh: git and the synthetic project", () => {
  it("keeps the fixed commit identity exactly once", () => {
    const src = readFileSync(SCRIPT_SOURCE, "utf8");
    expect(src.match(/user\.email=spike@example\.com/g) ?? []).toHaveLength(1);
  });

  it("requires xcode-select -p to succeed, never falling back to the /usr/bin/git shim", () => {
    const src = readFileSync(SCRIPT_SOURCE, "utf8");
    expect(src).toContain("if ! /usr/bin/xcode-select -p >/dev/null 2>&1; then");
    expect(src).not.toContain("&& ! command -v git");
  });

  it.skipIf(!HAS_DEVELOPER_TOOLS)(
    "a failing git init leaves no project folder behind in Documents",
    () => {
      writeStub("git", "exit 1");
      const spikeDir = join(base, "spike");
      const { status, stderr } = run(spikeDir);
      expect(status).not.toBe(0);
      expect(stderr).toMatch(/synthetic git repository/);
      expect(existsSync(join(home, "Documents", "ccc-spike-project"))).toBe(false);
      expect(readdirSync(spikeDir)).toEqual([".ccc-p4-spike"]);
      expect(existsSync(launchctlLog)).toBe(false);
    },
  );

  it.skipIf(!HAS_DEVELOPER_TOOLS)(
    "a new spike folder gets the marker at 0700 and the project appears only as a committed repository",
    () => {
      const spikeDir = join(base, "spike");
      const { status } = run(spikeDir);
      // The stub launchctl refuses the bootstrap, so the run ends there.
      expect(status).toBe(97);
      expect(existsSync(join(spikeDir, ".ccc-p4-spike"))).toBe(true);
      expect(modeBits(spikeDir)).toBe(0o700);
      const project = join(home, "Documents", "ccc-spike-project");
      expect(existsSync(join(project, ".git", "ccc-p4-spike-project"))).toBe(true);
      const log = spawnSync("git", ["-C", project, "log", "--format=%ae"], { encoding: "utf8" });
      expect(log.stdout.trim()).toBe("spike@example.com");
      expect(readFileSync(launchctlLog, "utf8")).toContain("bootstrap");
    },
  );

  it.skipIf(!HAS_DEVELOPER_TOOLS)(
    "an existing spike folder with the marker is accepted on a second run",
    () => {
      const spikeDir = join(base, "spike");
      mkdirSync(spikeDir);
      writeFileSync(join(spikeDir, ".ccc-p4-spike"), "");
      writeFileSync(join(spikeDir, "p4-spike-result.json"), "{}");
      const { status } = run(spikeDir);
      expect(status).toBe(97);
      expect(existsSync(join(spikeDir, "p4-spike-result.json"))).toBe(false);
    },
  );
});
