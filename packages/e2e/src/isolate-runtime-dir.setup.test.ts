import { describe, expect, it } from "vitest";

// The setup file has already run for this test file (vitest setupFiles), so the
// environment it produced is what every e2e unit test sees (LOW-2).
describe("isolate-runtime-dir setup", () => {
  it("leaves no inherited socket path pointing outside the runtime dir", () => {
    const socket = process.env.CCC_SOCKET_PATH;
    const runtime = process.env.CCC_RUNTIME_DIR ?? "";
    expect(runtime).not.toBe("");
    expect(socket === undefined || socket.startsWith(`${runtime}/`)).toBe(true);
  });

  it("gives the tests a throwaway keychain account", () => {
    expect(process.env.CCC_INSTALL_SECRET_ACCOUNT).toMatch(/^ccc-uat-test-.+/);
  });
});
