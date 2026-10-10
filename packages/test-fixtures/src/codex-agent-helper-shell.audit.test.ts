// Wave 3 audit (plan 05.1-10 truth 2): "the child's exit code is the helper's exit code when no
// trailing shell is started; the helper starts the owner's login shell in the project directory
// afterwards only on a TTY, exactly like follow". The plan's own tests always set the test knob that
// disables the shell, so neither half of that sentence ran. Here the knob is NOT set: a piped run
// must return the agent's code with no shell, and a run on a real pseudo-terminal must hand the tab
// to the login shell in the request's directory.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBridgeCore, loadWindowSimulator } from "./codex-bridge-core.js";
import { REPO_ROOT } from "./gate-repo.js";

const core = loadBridgeCore();
const { createWindowSimulator } = loadWindowSimulator();
const RUN_ID = "20261010T130000123Z";
const FILES = [
  "scripts/codex/codex.mjs",
  "scripts/codex/antigravity-extension/bridge-core.js",
  "scripts/codex/antigravity-extension/package.json",
];

const HAS_PYTHON = spawnSync("python3", ["-I", "-c", "import pty"]).status === 0;

let root: string;
let kit: string;
let bin: string;

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(root, prefix)));
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ccc-agent-shell-audit-")));
  kit = tmp("kit-");
  for (const f of FILES) {
    const to = join(kit, f);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(REPO_ROOT, f), to);
  }
  bin = tmp("bin-");
  // A fake claude that exits with the code in CCC_FAKE_EXIT.
  const agent = join(bin, "claude");
  writeFileSync(
    agent,
    `#!${process.execPath}\nprocess.exit(Number(process.env.CCC_FAKE_EXIT || 0));\n`,
  );
  chmodSync(agent, 0o755);
  // A fake login shell that records where it was started and with which arguments.
  const shell = join(bin, "fake-shell");
  writeFileSync(
    shell,
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(process.env.SHELL_MARK, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }));\n`,
  );
  chmodSync(shell, 0o755);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function setup() {
  const home = tmp("home-");
  const project = tmp("project-");
  const state = join(home, ".local", "state", "codex-bridge");
  core.ensureDirs(state);
  core.writeRequest(state, {
    runId: RUN_ID,
    kind: "agent",
    mode: "agent",
    agent: "claude",
    projectRoot: project,
    cwd: project,
    argv: [join(bin, "claude"), "--permission-mode", "plan"],
    env: { CCC_FAKE_EXIT: "7" },
    sessionId: null,
    liveLog: null,
    pid: null,
    createdAt: new Date().toISOString(),
    protocol: 2,
  } as never);
  const sim = createWindowSimulator({
    stateDir: state,
    folders: [project],
    mode: "current",
    now: Date.now(),
  });
  expect(sim.tick()).toHaveLength(1);
  sim.close();
  const mark = join(home, "shell-mark.json");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("CODEX_BRIDGE_")) delete env[k];
  delete env.XDG_STATE_HOME;
  Object.assign(env, { HOME: home, SHELL: join(bin, "fake-shell"), SHELL_MARK: mark });
  return { project, mark, env };
}

describe("codex-bridge agent: the trailing login shell", () => {
  it("without a TTY the helper returns the agent's own exit code and starts no shell", () => {
    const { project, mark, env } = setup();
    const r = spawnSync(process.execPath, [join(kit, "scripts/codex/codex.mjs"), "agent", RUN_ID], {
      cwd: project,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(r.status).toBe(7);
    expect(existsSync(mark)).toBe(false);
  });

  it.skipIf(!HAS_PYTHON)(
    "on a pseudo-terminal the helper hands the tab to the login shell in the request's directory",
    () => {
      const { project, mark, env } = setup();
      // Python's pty.fork gives the helper a controlling pseudo-terminal as stdin (BSD `script`
      // insists on a terminal of its own, which a test runner does not have).
      const r = spawnSync(
        "python3",
        [
          "-I",
          "-c",
          "import os, pty, sys\nrc = pty.spawn(sys.argv[1:])\nsys.exit(os.waitstatus_to_exitcode(rc))",
          process.execPath,
          join(kit, "scripts/codex/codex.mjs"),
          "agent",
          RUN_ID,
        ],
        { cwd: project, env, encoding: "utf8", timeout: 30_000, input: "" },
      );
      expect(existsSync(mark), `pty output: ${r.stdout}${r.stderr}`).toBe(true);
      const seen = JSON.parse(readFileSync(mark, "utf8")) as { cwd: string; argv: string[] };
      expect(seen.cwd).toBe(project);
      expect(seen.argv).toEqual(["-l"]);
      expect(r.status).toBe(0);
    },
  );
});
