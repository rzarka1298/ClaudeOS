import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CODEX_DOCTOR_CAP_MS } from "@ccc/domain";
import { afterAll, describe, expect, it } from "vitest";
import { createExecFileCommandRunner } from "../projects/command-runner.js";
import { weeklyReply, writeFakeAppServer } from "../test-support/fake-codex-app-server.js";
import { doctorReport, writeFakeDoctor } from "../test-support/fake-codex-doctor.js";
import { type ChildEnvFs, codexChildEnv } from "./child-env.js";

/** The environment, which is never `null` in these tests (no deadline is hit). */
async function prepared(
  options: Parameters<typeof codexChildEnv>[0],
): Promise<Record<string, string>> {
  const env = await codexChildEnv(options);
  if (env === null) throw new Error("child environment was not prepared");
  return env;
}

import { createCodexDetection } from "./detection.js";
import { createDoctorProbe } from "./doctor-probe.js";
import { createRateLimitsClient } from "./rate-limits-client.js";

/**
 * One child-environment policy for every local Codex spawn (whole-phase
 * finding 4). Launchers are temp scripts; the real `codex` never runs.
 */

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ccc-cenv-"));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const NOW_MS = Date.UTC(2026, 9, 10, 12, 0, 0);

/** Rewrite a fake launcher's first line to the env-node shebang. */
function useEnvNodeShebang(path: string): void {
  const text = readFileSync(path, "utf8");
  const rest = text.slice(text.indexOf("\n"));
  writeFileSync(path, `#!/usr/bin/env node${rest}`);
  chmodSync(path, 0o755);
}

describe("codexChildEnv (unit, injected fs)", () => {
  function fsOf(options: {
    head: string | null;
    safe?: readonly string[];
    present?: readonly string[];
  }): ChildEnvFs {
    return {
      readHead: () => Promise.resolve(options.head),
      safeDirectory: (path) => Promise.resolve((options.safe ?? []).includes(path) ? path : null),
      isExecutableFile: (path) => Promise.resolve((options.present ?? []).includes(path)),
    };
  }
  const base = { executablePath: "/x/bin/codex", codexHome: null, home: "/Users/USERNAME" };

  it("a native executable keeps PATH exactly /usr/bin:/bin", async () => {
    const env = await prepared({ ...base, fs: fsOf({ head: "\u007fELF binary" }) });
    expect(env).toEqual({ HOME: "/Users/USERNAME", PATH: "/usr/bin:/bin", LC_ALL: "C" });
  });

  it("a #!/bin/sh shebang is unaffected", async () => {
    const env = await prepared({ ...base, fs: fsOf({ head: "#!/bin/sh\nexec x\n" }) });
    expect(env.PATH).toBe("/usr/bin:/bin");
  });

  it("an env shebang puts the pinned Node directory first, ahead of the launcher directory", async () => {
    const env = await prepared({
      ...base,
      nodeExecPath: "/pin/node-dir/node",
      platformDirs: [],
      fs: fsOf({
        head: "#!/usr/bin/env node\n",
        safe: ["/pin/node-dir", "/x/bin"],
        present: ["/pin/node-dir/node", "/x/bin/node"],
      }),
    });
    expect(env.PATH).toBe("/pin/node-dir:/usr/bin:/bin");
  });

  it("falls to the launcher directory, then the standard directories", async () => {
    const common = { ...base, nodeExecPath: "/pin/node", head: "#!/usr/bin/env node\n" };
    expect(
      (
        await prepared({
          ...common,
          fs: fsOf({ head: common.head, safe: ["/x/bin"], present: ["/x/bin/node"] }),
        })
      ).PATH,
    ).toBe("/x/bin:/usr/bin:/bin");
    expect(
      (
        await prepared({
          ...common,
          fs: fsOf({
            head: common.head,
            safe: ["/opt/homebrew/bin"],
            present: ["/opt/homebrew/bin/node"],
          }),
        })
      ).PATH,
    ).toBe("/opt/homebrew/bin:/usr/bin:/bin");
  });

  it("a directory that fails validation (world-writable, not real) is never used", async () => {
    const env = await prepared({
      ...base,
      nodeExecPath: "/pin/node",
      fs: fsOf({ head: "#!/usr/bin/env node\n", safe: [], present: ["/pin/node", "/x/bin/node"] }),
    });
    expect(env.PATH).toBe("/usr/bin:/bin");
  });

  it("an interpreter found nowhere leaves PATH minimal and never throws", async () => {
    const env = await prepared({ ...base, fs: fsOf({ head: "#!/usr/bin/env node\n" }) });
    expect(env.PATH).toBe("/usr/bin:/bin");
  });

  it("an unreadable launcher or an env shebang with flags or paths adds nothing", async () => {
    const present = ["/x/bin/node", "/x/bin/-S"];
    for (const head of [null, "#!/usr/bin/env -S node --x\n", "#!/usr/bin/env ../node\n"]) {
      const env = await prepared({ ...base, fs: fsOf({ head, safe: ["/x/bin"], present }) });
      expect(env.PATH).toBe("/usr/bin:/bin");
    }
  });

  it("holds only HOME, LC_ALL, PATH, plus CODEX_HOME when configured", async () => {
    const env = await prepared({ ...base, codexHome: "/h/.codex", fs: fsOf({ head: null }) });
    expect(Object.keys(env).sort()).toEqual(["CODEX_HOME", "HOME", "LC_ALL", "PATH"]);
    expect(await prepared({ ...base, codexHome: "", fs: fsOf({ head: null }) })).not.toHaveProperty(
      "CODEX_HOME",
    );
  });

  it("answers null when the filesystem never settles, once the deadline passes", async () => {
    const hung = new Promise<never>(() => {});
    const env = await codexChildEnv({
      ...base,
      deadlineMs: 30,
      fs: { readHead: () => hung, safeDirectory: () => hung, isExecutableFile: () => hung },
    });
    expect(env).toBeNull();
  });

  it("answers null at once for an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await codexChildEnv({ ...base, signal: controller.signal, fs: fsOf({ head: null }) }),
    ).toBeNull();
  });

  it("real fs: the pinned directory resolves, a world-writable directory does not", async () => {
    const launcherDir = tempDir();
    const launcher = join(launcherDir, "codex");
    writeFileSync(launcher, "#!/usr/bin/env node\n");
    chmodSync(launcher, 0o755);
    const env = await prepared({ ...base, executablePath: launcher, platformDirs: [] });
    expect(env.PATH).toBe(`${dirname(process.execPath)}:/usr/bin:/bin`);

    const open = tempDir();
    chmodSync(open, 0o777);
    const shim = join(open, "node");
    writeFileSync(shim, "#!/bin/sh\n");
    chmodSync(shim, 0o755);
    const blocked = await prepared({
      ...base,
      executablePath: join(open, "codex"),
      nodeExecPath: "/nonexistent/node",
      platformDirs: [],
    });
    expect(blocked.PATH).toBe("/usr/bin:/bin");
  });
});

describe("the minimal PATH cannot start an env-node launcher without the policy", () => {
  it("control: the bare minimal PATH fails to find node", async () => {
    const dir = tempDir();
    const launcher = join(dir, "codex");
    writeFileSync(launcher, '#!/usr/bin/env node\nconsole.log("codex-cli 0.159.2");\n');
    chmodSync(launcher, 0o755);
    const bare = spawnSync(launcher, ["--version"], { env: { PATH: "/usr/bin:/bin" } });
    expect(bare.status).not.toBe(0);
    const policy = spawnSync(launcher, ["--version"], {
      env: await prepared({ executablePath: launcher, codexHome: null, home: dir }),
    });
    expect(policy.stdout.toString()).toBe("codex-cli 0.159.2\n");
  });
});

describe("all three call sites start an env-node launcher", () => {
  it("usage client reads the weekly window", async () => {
    const server = writeFakeAppServer(tempDir(), {
      read: { kind: "result", result: weeklyReply(41) },
    });
    useEnvNodeShebang(server.path);
    const client = createRateLimitsClient({ executablePath: () => server.path, now: () => NOW_MS });
    expect((await client.read()).kind).toBe("available");
  });

  it("usage client reports unavailable (no throw) when the interpreter is nowhere", async () => {
    const server = writeFakeAppServer(tempDir(), {
      read: { kind: "result", result: weeklyReply(41) },
    });
    const text = readFileSync(server.path, "utf8");
    writeFileSync(
      server.path,
      `#!/usr/bin/env ccc-no-such-interpreter${text.slice(text.indexOf("\n"))}`,
    );
    const client = createRateLimitsClient({ executablePath: () => server.path, now: () => NOW_MS });
    expect((await client.read()).kind).toBe("unavailable");
  });

  it("detection's version probe reads the version", async () => {
    const home = tempDir();
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    const launcher = join(bin, "codex");
    writeFileSync(launcher, '#!/usr/bin/env node\nconsole.log("codex-cli 0.159.2");\n');
    chmodSync(launcher, 0o755);
    const detection = createCodexDetection({
      runner: createExecFileCommandRunner(),
      homeDir: home,
      isExecutable: (path) => Promise.resolve(path === launcher),
      readBridgeStatus: () => {
        throw new Error("not under test");
      },
    });
    const result = await detection.detectCodex();
    expect(result.executables.map((found) => found.version)).toEqual(["0.159.2"]);
  });

  it("the doctor probe runs", async () => {
    const doctor = writeFakeDoctor(tempDir(), {
      behavior: { kind: "print", stdout: doctorReport({ overallStatus: "ok" }) },
    });
    useEnvNodeShebang(doctor.path);
    const probe = createDoctorProbe({
      executablePath: () => doctor.path,
      homeDir: () => "/Users/USERNAME",
      now: () => NOW_MS,
      capMs: CODEX_DOCTOR_CAP_MS,
    });
    expect((await probe.run()).kind).toBe("ok");
  });
});
