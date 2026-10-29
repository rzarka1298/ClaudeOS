import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execaMock = vi.fn();
vi.mock("execa", () => ({
  execa: (...args: unknown[]) => execaMock(...args),
}));

const {
  getSecret,
  setSecret,
  deleteSecret,
  hasSecret,
  readItemComment,
  SERVICE_NAME,
  UnsafeSecretInputError,
} = await import("./security-cli.js");

beforeEach(() => {
  execaMock.mockReset();
});

describe("security-cli", () => {
  it("returns null when the spawned process exits with code 44 (item not found)", async () => {
    execaMock.mockRejectedValueOnce(Object.assign(new Error("not found"), { exitCode: 44 }));
    const result = await getSecret("some-account");
    expect(result).toBeNull();
  });

  it("rethrows for any other non-zero exit", async () => {
    const err = Object.assign(new Error("boom"), { exitCode: 1 });
    execaMock.mockRejectedValueOnce(err);
    await expect(getSecret("some-account")).rejects.toBe(err);
  });

  it("returns trimmed stdout on success", async () => {
    execaMock.mockResolvedValueOnce({ stdout: "  secret-value  \n" });
    const result = await getSecret("some-account");
    expect(result).toBe("secret-value");
  });

  it("calls execa with an argument array of separate strings for get()", async () => {
    execaMock.mockResolvedValueOnce({ stdout: "value" });
    await getSecret("my-account");
    expect(execaMock).toHaveBeenCalledWith("/usr/bin/security", [
      "find-generic-password",
      "-a",
      "my-account",
      "-s",
      SERVICE_NAME,
      "-w",
    ]);
    const [, args] = execaMock.mock.calls[0] as [string, unknown[]];
    for (const arg of args) {
      expect(typeof arg).toBe("string");
    }
    // No element was produced by concatenating the account name into a
    // larger string — every element is exactly one of the known flags or
    // exactly the account/service name, never a substring match inside a
    // longer token.
    expect(args).not.toContain("find-generic-password my-account");
    expect(args.some((a) => typeof a === "string" && a.includes(" "))).toBe(false);
  });

  it("set() spawns `security -i` with no secret material in argv, and sends the secret via stdin", async () => {
    execaMock.mockResolvedValueOnce({ stdout: "" });
    await setSecret("my-account", "my-value");
    expect(execaMock).toHaveBeenCalledTimes(1);
    const [bin, args, options] = execaMock.mock.calls[0] as [string, string[], { input?: string }];
    expect(bin).toBe("/usr/bin/security");
    // argv contains only "-i" — no account, no service name, no secret.
    expect(args).toEqual(["-i"]);
    for (const arg of args) {
      expect(arg).not.toContain("my-value");
    }
    // The secret travels over stdin as the `input` option, not argv.
    expect(options?.input).toContain("my-value");
    expect(options?.input).toContain("my-account");
    expect(options?.input).toContain(SERVICE_NAME);
    expect(options?.input).toMatch(/^add-generic-password /);
  });

  it("set() rejects an account containing a double quote instead of escaping it", async () => {
    await expect(setSecret('bad"account', "my-value")).rejects.toBeInstanceOf(
      UnsafeSecretInputError,
    );
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("set() rejects a value containing a newline instead of escaping it", async () => {
    await expect(setSecret("my-account", "line1\nline2")).rejects.toBeInstanceOf(
      UnsafeSecretInputError,
    );
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("set() rejects a value containing a backslash (allowlist, not a denylist)", async () => {
    await expect(setSecret("my-account", 'esc\\"pe')).rejects.toBeInstanceOf(
      UnsafeSecretInputError,
    );
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("set() rejects a value containing control characters (\\x00-\\x1f)", async () => {
    await expect(setSecret("my-account", "value\x00tail")).rejects.toBeInstanceOf(
      UnsafeSecretInputError,
    );
    await expect(setSecret("my-account", "value\x1ftail")).rejects.toBeInstanceOf(
      UnsafeSecretInputError,
    );
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("set() rejects an account containing a backslash", async () => {
    await expect(setSecret("bad\\account", "my-value")).rejects.toBeInstanceOf(
      UnsafeSecretInputError,
    );
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("set() accepts a real randomBytes(32) base64url value, unchanged", async () => {
    execaMock.mockResolvedValueOnce({ stdout: "" });
    const value = randomBytes(32).toString("base64url");
    await setSecret("install-secret", value);
    const [, , options] = execaMock.mock.calls[0] as [string, string[], { input?: string }];
    expect(options?.input).toContain(value);
  });

  it("set() accepts a real randomBytes(32) standard-base64 value, unchanged", async () => {
    execaMock.mockResolvedValueOnce({ stdout: "" });
    const value = randomBytes(32).toString("base64");
    await setSecret("install-secret", value);
    const [, , options] = execaMock.mock.calls[0] as [string, string[], { input?: string }];
    expect(options?.input).toContain(value);
  });

  it("calls execa with an argument array of separate strings for delete()", async () => {
    execaMock.mockResolvedValueOnce({ stdout: "" });
    await deleteSecret("my-account");
    expect(execaMock).toHaveBeenCalledWith("/usr/bin/security", [
      "delete-generic-password",
      "-a",
      "my-account",
      "-s",
      SERVICE_NAME,
    ]);
  });
});

// ---------------------------------------------------------------------------
// hasSecret (plan 08-04, D-38, T-08-06..T-08-08): presence without the secret.
//
// Every case here runs against a mocked execa. By owner instruction the tests
// never call the real /usr/bin/security (the login Keychain is off limits to
// automated runs); the first real-keychain check is the owner UAT item (D-38).

describe("hasSecret", () => {
  const ACCOUNT = "ccc-probe-absent-0123456789abcdef";

  it("Test 1 (tracer): an absent item (exit 44) resolves absent without throwing", async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 44, failed: true });
    await expect(hasSecret(ACCOUNT)).resolves.toBe("absent");
    expect(execaMock).toHaveBeenCalledTimes(1);
  });

  it("Test 2: spawns the absolute binary with exactly the attribute-only argv, never -w or -g", async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, failed: false });
    await hasSecret(ACCOUNT);
    const [bin, args, options] = execaMock.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(bin).toBe("/usr/bin/security");
    expect(args).toEqual(["find-generic-password", "-a", ACCOUNT, "-s", SERVICE_NAME]);
    expect(args).not.toContain("-w");
    expect(args).not.toContain("-g");
    expect(args.some((arg) => /^-[A-Za-z]*[wg][A-Za-z]*$/.test(arg))).toBe(false);
    // Bounded, shell-free, and no output is ever captured into a result.
    expect(options).toMatchObject({
      reject: false,
      timeout: 1500,
      killSignal: "SIGKILL",
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(options.shell).toBeUndefined();
  });

  it("Test 3: exit 0 is present, 44 absent, anything else or a spawn failure is error", async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, failed: false });
    await expect(hasSecret(ACCOUNT)).resolves.toBe("present");

    execaMock.mockResolvedValueOnce({ exitCode: 44, failed: true });
    await expect(hasSecret(ACCOUNT)).resolves.toBe("absent");

    execaMock.mockResolvedValueOnce({ exitCode: 51, failed: true });
    await expect(hasSecret(ACCOUNT)).resolves.toBe("error");

    execaMock.mockResolvedValueOnce({ exitCode: 1, failed: true });
    await expect(hasSecret(ACCOUNT)).resolves.toBe("error");

    // A spawn error that execa surfaces as a rejection still resolves, never throws.
    execaMock.mockRejectedValueOnce(Object.assign(new Error("spawn"), { code: "ENOENT" }));
    await expect(hasSecret(ACCOUNT)).resolves.toBe("error");
  });

  it("Test 3b: a timeout (the child is SIGKILLed by execa) resolves error, never present or absent", async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: undefined,
      failed: true,
      timedOut: true,
      isTerminated: true,
      signal: "SIGKILL",
    });
    await expect(hasSecret(ACCOUNT)).resolves.toBe("error");
    // A killed child that happens to report a stale exit code of 0 or 44 is still not an answer.
    execaMock.mockResolvedValueOnce({ exitCode: 44, failed: true, timedOut: true });
    await expect(hasSecret(ACCOUNT)).resolves.toBe("error");
    execaMock.mockResolvedValueOnce({ exitCode: 0, failed: true, isTerminated: true });
    await expect(hasSecret(ACCOUNT)).resolves.toBe("error");
  });

  it("Test 4: an account with a space, a quote, a newline or a leading dash throws before any spawn", async () => {
    for (const bad of [
      "has space",
      'has"quote',
      "line\nbreak",
      "-w",
      "-leading-dash",
      "",
      "semi;colon",
    ]) {
      await expect(hasSecret(bad), JSON.stringify(bad)).rejects.toBeInstanceOf(
        UnsafeSecretInputError,
      );
    }
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("does not change what getSecret asks for (it still reads the value)", async () => {
    execaMock.mockResolvedValueOnce({ stdout: "value" });
    await getSecret("my-account");
    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args).toContain("-w");
  });
});

describe("FIX1A hardening: every spawn is the absolute /usr/bin/security, never a PATH lookup", () => {
  it("get, set, delete and has all spawn the absolute binary", async () => {
    execaMock.mockReset();
    execaMock.mockResolvedValue({ stdout: "v", exitCode: 0, failed: false });
    await getSecret("my-account");
    await setSecret("my-account", "abc123");
    await deleteSecret("my-account");
    await hasSecret("my-account");
    const binaries = execaMock.mock.calls.map((call) => call[0]);
    expect(binaries).toEqual([
      "/usr/bin/security",
      "/usr/bin/security",
      "/usr/bin/security",
      "/usr/bin/security",
    ]);
  });
});

describe("hasSecret with the caller's abort signal (plan 08-12, FIX2A)", () => {
  const ACCOUNT = "ccc-probe-absent-0123456789abcdef";

  it("hands the signal to execa as cancelSignal, so an abort kills the child", async () => {
    const controller = new AbortController();
    execaMock.mockResolvedValueOnce({ exitCode: 44, failed: true });
    await expect(hasSecret(ACCOUNT, { signal: controller.signal })).resolves.toBe("absent");
    const [, , options] = execaMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(options.cancelSignal).toBe(controller.signal);
  });

  it("adds no cancelSignal when no signal is given", async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 44, failed: true });
    await hasSecret(ACCOUNT);
    const [, , options] = execaMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect("cancelSignal" in options).toBe(false);
  });

  it("answers error without spawning when the signal has already fired", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(hasSecret(ACCOUNT, { signal: controller.signal })).resolves.toBe("error");
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("a canceled child is error whatever exit code it reports", async () => {
    const controller = new AbortController();
    execaMock.mockResolvedValueOnce({ exitCode: 44, failed: true, isCanceled: true });
    await expect(hasSecret(ACCOUNT, { signal: controller.signal })).resolves.toBe("error");
    execaMock.mockResolvedValueOnce({ exitCode: 0, failed: true, isCanceled: true });
    await expect(hasSecret(ACCOUNT, { signal: controller.signal })).resolves.toBe("error");
  });

  it("still rejects an unsafe account before any spawn, signal or not", async () => {
    const controller = new AbortController();
    await expect(hasSecret("has space", { signal: controller.signal })).rejects.toBeInstanceOf(
      UnsafeSecretInputError,
    );
    expect(execaMock).not.toHaveBeenCalled();
  });
});

// readItemComment (plan 09-15, R-02, ADR 0017 attribute-read pattern): the pinned public key, read without
// the secret. The service reads the approval-presence pin through this and nothing else.
describe("readItemComment", () => {
  const ACCOUNT = "approval-presence-pin";
  // A P-256 SPKI is 91 bytes: 26 header bytes, then the 65-byte X9.63 point.
  const SPKI = Buffer.concat([
    Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"),
    Buffer.from([0x04]),
    Buffer.alloc(64, 0x11),
  ]).toString("base64");
  const output = (comment: string): string =>
    [
      'keychain: "/Users/<username>/Library/Keychains/login.keychain-db"',
      "version: 512",
      'class: "genp"',
      "attributes:",
      '    0x00000007 <blob>="Claude Command Center approval presence (safe to delete)"',
      '    "acct"<blob>="approval-presence-pin"',
      `    "icmt"<blob>=${comment}`,
      '    "svce"<blob>="com.claude-command-center"',
      "",
    ].join("\n");

  it("Test 1 (tracer): runs exactly find-generic-password -a <account> -s <service> and returns the icmt value", async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, failed: false, stdout: output(`"${SPKI}"`) });
    await expect(readItemComment(ACCOUNT)).resolves.toBe(SPKI);
    expect(execaMock).toHaveBeenCalledTimes(1);
    const [bin, args, options] = execaMock.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(bin).toBe("/usr/bin/security");
    expect(args).toEqual(["find-generic-password", "-a", ACCOUNT, "-s", SERVICE_NAME]);
    expect(args).not.toContain("-w");
    expect(args).not.toContain("-g");
    expect(args.some((arg) => /^-[A-Za-z]*[wg][A-Za-z]*$/.test(arg))).toBe(false);
    // Bounded, shell-free; only stdout is captured, with a small cap; stdin and stderr are ignored.
    expect(options).toMatchObject({
      reject: false,
      timeout: 1500,
      killSignal: "SIGKILL",
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      maxBuffer: 4096,
    });
    expect(options.shell).toBeUndefined();
  });

  it("Test 2: a missing item, a timeout, a kill, a failure and a missing comment attribute are null", async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 44, failed: true, stdout: "" });
    await expect(readItemComment(ACCOUNT)).resolves.toBeNull();
    execaMock.mockResolvedValueOnce({ exitCode: 1, failed: true, stdout: output(`"${SPKI}"`) });
    await expect(readItemComment(ACCOUNT)).resolves.toBeNull();
    execaMock.mockResolvedValueOnce({
      exitCode: undefined,
      failed: true,
      timedOut: true,
      isTerminated: true,
      stdout: "",
    });
    await expect(readItemComment(ACCOUNT)).resolves.toBeNull();
    // A killed child that still reports exit 0 and output is not an answer.
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      failed: true,
      isTerminated: true,
      stdout: output(`"${SPKI}"`),
    });
    await expect(readItemComment(ACCOUNT)).resolves.toBeNull();
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      failed: false,
      isCanceled: true,
      stdout: output(`"${SPKI}"`),
    });
    await expect(readItemComment(ACCOUNT)).resolves.toBeNull();
    // The item exists but has no comment, or the attribute line is missing altogether.
    execaMock.mockResolvedValueOnce({ exitCode: 0, failed: false, stdout: output("<NULL>") });
    await expect(readItemComment(ACCOUNT)).resolves.toBeNull();
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      failed: false,
      stdout: 'class: "genp"\nattributes:\n    "acct"<blob>="approval-presence-pin"\n',
    });
    await expect(readItemComment(ACCOUNT)).resolves.toBeNull();
    // A spawn failure that execa surfaces as a rejection still resolves null.
    execaMock.mockRejectedValueOnce(Object.assign(new Error("spawn"), { code: "ENOENT" }));
    await expect(readItemComment(ACCOUNT)).resolves.toBeNull();
  });

  it("Test 2b: an unsafe account, or one starting with a dash, throws before any spawn", async () => {
    for (const bad of [
      "has space",
      'has"quote',
      "line\nbreak",
      "-w",
      "-leading-dash",
      "",
      "semi;colon",
    ]) {
      await expect(readItemComment(bad), JSON.stringify(bad)).rejects.toBeInstanceOf(
        UnsafeSecretInputError,
      );
    }
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("Test 3: only base64 of exactly 91 bytes is accepted; anything else is null", async () => {
    const accept = async (comment: string): Promise<string | null> => {
      execaMock.mockResolvedValueOnce({
        exitCode: 0,
        failed: false,
        stdout: output(`"${comment}"`),
      });
      return readItemComment(ACCOUNT);
    };
    expect(await accept(SPKI)).toBe(SPKI);
    expect(await accept("")).toBeNull();
    expect(await accept("changed")).toBeNull();
    expect(await accept(Buffer.alloc(90, 1).toString("base64"))).toBeNull();
    expect(await accept(Buffer.alloc(92, 1).toString("base64"))).toBeNull();
    expect(await accept(Buffer.alloc(65, 1).toString("base64"))).toBeNull();
    // Not canonical base64: padding stripped, a stray character, trailing text.
    expect(await accept(SPKI.replace(/=+$/, ""))).toBeNull();
    expect(await accept(`${SPKI.slice(0, -4)}!!!!`)).toBeNull();
    expect(await accept(`${SPKI} extra`)).toBeNull();
  });

  it("with the caller's abort signal: a signal that already fired spawns nothing and answers null", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(readItemComment(ACCOUNT, controller.signal)).resolves.toBeNull();
    expect(execaMock).not.toHaveBeenCalled();
    const live = new AbortController();
    execaMock.mockResolvedValueOnce({ exitCode: 0, failed: false, stdout: output(`"${SPKI}"`) });
    await expect(readItemComment(ACCOUNT, live.signal)).resolves.toBe(SPKI);
    const [, , options] = execaMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(options.cancelSignal).toBe(live.signal);
  });
});
