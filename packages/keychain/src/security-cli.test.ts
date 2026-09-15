import { beforeEach, describe, expect, it, vi } from "vitest";

const execaMock = vi.fn();
vi.mock("execa", () => ({
  execa: (...args: unknown[]) => execaMock(...args),
}));

const { getSecret, setSecret, deleteSecret, SERVICE_NAME } = await import("./security-cli.js");

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

  it("calls execa with an argument array of separate strings for set()", async () => {
    execaMock.mockResolvedValueOnce({ stdout: "" });
    await setSecret("my-account", "my-value");
    expect(execaMock).toHaveBeenCalledWith("security", [
      "add-generic-password",
      "-a",
      "my-account",
      "-s",
      SERVICE_NAME,
      "-w",
      "my-value",
      "-U",
    ]);
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
