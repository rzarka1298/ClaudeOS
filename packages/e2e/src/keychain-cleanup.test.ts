import { deleteSecret, setSecret } from "@ccc/keychain";
import { describe, expect, it, vi } from "vitest";
import { deleteUatAccount } from "./keychain-cleanup.js";

describe("deleteUatAccount (Test 7)", () => {
  it("calls the deleter once for a valid ccc-uat account and returns deleted", async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    await expect(deleteUatAccount("ccc-uat-0123abcd", { deleter: del })).resolves.toBe("deleted");
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith("ccc-uat-0123abcd");
  });

  it("maps exit code 44 (item absent) to absent", async () => {
    const del = vi.fn().mockRejectedValue(Object.assign(new Error("not found"), { exitCode: 44 }));
    await expect(deleteUatAccount("ccc-uat-0123abcd", { deleter: del })).resolves.toBe("absent");
    expect(del).toHaveBeenCalledTimes(1);
  });

  it("rethrows any other error", async () => {
    const boom = Object.assign(new Error("denied"), { exitCode: 36 });
    const del = vi.fn().mockRejectedValue(boom);
    await expect(deleteUatAccount("ccc-uat-0123abcd", { deleter: del })).rejects.toBe(boom);
    const plain = new Error("spawn failed");
    await expect(
      deleteUatAccount("ccc-uat-0123abcd", { deleter: vi.fn().mockRejectedValue(plain) }),
    ).rejects.toBe(plain);
  });

  it("throws before the deleter for the default account and a non-prefixed name", async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    await expect(deleteUatAccount("install-secret", { deleter: del })).rejects.toThrow();
    await expect(deleteUatAccount("other-0123abcd", { deleter: del })).rejects.toThrow();
    await expect(deleteUatAccount("", { deleter: del })).rejects.toThrow();
    expect(del).not.toHaveBeenCalled();
  });
});

// The real Keychain is touched only when the orchestrator opts in (plan 05.2-09's baseline run
// sets CCC_UAT_KEYCHAIN_SELFTEST=1 on darwin); the default test run never reads or writes it.
const REAL_SELFTEST =
  process.platform === "darwin" && process.env.CCC_UAT_KEYCHAIN_SELFTEST === "1";

describe.skipIf(!REAL_SELFTEST)(
  "Keychain round trip with a throwaway account (darwin, opt-in)",
  () => {
    it("writes, deletes and then reports absent", async () => {
      const account = `ccc-uat-selftest-${Date.now().toString(16)}`;
      try {
        await setSecret(account, "c2VsZnRlc3Q=");
        await expect(deleteUatAccount(account, { deleter: deleteSecret })).resolves.toBe("deleted");
        await expect(deleteUatAccount(account)).resolves.toBe("absent");
      } finally {
        await deleteUatAccount(account).catch(() => undefined);
      }
    });
  },
);
