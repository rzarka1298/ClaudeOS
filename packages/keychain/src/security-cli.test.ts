import { beforeEach, describe, expect, it, vi } from "vitest";

const execaMock = vi.fn();
vi.mock("execa", () => ({
  execa: (...args: unknown[]) => execaMock(...args),
}));

const { getSecret, setSecret, deleteSecret, SERVICE_NAME, UnsafeSecretInputError } = await import(
  "./security-cli.js"
);

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
    expect(execaMock).toHaveBeenCalledWith("security", [
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
    const [bin, args, options] = execaMock.mock.calls[0] as [
      string,
      string[],
      { input?: string },
    ];
    expect(bin).toBe("security");
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

  it("calls execa with an argument array of separate strings for delete()", async () => {
    execaMock.mockResolvedValueOnce({ stdout: "" });
    await deleteSecret("my-account");
    expect(execaMock).toHaveBeenCalledWith("security", [
      "delete-generic-password",
      "-a",
      "my-account",
      "-s",
      SERVICE_NAME,
    ]);
  });
});
