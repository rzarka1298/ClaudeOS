import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertNoForbiddenAccess,
  createFakeCodexHome,
  exerciseCodexHomePort,
  type FakeCodexHome,
  recordingFs,
} from "../test-support/fake-codex-home.js";
import { createCodexHomePort } from "./codex-home.js";

/**
 * The CODEX-09 credential canary, port level (plan 05.1-14 task 1). The
 * fake CODEX_HOME holds a decoy credential file, a decoy config file and
 * lookalike names. The assertion is on file-system ACCESS (a recording
 * wrapper around the injected operations), so a swallowed error still counts
 * as a failure, and on every output channel: return values, thrown messages
 * and log calls.
 */

let home: FakeCodexHome | undefined;

afterEach(() => {
  home?.cleanup();
  home = undefined;
  vi.restoreAllMocks();
});

function makeHome(): FakeCodexHome {
  home = createFakeCodexHome({
    rollouts: [
      {
        day: "2026-10-06",
        name: "rollout-2026-10-06T10-00-00-aaaa.jsonl",
        content: "line-one\nline-two\n",
      },
    ],
    archivedRollouts: [{ day: "2026-10-06", name: "rollout-x.jsonl", content: "archived\n" }],
    sessionIndex: '{"id":"synthetic-1"}\n',
    hooksJson: "{}",
    version: '{"latest_version":"0.0.0"}',
    withDecoys: true,
  });
  return home;
}

describe("Test 6: the port-level credential canary", () => {
  it("records no decoy access and leaks no marker through any port method", () => {
    const fake = makeHome();
    const rec = recordingFs();
    const port = createCodexHomePort({ root: fake.root, fs: rec.fs });

    const logSpies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const exercise = exerciseCodexHomePort(port, fake);

    // Access: the helper throws on a decoy, a lookalike or anything off the allowlist.
    expect(rec.calls.length).toBeGreaterThan(0);
    expect(() => assertNoForbiddenAccess(rec.calls, fake)).not.toThrow();

    // Output: no return value and no thrown message carries the marker or a decoy name.
    const joined = exercise.outputs.join("\n");
    expect(joined).not.toContain(fake.decoys.marker);
    expect(joined).not.toContain(fake.decoys.credentialName);
    expect(joined).not.toContain(fake.decoys.configName);

    // Logs: nothing was written to a log channel carrying the marker.
    const logged = [
      ...logSpies.flatMap((spy) => spy.mock.calls),
      ...stdout.mock.calls,
      ...stderr.mock.calls,
    ]
      .map((call) => String(call[0]))
      .join("\n");
    expect(logged).not.toContain(fake.decoys.marker);
  });

  it("reads each decoy name zero times, however it is requested", () => {
    const fake = makeHome();
    const rec = recordingFs();
    const port = createCodexHomePort({ root: fake.root, fs: rec.fs });
    exerciseCodexHomePort(port, fake);
    const names = [
      fake.decoys.credentialName,
      fake.decoys.configName,
      ...fake.decoys.lookalikeNames,
    ];
    for (const call of rec.calls) {
      for (const name of names) expect(call.path.endsWith(name)).toBe(false);
    }
  });
});
