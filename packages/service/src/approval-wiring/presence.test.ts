// The presence helper adapter (plan 09-15, D-01, R-02). Every test runs the adapter against the FAKE
// helper (test-support/fake-presence-helper.mjs): a node script copied to a temporary absolute path as
// `ccc-presence`. No test spawns the owner's real helper, shows a prompt or reads a Keychain item (T-09-33).

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  PRESENCE_PROMPT_TIMEOUT_MS,
  type PresenceRequest,
  type ProposalId,
} from "@ccc/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CommandOutcome,
  type CommandRunner,
  createExecFileCommandRunner,
} from "../projects/command-runner.js";
import {
  createHelperPresencePort,
  createInstallMarker,
  guardPinReader,
  isPresenceSandbox,
  type PinObservation,
  PRESENCE_CHECK_TIMEOUT_MS,
  PRESENCE_HELPER_KILL_MS,
  PRESENCE_HELPER_MAX_OUTPUT_BYTES,
  PRESENCE_PIN_ACCOUNT,
  PRESENCE_PIN_INSTALL_MARKER_MAX_AGE_MS,
  type PresenceCustody,
  pinReaderFromEnv,
  presencePortFromEnv,
} from "./presence.js";

const FAKE_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  "test-support",
  "fake-presence-helper.mjs",
);

const PROPOSAL_ID = "a".repeat(25) as ProposalId;
const PAYLOAD_HASH = "b".repeat(64);
const APPROVED_AT = "2026-10-28T12:00:00.000Z";
const REQUEST: PresenceRequest = {
  proposalId: PROPOSAL_ID,
  operation: "publish",
  payloadHash: PAYLOAD_HASH,
  approvedAt: APPROVED_AT,
};
// A DER ECDSA P-256 signature is 70 to 72 bytes.
const SIGNATURE = Buffer.alloc(71, 7).toString("base64");
const PROVED = JSON.stringify({ v: 1, result: "proved", scheme: "p256", signature: SIGNATURE });
const CHECK_OK = '{"v":1,"canEvaluate":true,"enrolled":true}';

interface Fake {
  readonly dir: string;
  readonly helperPath: string;
  control(value: unknown): void;
  calls(): { argv: string[]; envKeys: string[]; home: string | null }[];
}

const made: string[] = [];

function fakeHelper(): Fake {
  const dir = mkdtempSync(join(tmpdir(), "ccc-fake-presence-"));
  made.push(dir);
  const helperPath = join(dir, "ccc-presence");
  // The executable is a two-line shell wrapper around the fake (an extension-less file would be CommonJS to
  // node); the fake finds its control and log files next to its own copy.
  writeFileSync(join(dir, "fake-presence-helper.mjs"), readFileSync(FAKE_SOURCE, "utf8"));
  writeFileSync(
    helperPath,
    `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "fake-presence-helper.mjs")}" "$@"\n`,
  );
  chmodSync(helperPath, 0o755);
  const fake: Fake = {
    dir,
    helperPath,
    control: (value) => writeFileSync(join(dir, "control.json"), JSON.stringify(value)),
    calls: () => {
      const log = join(dir, "calls.log");
      if (!existsSync(log)) return [];
      return readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
  };
  fake.control({ exit: 0, stdout: `${PROVED}\n` });
  return fake;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HOME = "/Users/<username>";

function port(fake: Fake, custody: PresenceCustody = "K-ATTR", extra: { killMs?: number } = {}) {
  return createHelperPresencePort({
    helperPath: fake.helperPath,
    runner: createExecFileCommandRunner(),
    exists: existsSync,
    homeDir: HOME,
    custody,
    ...extra,
  });
}

/** A runner that records what it was asked and answers with a scripted outcome. */
function scriptedRunner(outcome: Partial<CommandOutcome>) {
  const seen: {
    file: string;
    args: readonly string[];
    options: Parameters<CommandRunner["run"]>[2];
  }[] = [];
  const runner: CommandRunner = {
    async run(file, args, options) {
      seen.push({ file, args, options });
      return {
        exitCode: 0,
        errno: null,
        stdout: "",
        stderr: "",
        truncated: false,
        timedOut: false,
        ...outcome,
      };
    },
  };
  return { runner, seen };
}

describe("09-15 Task 1 (tracer): a helper run becomes one closed presence result", () => {
  it("Test 1: the strict exit-0 line is proved, and the helper got exactly `prove --message <base64>` of the canonical message", async () => {
    const fake = fakeHelper();
    const result = await port(fake).prove(REQUEST);
    expect(result).toEqual({ kind: "proved", scheme: "p256", signature: SIGNATURE });

    const calls = fake.calls();
    expect(calls).toHaveLength(1);
    const argv = calls[0]?.argv ?? [];
    expect(argv).toHaveLength(3);
    expect(argv.slice(0, 2)).toEqual(["prove", "--message"]);
    const decoded = Buffer.from(argv[2] ?? "", "base64");
    expect(decoded.toString("base64")).toBe(argv[2]);
    expect(decoded.toString("utf8")).toBe(
      canonicalJson({
        v: 1,
        proposalId: PROPOSAL_ID,
        operation: "publish",
        payloadHash: PAYLOAD_HASH,
        decision: "approve",
        approvedAt: APPROVED_AT,
      }),
    );
    // The helper's environment was built from scratch: HOME and nothing else of the service's.
    expect(calls[0]?.home).toBe(HOME);
    expect(calls[0]?.envKeys).not.toContain("PATH");
  });

  it("spawns by absolute path through the runner with the documented deadline, cap and environment", async () => {
    expect(PRESENCE_HELPER_KILL_MS).toBe(PRESENCE_PROMPT_TIMEOUT_MS + 2000);
    expect(PRESENCE_HELPER_MAX_OUTPUT_BYTES).toBe(4096);
    expect(PRESENCE_CHECK_TIMEOUT_MS).toBe(5000);
    const { runner, seen } = scriptedRunner({ stdout: `${PROVED}\n` });
    const helperPath = "/Users/<username>/.claude-command-center/bin/ccc-presence";
    const p = createHelperPresencePort({
      helperPath,
      runner,
      exists: () => true,
      homeDir: HOME,
      custody: "K-ATTR",
    });
    await p.prove(REQUEST);
    await p.availability();
    expect(seen).toHaveLength(2);
    expect(seen[0]?.file).toBe(helperPath);
    expect(seen[0]?.options).toEqual({
      timeoutMs: PRESENCE_HELPER_KILL_MS,
      env: { HOME },
      maxBufferBytes: 4096,
    });
    expect(seen[1]?.args).toEqual(["check"]);
    expect(seen[1]?.options).toEqual({ timeoutMs: 5000, env: { HOME }, maxBufferBytes: 4096 });
  });

  it("refuses a relative helper path", () => {
    expect(() =>
      createHelperPresencePort({
        helperPath: "bin/ccc-presence",
        runner: scriptedRunner({}).runner,
        exists: () => true,
        homeDir: HOME,
        custody: "K-ATTR",
      }),
    ).toThrow(/absolute/);
  });
});

describe("09-15 Task 1 Test 2: every other helper outcome is closed", () => {
  it("exit 4 with the strict denied line is denied (with or without the timeout cause)", async () => {
    const fake = fakeHelper();
    fake.control({ exit: 4, stdout: '{"v":1,"result":"denied","error":-2}\n' });
    expect(await port(fake).prove(REQUEST)).toEqual({ kind: "denied" });
    fake.control({ exit: 4, stdout: '{"v":1,"result":"denied","error":-9,"cause":"timeout"}\n' });
    expect(await port(fake).prove(REQUEST)).toEqual({ kind: "denied" });
  });

  it("exit 4 without a strict denied line is unavailable, not a guess", async () => {
    const fake = fakeHelper();
    for (const stdout of [
      "",
      "denied\n",
      '{"v":1,"result":"proved"}\n',
      '{"v":1,"result":"denied","extra":1}\n',
    ]) {
      fake.control({ exit: 4, stdout });
      expect(await port(fake).prove(REQUEST), JSON.stringify(stdout)).toEqual({
        kind: "unavailable",
      });
    }
  });

  it("exit 3, exit 5, exit 2, any other exit and a crash are unavailable even when they print a proved line", async () => {
    const fake = fakeHelper();
    for (const exit of [1, 2, 3, 5, 6, 127, 139]) {
      fake.control({ exit, stdout: `${PROVED}\n` });
      expect(await port(fake).prove(REQUEST), `exit ${exit}`).toEqual({ kind: "unavailable" });
    }
  });

  it("an unparseable, doubled, extended or mistyped exit-0 line is unavailable", async () => {
    const fake = fakeHelper();
    const base = { v: 1, result: "proved", scheme: "p256", signature: SIGNATURE };
    const bad: string[] = [
      "",
      "proved\n",
      `${PROVED}\n${PROVED}\n`,
      `${PROVED}\n\n`,
      ` ${PROVED}\n`,
      `${JSON.stringify({ ...base, extra: true })}\n`,
      `${JSON.stringify({ ...base, v: 2 })}\n`,
      `${JSON.stringify({ ...base, result: "denied" })}\n`,
      `${JSON.stringify({ ...base, signature: null })}\n`,
      `${JSON.stringify({ ...base, signature: "not base64!" })}\n`,
      `${JSON.stringify({ ...base, signature: "AAAA" })}\n`,
      `${JSON.stringify({ ...base, signature: Buffer.alloc(200, 1).toString("base64") })}\n`,
      `${JSON.stringify({ v: 1, result: "proved", scheme: "p256" })}\n`,
      `${JSON.stringify({ ...base, scheme: "none" })}\n`,
      `${JSON.stringify({ ...base, scheme: "rsa" })}\n`,
      `[${PROVED}]\n`,
    ];
    for (const stdout of bad) {
      fake.control({ exit: 0, stdout });
      expect(await port(fake).prove(REQUEST), JSON.stringify(stdout)).toEqual({
        kind: "unavailable",
      });
    }
  });

  it("the scheme must equal the recorded custody's scheme", async () => {
    const fake = fakeHelper();
    const none = `${JSON.stringify({ v: 1, result: "proved", scheme: "none", signature: null })}\n`;
    fake.control({ exit: 0, stdout: none });
    expect(await port(fake, "K-SVC").prove(REQUEST)).toEqual({
      kind: "proved",
      scheme: "none",
      signature: null,
    });
    expect(await port(fake, "K-ATTR").prove(REQUEST)).toEqual({ kind: "unavailable" });
    expect(await port(fake, "K-SE").prove(REQUEST)).toEqual({ kind: "unavailable" });
    fake.control({ exit: 0, stdout: `${PROVED}\n` });
    expect(await port(fake, "K-SVC").prove(REQUEST)).toEqual({ kind: "unavailable" });
    expect(await port(fake, "K-SE").prove(REQUEST)).toEqual({
      kind: "proved",
      scheme: "p256",
      signature: SIGNATURE,
    });
  });

  it("output over the 4096-byte cap is unavailable even when the capped prefix looks fine", async () => {
    const fake = fakeHelper();
    fake.control({ exit: 0, stdoutChunk: "x".repeat(1024), repeat: 10 });
    expect(await port(fake).prove(REQUEST)).toEqual({ kind: "unavailable" });
    // The runner's own truncation flag alone is enough.
    const { runner } = scriptedRunner({ stdout: `${PROVED}\n`, truncated: true });
    const p = createHelperPresencePort({
      helperPath: fake.helperPath,
      runner,
      exists: () => true,
      homeDir: HOME,
      custody: "K-ATTR",
    });
    expect(await p.prove(REQUEST)).toEqual({ kind: "unavailable" });
  });

  it("a missing binary and a spawn failure are unavailable", async () => {
    const fake = fakeHelper();
    rmSync(fake.helperPath);
    expect(await port(fake).prove(REQUEST)).toEqual({ kind: "unavailable" });
    const { runner } = scriptedRunner({ exitCode: null, errno: "ENOENT" });
    const p = createHelperPresencePort({
      helperPath: fake.helperPath,
      runner,
      exists: () => true,
      homeDir: HOME,
      custody: "K-ATTR",
    });
    expect(await p.prove(REQUEST)).toEqual({ kind: "unavailable" });
  });

  it("a run past the deadline is killed and is unavailable", async () => {
    const fake = fakeHelper();
    fake.control({ exit: 0, stdout: `${PROVED}\n`, sleepMs: 10_000 });
    const started = Date.now();
    expect(await port(fake, "K-ATTR", { killMs: 300 }).prove(REQUEST)).toEqual({
      kind: "unavailable",
    });
    expect(Date.now() - started).toBeLessThan(5000);
    const { runner } = scriptedRunner({ exitCode: null, timedOut: true, stdout: `${PROVED}\n` });
    const p = createHelperPresencePort({
      helperPath: fake.helperPath,
      runner,
      exists: () => true,
      homeDir: HOME,
      custody: "K-ATTR",
    });
    expect(await p.prove(REQUEST)).toEqual({ kind: "unavailable" });
  });
});

describe("09-15 Task 1 Test 3: a request that does not match the domain patterns never spawns", () => {
  it("refuses an invalid proposal id, operation, hash or instant before any spawn", async () => {
    const fake = fakeHelper();
    const p = port(fake);
    const bad: PresenceRequest[] = [
      { ...REQUEST, proposalId: "A".repeat(25) as ProposalId },
      { ...REQUEST, proposalId: "a".repeat(24) as ProposalId },
      { ...REQUEST, proposalId: `${"a".repeat(24)}-` as ProposalId },
      { ...REQUEST, operation: "" },
      { ...REQUEST, operation: "Publish" },
      { ...REQUEST, operation: "1publish" },
      { ...REQUEST, operation: 'publish"; rm -rf /' },
      { ...REQUEST, operation: "a".repeat(65) },
      { ...REQUEST, payloadHash: "B".repeat(64) },
      { ...REQUEST, payloadHash: "b".repeat(63) },
      { ...REQUEST, payloadHash: `${"b".repeat(63)}g` },
      { ...REQUEST, approvedAt: "yesterday" },
      { ...REQUEST, approvedAt: "2026-10-28 12:00:00Z" },
      { ...REQUEST, approvedAt: "2026-02-30T12:00:00.000Z" },
      { ...REQUEST, approvedAt: "2026-10-28T12:00:00" },
      { ...REQUEST, approvedAt: "1969-12-31T23:59:59.000Z" },
      { ...REQUEST, approvedAt: "2026-10-28T24:00:00.000Z" },
    ];
    for (const request of bad) {
      expect(await p.prove(request), JSON.stringify(request)).toEqual({ kind: "unavailable" });
    }
    expect(fake.calls()).toEqual([]);
  });

  it("accepts the instant forms the service produces and the helper accepts", async () => {
    const fake = fakeHelper();
    for (const approvedAt of [
      "2026-10-28T12:00:00.000Z",
      "2026-10-28T12:00:00Z",
      "2024-02-29T23:59:59.123456789Z",
    ]) {
      expect(await port(fake).prove({ ...REQUEST, approvedAt }), approvedAt).toMatchObject({
        kind: "proved",
      });
    }
  });
});

describe("09-15 Task 1 Test 4: availability asks the non-prompting check", () => {
  it("is unavailable, with no spawn, when the binary is absent", async () => {
    const fake = fakeHelper();
    rmSync(fake.helperPath);
    expect(await port(fake).availability()).toBe("unavailable");
    expect(fake.calls()).toEqual([]);
    const { runner, seen } = scriptedRunner({ stdout: `${CHECK_OK}\n` });
    const p = createHelperPresencePort({
      helperPath: fake.helperPath,
      runner,
      exists: () => false,
      homeDir: HOME,
      custody: "K-ATTR",
    });
    expect(await p.availability()).toBe("unavailable");
    expect(seen).toEqual([]);
  });

  it("is available for a check that can evaluate and is enrolled", async () => {
    const fake = fakeHelper();
    fake.control({ exit: 0, stdout: `${CHECK_OK}\n` });
    expect(await port(fake).availability()).toBe("available");
    expect(fake.calls().map((c) => c.argv)).toEqual([["check"]]);
    fake.control({
      exit: 0,
      stdout: '{"v":1,"canEvaluate":true,"biometry":"touch-id","enrolled":true}\n',
    });
    expect(await port(fake).availability()).toBe("available");
  });

  it("is unavailable when it cannot evaluate, or (K-SE, K-ATTR) is not enrolled", async () => {
    const fake = fakeHelper();
    fake.control({ exit: 3, stdout: '{"v":1,"canEvaluate":false,"error":-5}\n' });
    expect(await port(fake).availability()).toBe("unavailable");
    fake.control({ exit: 0, stdout: '{"v":1,"canEvaluate":false,"enrolled":true}\n' });
    expect(await port(fake).availability()).toBe("unavailable");
    fake.control({ exit: 0, stdout: '{"v":1,"canEvaluate":true,"enrolled":false}\n' });
    expect(await port(fake, "K-ATTR").availability()).toBe("unavailable");
    expect(await port(fake, "K-SE").availability()).toBe("unavailable");
    // No key, nothing to enrol: K-SVC does not need the field.
    fake.control({ exit: 0, stdout: '{"v":1,"canEvaluate":true}\n' });
    expect(await port(fake, "K-SVC").availability()).toBe("available");
    expect(await port(fake, "K-ATTR").availability()).toBe("unavailable");
  });

  it("FIX6B M1: a stale pin (the helper was rebuilt without a re-enrol) is unavailable, for every custody", async () => {
    const fake = fakeHelper();
    // What the helper prints for a pin another binary enrolled.
    fake.control({
      exit: 0,
      stdout: '{"v":1,"canEvaluate":true,"biometry":"touch-id","enrolled":false,"stale":true}\n',
    });
    for (const custody of ["K-ATTR", "K-SE", "K-SVC"] as const) {
      expect(await port(fake, custody).availability(), custody).toBe("unavailable");
    }
    // A line that claims both enrolled and stale contradicts itself: never available.
    fake.control({ exit: 0, stdout: '{"v":1,"canEvaluate":true,"enrolled":true,"stale":true}\n' });
    expect(await port(fake).availability()).toBe("unavailable");
    // stale is a boolean when present.
    fake.control({ exit: 0, stdout: '{"v":1,"canEvaluate":true,"enrolled":true,"stale":"no"}\n' });
    expect(await port(fake).availability()).toBe("unavailable");
    // stale:false changes nothing for an enrolled pin.
    fake.control({ exit: 0, stdout: '{"v":1,"canEvaluate":true,"enrolled":true,"stale":false}\n' });
    expect(await port(fake).availability()).toBe("available");
  });

  it("is unavailable for a mistyped, doubled or extended check line and for any other exit", async () => {
    const fake = fakeHelper();
    const bad = [
      "",
      "ok\n",
      `${CHECK_OK}\n${CHECK_OK}\n`,
      '{"v":1,"canEvaluate":"yes","enrolled":true}\n',
      '{"v":2,"canEvaluate":true,"enrolled":true}\n',
      '{"v":1,"canEvaluate":true,"enrolled":true,"extra":1}\n',
    ];
    for (const stdout of bad) {
      fake.control({ exit: 0, stdout });
      expect(await port(fake).availability(), JSON.stringify(stdout)).toBe("unavailable");
    }
    fake.control({ exit: 5, stdout: `${CHECK_OK}\n` });
    expect(await port(fake).availability()).toBe("unavailable");
  });
});

describe("09-15 Task 1 Test 5: a sandbox or test environment gets the fail-closed port", () => {
  it("answers unavailable and never spawns when CCC_INSTALL_SECRET_ACCOUNT is set", async () => {
    const fake = fakeHelper();
    fake.control({ exit: 0, stdout: `${PROVED}\n` });
    const runtimeDir = join(fake.dir, "runtime");
    mkdirSync(join(runtimeDir, "bin"), { recursive: true });
    writeFileSync(join(runtimeDir, "bin", "ccc-presence"), readFileSync(fake.helperPath));
    chmodSync(join(runtimeDir, "bin", "ccc-presence"), 0o755);
    const sentinel = join(fake.dir, "calls.log");
    const { runner, seen } = scriptedRunner({ stdout: `${PROVED}\n` });
    const p = presencePortFromEnv({ CCC_INSTALL_SECRET_ACCOUNT: "x" }, runtimeDir, {
      runner,
      exists: existsSync,
      homeDir: HOME,
    });
    expect(await p.prove(REQUEST)).toEqual({ kind: "unavailable" });
    expect(await p.availability()).toBe("unavailable");
    expect(seen).toEqual([]);
    expect(existsSync(sentinel)).toBe(false);
  });

  it("without the variable, builds the helper port at <runtime dir>/bin/ccc-presence", async () => {
    const { runner, seen } = scriptedRunner({ stdout: `${CHECK_OK}\n` });
    const p = presencePortFromEnv({}, "/Users/<username>/.claude-command-center", {
      runner,
      exists: () => true,
      homeDir: HOME,
    });
    expect(await p.availability()).toBe("available");
    expect(seen[0]?.file).toBe("/Users/<username>/.claude-command-center/bin/ccc-presence");
    expect(() =>
      presencePortFromEnv({}, "relative/dir", { runner, exists: () => true, homeDir: HOME }),
    ).toThrow(/absolute/);
  });
});

// ---------------------------------------------------------------------------
// 09-18 Task 3: the pin reader and the pin-change guard

describe("pinReaderFromEnv (09-18 Task 3, Test 1)", () => {
  it("answers null and never reads the Keychain when CCC_INSTALL_SECRET_ACCOUNT is set", async () => {
    let calls = 0;
    const read = pinReaderFromEnv({ CCC_INSTALL_SECRET_ACCOUNT: "x" }, async () => {
      calls += 1;
      return "pin";
    });
    expect(await read()).toBeNull();
    expect(await read()).toBeNull();
    expect(calls).toBe(0);
  });

  it("without the variable reads the pin item once per read", async () => {
    const seen: string[] = [];
    const read = pinReaderFromEnv({}, async (account) => {
      seen.push(account);
      return "the-pin";
    });
    expect(await read()).toBe("the-pin");
    expect(await read()).toBe("the-pin");
    expect(seen).toEqual(["approval-presence-pin", "approval-presence-pin"]);
    expect(PRESENCE_PIN_ACCOUNT).toBe("approval-presence-pin");
  });

  it("treats a throwing reader as no pin", async () => {
    const read = pinReaderFromEnv({}, async () => {
      throw new Error("keychain down");
    });
    expect(await read()).toBeNull();
  });
});

describe("guardPinReader: trust on first use and refusal of a changed pin (spike: Residual, detection)", () => {
  const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
  type MarkerState = "absent" | "fresh" | "stale" | "not-regular";

  function setup(initialRecorded: string | null = null, markerState: MarkerState = "absent") {
    let current: string | null = "pin-one";
    let recorded = initialRecorded;
    let marker: MarkerState = markerState;
    const lines: { level: "info" | "warn"; fields: Record<string, unknown> }[] = [];
    const read = guardPinReader({
      read: async () => current,
      recorded: {
        get: () => recorded,
        set: (v) => {
          recorded = v;
        },
      },
      installMarker: {
        inspect: () => marker,
        clear: () => {
          marker = "absent";
        },
      },
      log: {
        info: (fields) => void lines.push({ level: "info", fields }),
        warn: (fields) => void lines.push({ level: "warn", fields }),
      },
    });
    return {
      read,
      lines,
      set: (pin: string | null) => {
        current = pin;
      },
      recorded: () => recorded,
      marker: () => marker,
      touchMarker: () => {
        marker = "fresh";
      },
    };
  }

  it("records the SHA-256 of the first pin it sees and returns it (a boot-time read is the trust-on-first-use point)", async () => {
    const g = setup();
    expect(await g.read()).toBe("pin-one");
    expect(g.recorded()).toBe(sha("pin-one"));
  });

  it("returns the same pin on later reads and records nothing more", async () => {
    const g = setup(sha("pin-one"));
    expect(await g.read()).toBe("pin-one");
    expect(g.lines).toEqual([]);
  });

  it("refuses a changed pin outside an install, with one closed presence-pin-changed warning per change", async () => {
    const g = setup(sha("pin-one"));
    g.set("pin-two");
    expect(await g.read()).toBeNull();
    expect(await g.read()).toBeNull();
    expect(g.recorded()).toBe(sha("pin-one"));
    expect(g.lines).toEqual([{ level: "warn", fields: { code: "presence-pin-changed" } }]);
    // Only the pin it was trusted to hold is accepted again.
    g.set("pin-one");
    expect(await g.read()).toBe("pin-one");
  });

  it("adopts a changed pin once, when an install left a fresh marker, clears it and logs the adoption at warn level", async () => {
    const g = setup(sha("pin-one"), "fresh");
    g.set("pin-two");
    expect(await g.read()).toBe("pin-two");
    expect(g.recorded()).toBe(sha("pin-two"));
    expect(g.marker()).toBe("absent");
    expect(g.lines).toEqual([{ level: "warn", fields: { code: "presence-pin-adopted" } }]);
    // The marker was used up: a later change is refused again.
    g.set("pin-three");
    expect(await g.read()).toBeNull();
  });

  it("09-FIX9: a marker older than the window is ignored, deleted and logged, and a changed pin is still refused", async () => {
    const g = setup(sha("pin-one"), "stale");
    g.set("pin-two");
    expect(await g.read()).toBeNull();
    expect(g.recorded()).toBe(sha("pin-one"));
    expect(g.marker()).toBe("absent");
    expect(g.lines).toEqual([
      { level: "warn", fields: { code: "presence-pin-marker-ignored" } },
      { level: "warn", fields: { code: "presence-pin-changed" } },
    ]);
  });

  it("09-FIX9: a marker that is not a regular file is ignored the same way", async () => {
    const g = setup(sha("pin-one"), "not-regular");
    g.set("pin-two");
    expect(await g.read()).toBeNull();
    expect(g.marker()).toBe("absent");
    expect(g.lines.map((l) => l.fields.code)).toEqual([
      "presence-pin-marker-ignored",
      "presence-pin-changed",
    ]);
  });

  it("09-FIX9: a stale marker beside an unchanged pin is cleared and logged but changes nothing else", async () => {
    const g = setup(sha("pin-one"), "stale");
    expect(await g.read()).toBe("pin-one");
    expect(g.marker()).toBe("absent");
    expect(g.lines).toEqual([{ level: "warn", fields: { code: "presence-pin-marker-ignored" } }]);
  });

  it("an install marker is cleared on the first sight of a pin too (no standing permission)", async () => {
    const g = setup(null, "fresh");
    expect(await g.read()).toBe("pin-one");
    expect(g.recorded()).toBe(sha("pin-one"));
    expect(g.marker()).toBe("absent");
    g.touchMarker();
    expect(await g.read()).toBe("pin-one");
    expect(g.marker()).toBe("absent");
  });

  it("no pin means no pin: nothing is recorded, adopted or warned about", async () => {
    const g = setup(sha("pin-one"), "fresh");
    g.set(null);
    expect(await g.read()).toBeNull();
    expect(g.recorded()).toBe(sha("pin-one"));
    expect(g.marker()).toBe("fresh");
    expect(g.lines).toEqual([]);
  });

  it("never logs the pin or its hash", async () => {
    const g = setup(sha("pin-one"));
    g.set("pin-two");
    await g.read();
    const text = JSON.stringify(g.lines);
    expect(text).not.toContain("pin-one");
    expect(text).not.toContain("pin-two");
    expect(text).not.toContain(sha("pin-one"));
    expect(text).not.toContain(sha("pin-two"));
  });

  it("fails closed when the recorded value cannot be read or written", async () => {
    const read = guardPinReader({
      read: async () => "pin-one",
      recorded: {
        get: () => {
          throw new Error("db down");
        },
        set: () => undefined,
      },
      installMarker: { inspect: () => "absent", clear: () => undefined },
      log: { info: () => undefined, warn: () => undefined },
    });
    expect(await read()).toBeNull();
  });
});

describe("createInstallMarker: a single-use, time-bound file (09-FIX9)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "ccc-marker-"));
    dirs.push(dir);
    const path = join(dir, "presence-pin-installed");
    const nowMs = Date.parse("2026-10-29T12:00:00.000Z");
    const marker = createInstallMarker({
      path,
      now: () => nowMs,
      lstat: lstatSync,
      unlink: unlinkSync,
    });
    const place = (ageMs: number): void => {
      writeFileSync(path, "");
      const at = new Date(nowMs - ageMs);
      utimesSync(path, at, at);
    };
    return { dir, path, marker, place, nowMs };
  }

  it("is absent when there is no file", () => {
    expect(fixture().marker.inspect()).toBe("absent");
  });

  it("is fresh inside the window and stale beyond it; the window is ten minutes", () => {
    expect(PRESENCE_PIN_INSTALL_MARKER_MAX_AGE_MS).toBe(10 * 60 * 1000);
    const f = fixture();
    f.place(0);
    expect(f.marker.inspect()).toBe("fresh");
    f.place(PRESENCE_PIN_INSTALL_MARKER_MAX_AGE_MS - 1000);
    expect(f.marker.inspect()).toBe("fresh");
    f.place(PRESENCE_PIN_INSTALL_MARKER_MAX_AGE_MS + 1000);
    expect(f.marker.inspect()).toBe("stale");
  });

  it("a modification time far in the future is stale too (a marker cannot be made to last)", () => {
    const f = fixture();
    f.place(-60 * 60 * 1000);
    expect(f.marker.inspect()).toBe("stale");
  });

  it("a directory and a symbolic link are not regular files, and clear() removes a link without following it", () => {
    const f = fixture();
    mkdirSync(f.path);
    expect(f.marker.inspect()).toBe("not-regular");
    rmSync(f.path, { recursive: true });
    const target = join(f.dir, "target");
    writeFileSync(target, "");
    symlinkSync(target, f.path);
    expect(f.marker.inspect()).toBe("not-regular");
    f.marker.clear();
    expect(existsSync(f.path)).toBe(false);
    expect(existsSync(target)).toBe(true);
  });

  it("clear() removes a regular marker and never throws when there is none", () => {
    const f = fixture();
    f.place(0);
    f.marker.clear();
    expect(existsSync(f.path)).toBe(false);
    expect(() => f.marker.clear()).not.toThrow();
  });

  it("a boot-time read with a fresh marker and a replaced pin adopts it once and consumes the file", async () => {
    const f = fixture();
    f.place(1000);
    let recorded: string | null = createHash("sha256").update("pin-one").digest("hex");
    const lines: Record<string, unknown>[] = [];
    const read = guardPinReader({
      read: async () => "pin-two",
      recorded: {
        get: () => recorded,
        set: (v) => {
          recorded = v;
        },
      },
      installMarker: f.marker,
      log: { info: (x) => void lines.push(x), warn: (x) => void lines.push(x) },
    });
    expect(await read()).toBe("pin-two");
    expect(existsSync(f.path)).toBe(false);
    expect(lines).toEqual([{ code: "presence-pin-adopted" }]);
  });
});

// ---------------------------------------------------------------------------
// 09-19: the closed reason behind an unavailable check, and the pin observation Diagnostics shows

describe("09-19: inspect() names why the presence check is unavailable (closed reasons, never free text)", () => {
  it("helper absent: helper-missing, no spawn", async () => {
    const fake = fakeHelper();
    rmSync(fake.helperPath);
    expect(await port(fake).inspect()).toEqual({ state: "unavailable", reason: "helper-missing" });
    expect(fake.calls()).toEqual([]);
  });

  it("available has no reason and agrees with availability()", async () => {
    const fake = fakeHelper();
    fake.control({ exit: 0, stdout: `${CHECK_OK}\n` });
    expect(await port(fake).inspect()).toEqual({ state: "available", reason: null });
  });

  it("cannot evaluate, not enrolled and stale are told apart", async () => {
    const fake = fakeHelper();
    fake.control({ exit: 3, stdout: '{"v":1,"canEvaluate":false,"error":-5}\n' });
    expect(await port(fake).inspect()).toEqual({ state: "unavailable", reason: "cannot-evaluate" });
    fake.control({ exit: 0, stdout: '{"v":1,"canEvaluate":false,"enrolled":true}\n' });
    expect(await port(fake).inspect()).toEqual({ state: "unavailable", reason: "cannot-evaluate" });
    fake.control({ exit: 0, stdout: '{"v":1,"canEvaluate":true,"enrolled":false}\n' });
    expect(await port(fake).inspect()).toEqual({ state: "unavailable", reason: "not-enrolled" });
    fake.control({
      exit: 0,
      stdout: '{"v":1,"canEvaluate":true,"enrolled":false,"stale":true}\n',
    });
    expect(await port(fake).inspect()).toEqual({ state: "unavailable", reason: "pin-stale" });
    // A contradictory line is a failed check, never available.
    fake.control({ exit: 0, stdout: '{"v":1,"canEvaluate":true,"enrolled":true,"stale":true}\n' });
    expect(await port(fake).inspect()).toEqual({ state: "unavailable", reason: "pin-stale" });
  });

  it("every malformed, truncated, doubled or non-zero outcome is check-failed", async () => {
    const fake = fakeHelper();
    for (const stdout of [
      "",
      "ok\n",
      `${CHECK_OK}\n${CHECK_OK}\n`,
      '{"v":2,"canEvaluate":true}\n',
    ]) {
      fake.control({ exit: 0, stdout });
      expect(await port(fake).inspect(), JSON.stringify(stdout)).toEqual({
        state: "unavailable",
        reason: "check-failed",
      });
    }
    fake.control({ exit: 5, stdout: `${CHECK_OK}\n` });
    expect(await port(fake).inspect()).toEqual({ state: "unavailable", reason: "check-failed" });
  });

  it("a timed-out check is check-failed", async () => {
    const { runner } = scriptedRunner({ timedOut: true, exitCode: null });
    const p = createHelperPresencePort({
      helperPath: "/Users/<username>/.claude-command-center/bin/ccc-presence",
      runner,
      exists: () => true,
      homeDir: HOME,
      custody: "K-ATTR",
    });
    expect(await p.inspect()).toEqual({ state: "unavailable", reason: "check-failed" });
  });

  it("the sandbox port answers sandbox and spawns nothing (T-09-33)", async () => {
    const { runner, seen } = scriptedRunner({ stdout: `${CHECK_OK}\n` });
    const p = presencePortFromEnv({ CCC_INSTALL_SECRET_ACCOUNT: "x" }, "/Users/<username>/rt", {
      runner,
      exists: () => true,
      homeDir: HOME,
    });
    expect(await p.inspect()).toEqual({ state: "unavailable", reason: "sandbox" });
    expect(seen).toEqual([]);
    expect(isPresenceSandbox({ CCC_INSTALL_SECRET_ACCOUNT: "x" })).toBe(true);
    expect(isPresenceSandbox({})).toBe(false);
  });
});

describe("09-19: guardPinReader reports what it saw (verdict and a short non-secret fingerprint)", () => {
  const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

  function observed(
    initial: string | null,
    current: string | null,
    marker: "absent" | "fresh" = "absent",
  ) {
    const seen: PinObservation[] = [];
    let recorded = initial;
    let markerState: "absent" | "fresh" = marker;
    const read = guardPinReader({
      read: async () => current,
      recorded: {
        get: () => recorded,
        set: (v) => {
          recorded = v;
        },
      },
      installMarker: {
        inspect: () => markerState,
        clear: () => {
          markerState = "absent";
        },
      },
      log: { info: () => undefined, warn: () => undefined },
      observe: (o) => void seen.push(o),
    });
    return { read, seen };
  }

  it("a first pin is trusted with the first eight hex characters of its SHA-256", async () => {
    const g = observed(null, "pin-one");
    await g.read();
    expect(g.seen).toEqual([{ verdict: "trusted", fingerprint: sha("pin-one").slice(0, 8) }]);
  });

  it("a changed pin outside an install is changed, carrying the fingerprint of the pin now in the Keychain", async () => {
    const g = observed(sha("pin-one"), "pin-two");
    expect(await g.read()).toBeNull();
    expect(g.seen).toEqual([{ verdict: "changed", fingerprint: sha("pin-two").slice(0, 8) }]);
  });

  it("an adopted pin (fresh install marker) is adopted", async () => {
    const g = observed(sha("pin-one"), "pin-two", "fresh");
    await g.read();
    expect(g.seen).toEqual([{ verdict: "adopted", fingerprint: sha("pin-two").slice(0, 8) }]);
  });

  it("no pin, or a read that throws, is none with no fingerprint", async () => {
    const none = observed(null, null);
    await none.read();
    expect(none.seen).toEqual([{ verdict: "none", fingerprint: null }]);
    const seen: PinObservation[] = [];
    const read = guardPinReader({
      read: async () => {
        throw new Error("boom");
      },
      recorded: { get: () => null, set: () => undefined },
      installMarker: { inspect: () => "absent", clear: () => undefined },
      log: { info: () => undefined, warn: () => undefined },
      observe: (o) => void seen.push(o),
    });
    expect(await read()).toBeNull();
    expect(seen).toEqual([{ verdict: "none", fingerprint: null }]);
  });

  it("the fingerprint is never the pin and never longer than eight hex characters", async () => {
    const g = observed(null, "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA");
    await g.read();
    const fp = g.seen[0]?.fingerprint ?? "";
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
  });

  it("observe is optional (existing callers are unchanged)", async () => {
    const read = guardPinReader({
      read: async () => "pin",
      recorded: { get: () => null, set: () => undefined },
      installMarker: { inspect: () => "absent", clear: () => undefined },
      log: { info: () => undefined, warn: () => undefined },
    });
    expect(await read()).toBe("pin");
  });
});

describe("09-FIX10A: observed() hands each read its own conclusion", () => {
  const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

  it("two reads in flight through one guard each report their own verdict, whichever settles last", async () => {
    const pins = ["pin-two", "pin-one"];
    const releases: (() => void)[] = [];
    const guard = guardPinReader({
      read: () =>
        new Promise<string | null>((resolve) => {
          const pin = pins.shift() ?? null;
          releases.push(() => resolve(pin));
        }),
      recorded: { get: () => sha("pin-one"), set: () => undefined },
      installMarker: { inspect: () => "absent", clear: () => undefined },
      log: { info: () => undefined, warn: () => undefined },
    });
    const first = guard.observed(); // sees pin-two: changed
    const second = guard.observed(); // sees pin-one: trusted
    releases[1]?.();
    releases[0]?.();
    expect(await second).toEqual({
      pin: "pin-one",
      observation: { verdict: "trusted", fingerprint: sha("pin-one").slice(0, 8) },
    });
    expect(await first).toEqual({
      pin: null,
      observation: { verdict: "changed", fingerprint: sha("pin-two").slice(0, 8) },
    });
  });

  it("the plain reader and observed() are one guard: same pin, same record", async () => {
    let recorded: string | null = null;
    const guard = guardPinReader({
      read: async () => "pin-one",
      recorded: {
        get: () => recorded,
        set: (v) => {
          recorded = v;
        },
      },
      installMarker: { inspect: () => "absent", clear: () => undefined },
      log: { info: () => undefined, warn: () => undefined },
    });
    expect(await guard()).toBe("pin-one");
    expect(recorded).toBe(sha("pin-one"));
    expect((await guard.observed()).observation.verdict).toBe("trusted");
  });
});
