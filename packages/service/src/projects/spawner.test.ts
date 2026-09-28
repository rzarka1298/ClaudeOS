import { describe, expect, it } from "vitest";
import { createFakeCommandRunner } from "../test-support/fake-command-runner.js";
import { createCommandSpawner } from "./spawner.js";

const MISSING_PATH_STDERR = "The file /Users/USERNAME/code/example-project does not exist.";

describe("createCommandSpawner (D-18, D-46, T-04-19)", () => {
  it("runs argv[0] with the rest as separate arguments and a fixed environment", async () => {
    const runner = createFakeCommandRunner({ script: [{ match: () => true, outcome: {} }] });
    await createCommandSpawner(runner).run(["/usr/bin/open", "-R", "/tmp/x y"], {
      timeoutMs: 4000,
    });
    expect(runner.calls).toHaveLength(1);
    const [call] = runner.calls;
    expect(call?.file).toBe("/usr/bin/open");
    expect(call?.args).toEqual(["-R", "/tmp/x y"]);
    expect(Object.keys(call?.options.env ?? {}).sort()).toEqual(["HOME", "LC_ALL", "PATH"]);
    expect(call?.options.env.PATH).toBe("/usr/bin:/bin");
    expect(call?.options.timeoutMs).toBe(4000);
    expect(Object.keys(call?.options ?? {})).not.toContain("shell");
  });

  it("classifies stderr and never returns its text", async () => {
    const runner = createFakeCommandRunner({
      script: [{ match: () => true, outcome: { exitCode: 1, stderr: MISSING_PATH_STDERR } }],
    });
    const outcome = await createCommandSpawner(runner).run(["/usr/bin/open", "-R", "/x"], {
      timeoutMs: 4000,
    });
    expect(outcome).toEqual({
      exitCode: 1,
      errno: null,
      stderrClass: "path-missing",
      timedOut: false,
    });
    expect(JSON.stringify(outcome)).not.toContain("example-project");
  });

  it("reports a spawn errno and a timeout as the runner saw them", async () => {
    const runner = createFakeCommandRunner({
      script: [{ match: () => true, outcome: { exitCode: null, timedOut: true } }],
    });
    await expect(
      createCommandSpawner(runner).run(["/usr/bin/open"], { timeoutMs: 10 }),
    ).resolves.toMatchObject({ exitCode: null, timedOut: true });
    const unmatched = createFakeCommandRunner();
    await expect(
      createCommandSpawner(unmatched).run(["/usr/bin/open"], { timeoutMs: 10 }),
    ).resolves.toMatchObject({ exitCode: null, errno: "ENOENT" });
  });

  it("answers an empty argv without running anything", async () => {
    const runner = createFakeCommandRunner();
    await expect(createCommandSpawner(runner).run([], { timeoutMs: 10 })).resolves.toMatchObject({
      errno: "EINVAL",
    });
    expect(runner.calls).toHaveLength(0);
  });
});
