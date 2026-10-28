// scripts/launchagent/install.sh re-install behaviour (plan 09-03, D-10, SVC-12).
//
// Every test copies install.sh and the plist template into a throwaway repository
// (gateRepo) and runs the copy with a STUB `launchctl` and a STUB `sleep` first on
// PATH, HOME and CCC_RUNTIME_DIR pointed at temp directories. Nothing here ever
// reaches the real launchd, the real ~/Library/LaunchAgents or the owner's
// com.claude-command-center.service (T-09-05): the real re-install is owner item
// D-10 in 09-UAT.md.
//
// Stub state lives in files under STUB_DIR:
//   registered  - how many jobs the stub currently holds registered (a count, so
//                 "exactly one job after three runs" is observable)
//   unloading   - set by `bootout`: the job stays visible to `print` for
//                 STUB_CLEARS_AFTER more polls, then goes
//   polls       - `print` calls since that `bootout`
//   bootstrap-exits - remaining comma list of exit codes for `bootstrap` calls
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type GateRepo, gateRepo, REPO_ROOT } from "./gate-repo.js";

const INSTALL = "scripts/launchagent/install.sh";
const TEMPLATE = "scripts/launchagent/com.claude-command-center.service.plist.template";
const LABEL = "com.claude-command-center.service";

// The external commands install.sh runs (read from the script: dirname, id, mkdir, node, sed, and sh
// itself) plus `cat`, which the stub launchctl uses to read its state files; everything else is a
// shell builtin or a stub. The script's PATH is a directory holding symlinks to exactly these plus the
// stubs, so the real launchctl and sleep cannot be reached by name.
const INSTALL_SH_TOOLS = ["cat", "dirname", "id", "mkdir", "node", "sed", "sh"] as const;

/** Absolute-path invocations of launchctl or sleep: they would bypass the stubs on PATH. */
function absoluteToolPaths(source: string): string[] {
  return source.split("\n").filter((line) => /\/(launchctl|sleep)(\s|$)/.test(line));
}

const STUB_LAUNCHCTL = `#!/bin/sh
# Test stub for launchctl. Records every call; never touches launchd.
: "\${STUB_LOG:?STUB_LOG must be set}"
: "\${STUB_DIR:?STUB_DIR must be set}"
echo "launchctl-stub: $*" >> "$STUB_LOG"
state() { cat "$STUB_DIR/$1" 2>/dev/null || echo "$2"; }
put() { printf '%s' "$2" > "$STUB_DIR/$1"; }
case "$1" in
  bootout)
    if [ "$(state registered 0)" -gt 0 ]; then
      put unloading 1
      put polls 0
      exit 0
    fi
    echo "Boot-out failed: 3: No such process" >&2
    exit 3
    ;;
  print)
    if [ "$(state unloading 0)" = 1 ]; then
      polls=$(( $(state polls 0) + 1 ))
      put polls "$polls"
      if [ "$polls" -gt "\${STUB_CLEARS_AFTER:-0}" ]; then
        put registered $(( $(state registered 0) - 1 ))
        put unloading 0
        exit 113
      fi
      exit 0
    fi
    [ "$(state registered 0)" -gt 0 ] && exit 0
    exit 113
    ;;
  bootstrap)
    exits=$(state bootstrap-exits "\${STUB_BOOTSTRAP_EXITS:-}")
    code=0
    if [ -n "$exits" ]; then
      code=\${exits%%,*}
      case "$exits" in
        *,*) put bootstrap-exits "\${exits#*,}" ;;
        *) put bootstrap-exits "" ;;
      esac
    fi
    if [ "$code" = 0 ] && [ "$(state registered 0)" -gt 0 ]; then
      code=5
    fi
    if [ "$code" != 0 ]; then
      echo "Bootstrap failed: 5: Input/output error" >&2
      exit "$code"
    fi
    put registered $(( $(state registered 0) + 1 ))
    exit 0
    ;;
esac
exit 0
`;

const STUB_SLEEP = `#!/bin/sh
echo "sleep-stub: $*" >> "\${STUB_LOG:?STUB_LOG must be set}"
exit 0
`;

interface Fixture {
  repo: GateRepo;
  home: string;
  runtimeDir: string;
  binDir: string;
  stubDir: string;
  log: string;
  plist: string;
}

const made: Fixture[] = [];

/** The first executable called `name` on the test process's own PATH (node: the running binary). */
function resolveTool(name: string): string {
  if (name === "node") return process.execPath;
  for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${name} not found on PATH`);
}

function fixture(): Fixture {
  const repo = gateRepo([INSTALL, TEMPLATE], {
    "packages/service/dist/main.js": "// fake service entry point\n",
  });
  const scratch = mkdtempSync(join(tmpdir(), "ccc-launchagent-"));
  const home = join(scratch, "home");
  const runtimeDir = join(scratch, "runtime");
  const binDir = join(scratch, "bin");
  const stubDir = join(scratch, "stub-state");
  for (const dir of [home, runtimeDir, binDir, stubDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(binDir, "launchctl"), STUB_LAUNCHCTL);
  writeFileSync(join(binDir, "sleep"), STUB_SLEEP);
  chmodSync(join(binDir, "launchctl"), 0o755);
  chmodSync(join(binDir, "sleep"), 0o755);
  for (const tool of INSTALL_SH_TOOLS) symlinkSync(resolveTool(tool), join(binDir, tool));
  const fx: Fixture = {
    repo,
    home,
    runtimeDir,
    binDir,
    stubDir,
    log: join(scratch, "calls.log"),
    plist: join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
  };
  writeFileSync(fx.log, "");
  made.push(fx);
  return fx;
}

afterEach(() => {
  for (const fx of made.splice(0)) {
    rmSync(dirname(fx.log), { recursive: true, force: true });
    fx.repo.dispose();
  }
});

/** Owner-safety net: every path the script was pointed at sits inside this test's temp area. */
function assertContained(fx: Fixture, ...paths: string[]): void {
  const root = dirname(fx.log);
  for (const path of paths) {
    expect(path.startsWith(`${root}/`), `${path} escapes the fixture`).toBe(true);
  }
}

interface Knobs {
  clearsAfter?: number;
  bootstrapExits?: string;
  pollLimit?: number;
  registered?: number;
}

/** The environment install.sh runs in. Knobs lower the production waits; `production` leaves them unset. */
function scriptEnv(fx: Fixture, knobs: Knobs = {}, production = false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: fx.home,
    CCC_RUNTIME_DIR: fx.runtimeDir,
    // A closed PATH: only the fixture bin (the stubs plus symlinks to install.sh's own tools).
    PATH: fx.binDir,
    STUB_LOG: fx.log,
    STUB_DIR: fx.stubDir,
    STUB_CLEARS_AFTER: String(knobs.clearsAfter ?? 0),
    STUB_BOOTSTRAP_EXITS: knobs.bootstrapExits ?? "",
  };
  if (!production) {
    env.CCC_INSTALL_POLL_INTERVAL = "0";
    env.CCC_INSTALL_RETRY_DELAY = "0";
  }
  if (knobs.pollLimit !== undefined) env.CCC_INSTALL_POLL_LIMIT = String(knobs.pollLimit);
  return env;
}

function run(
  fx: Fixture,
  knobs: Knobs = {},
  production = false,
): { status: number | null; out: string } {
  assertContained(fx, fx.home, fx.runtimeDir, fx.binDir, fx.stubDir, fx.log);
  if (knobs.registered !== undefined) {
    writeFileSync(join(fx.stubDir, "registered"), String(knobs.registered));
  }
  const result = fx.repo.run(INSTALL, [], scriptEnv(fx, knobs, production));
  return { status: result.status, out: result.out };
}

function calls(fx: Fixture): string[] {
  return readFileSync(fx.log, "utf8").split("\n").filter(Boolean);
}

function launchctlVerbs(fx: Fixture): string[] {
  return calls(fx)
    .filter((line) => line.startsWith("launchctl-stub: "))
    .map((line) => line.slice("launchctl-stub: ".length).split(" ")[0] ?? "");
}

function registeredCount(fx: Fixture): number {
  const path = join(fx.stubDir, "registered");
  return existsSync(path) ? Number(readFileSync(path, "utf8")) : 0;
}

describe("09-03 Task 1 (tracer): a re-install waits for the old label to go before it bootstraps", () => {
  it("Test 1: bootout, then polls print until it fails, then bootstrap (never before)", () => {
    const fx = fixture();
    const result = run(fx, { registered: 1, clearsAfter: 3 });
    expect(result.status, result.out).toBe(0);

    const verbs = launchctlVerbs(fx);
    const bootout = verbs.indexOf("bootout");
    const bootstrap = verbs.indexOf("bootstrap");
    expect(bootout).toBeGreaterThanOrEqual(0);
    expect(bootstrap).toBeGreaterThan(bootout);
    // Three succeeding polls plus the one that fails, all before the bootstrap.
    const printsBefore = verbs.slice(0, bootstrap).filter((verb) => verb === "print").length;
    expect(printsBefore).toBeGreaterThanOrEqual(4);
    expect(verbs.filter((verb) => verb === "bootstrap")).toHaveLength(1);
    expect(registeredCount(fx)).toBe(1);
  });

  it("Test 2: a first install polls once, sleeps zero times and bootstraps once", () => {
    const fx = fixture();
    const result = run(fx);
    expect(result.status, result.out).toBe(0);

    const verbs = launchctlVerbs(fx);
    expect(verbs.filter((verb) => verb === "bootstrap")).toHaveLength(1);
    expect(calls(fx).filter((line) => line.startsWith("sleep-stub:"))).toEqual([]);
    // bootout, the single failing poll, bootstrap, then the unchanged post-check.
    expect(verbs.indexOf("print")).toBeLessThan(verbs.indexOf("bootstrap"));
  });

  it("Test 3: every launchctl call hit the stub and nothing left the temp HOME", () => {
    const fx = fixture();
    const realPlist = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
    const before = existsSync(realPlist) ? statSync(realPlist).mtimeMs : null;

    // The shell the script runs in resolves launchctl to the stub, not the system binary.
    const probe = spawnSync("sh", ["-c", "command -v launchctl"], {
      encoding: "utf8",
      env: scriptEnv(fx),
    });
    expect(probe.stdout.trim()).toBe(join(fx.binDir, "launchctl"));

    const result = run(fx, { registered: 1, clearsAfter: 1 });
    expect(result.status, result.out).toBe(0);

    // The stub writes one marker line per call, so a call that skipped it would be missing here.
    const logged = calls(fx).filter((line) => line.startsWith("launchctl-stub: "));
    expect(logged.length).toBeGreaterThanOrEqual(4);
    expect(calls(fx).every((line) => /^(launchctl|sleep)-stub: /.test(line))).toBe(true);
    assertContained(fx, fx.plist);
    expect(existsSync(fx.plist)).toBe(true);
    expect(readFileSync(fx.plist, "utf8")).toContain("<string>/");
    const after = existsSync(realPlist) ? statSync(realPlist).mtimeMs : null;
    expect(after).toBe(before);
  });
});

describe("09-03 Task 2: bounded timeout, one retry on error 5, three idempotent runs", () => {
  it("Test 4: a label that never clears times out with no bootstrap and a message naming the command", () => {
    const fx = fixture();
    const result = run(fx, { registered: 1, clearsAfter: 50, pollLimit: 5 });
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("still registered");
    expect(result.out).toContain(LABEL);
    expect(result.out).toContain("launchctl bootout gui/");
    expect(launchctlVerbs(fx)).not.toContain("bootstrap");
    // 5 polls, 4 sleeps between them: the wait is bounded by the limit.
    expect(launchctlVerbs(fx).filter((verb) => verb === "print")).toHaveLength(5);
  });

  it("Test 5: the boundary - clears on poll 5 of 5 is bootstrapped, clears on poll 6 times out", () => {
    // clearsAfter counts the polls that still succeed, so "clears on poll N" is N - 1.
    const atLimit = fixture();
    const ok = run(atLimit, { registered: 1, clearsAfter: 4, pollLimit: 5 });
    expect(ok.status, ok.out).toBe(0);
    expect(launchctlVerbs(atLimit)).toContain("bootstrap");

    const pastLimit = fixture();
    const timedOut = run(pastLimit, { registered: 1, clearsAfter: 5, pollLimit: 5 });
    expect(timedOut.status).not.toBe(0);
    expect(timedOut.out).toContain("still registered");
    expect(launchctlVerbs(pastLimit)).not.toContain("bootstrap");
  });

  it("Test 6: error 5 is retried exactly once; a second failure and any other code are not", () => {
    const heals = fixture();
    const healed = run(heals, { bootstrapExits: "5,0" });
    expect(healed.status, healed.out).toBe(0);
    expect(launchctlVerbs(heals).filter((verb) => verb === "bootstrap")).toHaveLength(2);
    expect(registeredCount(heals)).toBe(1);

    const twice = fixture();
    const failedTwice = run(twice, { bootstrapExits: "5,5" });
    expect(failedTwice.status).toBe(5);
    expect(launchctlVerbs(twice).filter((verb) => verb === "bootstrap")).toHaveLength(2);
    expect(failedTwice.out).toContain("Bootstrap failed: 5: Input/output error");
    expect(failedTwice.out).toContain("failed twice");

    const other = fixture();
    const failedOther = run(other, { bootstrapExits: "1" });
    expect(failedOther.status).toBe(1);
    expect(launchctlVerbs(other).filter((verb) => verb === "bootstrap")).toHaveLength(1);
    expect(failedOther.out).toContain("Bootstrap failed: 5: Input/output error");
  });

  it("Test 7: three runs in a row against a registered service each exit 0 and leave one job", () => {
    const fx = fixture();
    const first = run(fx, { registered: 1, clearsAfter: 2 });
    expect(first.status, first.out).toBe(0);
    for (let i = 0; i < 2; i++) {
      const again = run(fx, { clearsAfter: 2 });
      expect(again.status, again.out).toBe(0);
    }
    expect(registeredCount(fx)).toBe(1);
    expect(launchctlVerbs(fx).filter((verb) => verb === "bootstrap")).toHaveLength(3);
  });
});

// FIX2B I1 + I2 (Codex review of 09-03).
describe("FIX2B I1: the real launchctl and sleep are unreachable from the script's PATH", () => {
  it("every PATH directory the script sees is the fixture bin, and it holds only the stubs and install.sh's own tools", () => {
    const fx = fixture();
    const env = scriptEnv(fx);
    const dirs = (env.PATH ?? "").split(":").filter(Boolean);
    expect(dirs).toEqual([fx.binDir]);
    // The stubs are the only launchctl and sleep a PATH lookup can find.
    for (const name of ["launchctl", "sleep"]) {
      const found = dirs.filter((dir) => existsSync(join(dir, name)));
      expect(found, `${name} reachable outside the stub bin`).toEqual([fx.binDir]);
      expect(lstatSync(join(fx.binDir, name)).isSymbolicLink()).toBe(false);
    }
    expect(readdirSync(fx.binDir).sort()).toEqual(
      ["launchctl", "sleep", ...INSTALL_SH_TOOLS].sort(),
    );
    // An unlisted system tool (ls) is not reachable, so the PATH really is closed.
    const probe = spawnSync("sh", ["-c", "command -v ls"], { encoding: "utf8", env });
    expect(probe.status).not.toBe(0);
  });

  it("install.sh names no absolute launchctl or sleep path", () => {
    const source = readFileSync(join(REPO_ROOT, INSTALL), "utf8");
    expect(absoluteToolPaths(source)).toEqual([]);
  });

  it("the guard itself flags absolute launchctl and sleep paths", () => {
    expect(absoluteToolPaths("/bin/launchctl bootout x\n")).toHaveLength(1);
    expect(absoluteToolPaths("  /usr/bin/sleep 1\n")).toHaveLength(1);
    expect(absoluteToolPaths("exec /usr/local/bin/launchctl print x\n")).toHaveLength(1);
    expect(absoluteToolPaths("launchctl bootout gui/501/x\nsleep 1\n")).toEqual([]);
  });
});

describe("FIX2B I2: the production wait defaults are pinned", () => {
  const sleeps = (fx: Fixture): string[] =>
    calls(fx)
      .filter((line) => line.startsWith("sleep-stub: "))
      .map((line) => line.slice("sleep-stub: ".length));

  it("the script carries the documented default literals", () => {
    const source = readFileSync(join(REPO_ROOT, INSTALL), "utf8");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: these are literal shell parameter expansions
    expect(source).toContain('POLL_INTERVAL="${CCC_INSTALL_POLL_INTERVAL:-0.1}"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell parameter expansion
    expect(source).toContain('POLL_LIMIT="${CCC_INSTALL_POLL_LIMIT:-100}"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell parameter expansion
    expect(source).toContain('RETRY_DELAY="${CCC_INSTALL_RETRY_DELAY:-1}"');
  });

  it("with no CCC_INSTALL_* knobs, polls sleep 0.1 s between polls and a retry sleeps 1 s first", () => {
    const fx = fixture();
    const result = run(fx, { registered: 1, clearsAfter: 2, bootstrapExits: "5,0" }, true);
    expect(result.status, result.out).toBe(0);
    // Two succeeding polls -> two 0.1 s sleeps; then error 5 -> the 1 s retry delay.
    expect(sleeps(fx)).toEqual(["0.1", "0.1", "1"]);
  });

  it("with no knobs, a label that never clears gives up after exactly 100 polls and 99 sleeps", () => {
    const fx = fixture();
    const result = run(fx, { registered: 1, clearsAfter: 100_000 }, true);
    expect(result.status).not.toBe(0);
    expect(launchctlVerbs(fx).filter((verb) => verb === "print")).toHaveLength(100);
    expect(sleeps(fx)).toEqual(Array.from({ length: 99 }, () => "0.1"));
    expect(launchctlVerbs(fx)).not.toContain("bootstrap");
  });
});
