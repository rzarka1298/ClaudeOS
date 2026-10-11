import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OPEN } from "@ccc/launchers";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakeCodexHome,
  type FakeCodexHome,
  recordingFs,
  rolloutContent,
  rolloutMetaLine,
} from "../test-support/fake-codex-home.js";
import { createFakeSpawner } from "../test-support/fake-spawner.js";
import { createCodexHomePort } from "./codex-home.js";
import { createTranscriptOpener, TRANSCRIPT_OPEN_CAP_MS } from "./transcript-open.js";

const NAME = "rollout-thread-a.jsonl";
let home: FakeCodexHome | undefined;

afterEach(() => {
  home?.cleanup();
  home = undefined;
});

function setup(options: { readonly withEscape?: boolean } = {}) {
  home = createFakeCodexHome({
    rollouts: [
      {
        day: "2026-10-06",
        name: NAME,
        content: rolloutContent(rolloutMetaLine({ id: "thread-a", atMs: 0 })),
      },
    ],
    archivedRollouts: [{ day: "2026-10-06", name: "rollout-archived.jsonl", content: "{}\n" }],
    withDecoys: true,
    escapeSymlink: options.withEscape === true,
  });
  const recorded = recordingFs();
  const port = createCodexHomePort({ root: home.root, fs: recorded.fs });
  const spawner = createFakeSpawner();
  const paths = new Map<string, string>();
  const opener = createTranscriptOpener({
    resolveThread: (threadId) => {
      const path = paths.get(threadId);
      return path === undefined ? null : { rolloutPath: path };
    },
    port,
    spawner,
  });
  paths.set("thread-a", home.rolloutPath("2026-10-06", NAME));
  return { opener, spawner, paths, home, recorded };
}

describe("Test 1 (tracer): a contained rollout is revealed or opened through the spawner", () => {
  it("spawns exactly [open, -R, path] for reveal and [open, -t, path] for open", async () => {
    const { opener, spawner, home: h } = setup();
    const path = h.rolloutPath("2026-10-06", NAME);
    await expect(opener.open({ threadId: "thread-a", via: "reveal" })).resolves.toEqual({
      ok: true,
    });
    await expect(opener.open({ threadId: "thread-a", via: "open" })).resolves.toEqual({ ok: true });
    expect(spawner.calls.map((call) => call.argv)).toEqual([
      [OPEN, "-R", path],
      [OPEN, "-t", path],
    ]);
    expect(spawner.calls[0]?.opts.timeoutMs).toBe(TRANSCRIPT_OPEN_CAP_MS);
  });
});

describe("Test 2: containment is checked before anything is spawned", () => {
  it("refuses an unknown thread with not-found", async () => {
    const { opener, spawner } = setup();
    await expect(opener.open({ threadId: "unknown", via: "reveal" })).resolves.toEqual({
      ok: false,
      error: "not-found",
    });
    expect(spawner.calls).toHaveLength(0);
  });

  it("refuses archived, outside, symlink-escaping, dot-dot and relative paths with outside-sessions-folder", async () => {
    const { opener, spawner, paths, home: h } = setup({ withEscape: true });
    const hostile: Array<[string, string]> = [
      ["archived", join(h.root, "archived_sessions", "2026", "10", "06", "rollout-archived.jsonl")],
      ["outside", h.decoys.credentialPath],
      ["config", h.decoys.configPath],
      ["escape", h.escapeSymlinkPath],
      ["dotdot", `${h.root}/sessions/2026/10/06/../../../../${h.decoys.credentialName}`],
      ["relative", "rollout-relative.jsonl"],
      ["elsewhere", "/etc/hosts"],
    ];
    for (const [id, path] of hostile) paths.set(id, path);
    for (const [id] of hostile) {
      await expect(opener.open({ threadId: id, via: "open" })).resolves.toEqual({
        ok: false,
        error: "outside-sessions-folder",
      });
    }
    expect(spawner.calls).toHaveLength(0);
  });

  it("answers not-found for a contained rollout that no longer exists", async () => {
    const { opener, spawner, paths, home: h } = setup();
    paths.set("gone", h.rolloutPath("2026-10-06", "rollout-gone.jsonl"));
    await expect(opener.open({ threadId: "gone", via: "reveal" })).resolves.toEqual({
      ok: false,
      error: "not-found",
    });
    expect(spawner.calls).toHaveLength(0);
  });

  it("never touches a decoy credential or config file", async () => {
    const { opener, paths, home: h, recorded } = setup({ withEscape: true });
    paths.set("outside", h.decoys.credentialPath);
    paths.set("escape", h.escapeSymlinkPath);
    await opener.open({ threadId: "outside", via: "open" });
    await opener.open({ threadId: "escape", via: "open" });
    for (const call of recorded.calls) {
      expect(call.op).not.toBe("readBytes");
    }
  });
});

describe("Test 3: a failed spawn maps to one constant code and echoes nothing", () => {
  it("maps a non-zero exit, a spawn error and a timeout to failed without the path", async () => {
    const { opener, spawner, home: h } = setup();
    const path = h.rolloutPath("2026-10-06", NAME);
    for (const outcome of [
      { exitCode: 1 },
      { exitCode: null, errno: "ENOENT" },
      { exitCode: null, timedOut: true },
    ]) {
      spawner.mode = { kind: "fail", outcome };
      const result = await opener.open({ threadId: "thread-a", via: "reveal" });
      expect(result).toEqual({ ok: false, error: "failed" });
      expect(JSON.stringify(result)).not.toContain(path);
    }
  });

  it("an abort kills a hung spawn and reports failed", async () => {
    const { opener, spawner } = setup();
    spawner.mode = { kind: "hang" };
    const controller = new AbortController();
    const pending = opener.open({ threadId: "thread-a", via: "open", signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toEqual({ ok: false, error: "failed" });
    expect(spawner.abortsObserved).toBe(1);
  });
});

describe("Test 5 (part): the opener registers no write allowlist and reaches no file system", () => {
  it("has no allowlist registration and no node:fs", () => {
    const source = readFileSync(join(import.meta.dirname, "transcript-open.ts"), "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    expect(source).not.toMatch(/node:fs|writeFile|appendFile|allowlist|ALLOWLIST|registerWrite/);
  });
});
