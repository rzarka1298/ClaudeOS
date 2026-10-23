import { describe, expect, it } from "vitest";
import {
  isKeychainPresenceSpawn,
  nonexistentResearchAccount,
  type RecordedEvent,
} from "./diagnostics-drill-kit.js";

// FIX3A MAJOR-3: "a reconnect never spawns security" must be provable. The old selector filtered on
// the test account, so a wiring that asked about any OTHER account (a literal) was invisible to it.
// The selector now picks EVERY presence lookup, whatever account it names.

const SECURITY = "/usr/bin/security";

function spawn(file: string, args: string[]): RecordedEvent {
  return { kind: "spawn", fn: "spawn", file, args };
}

describe("isKeychainPresenceSpawn", () => {
  it("selects a presence lookup for ANY account, including one the test never named", () => {
    const test = nonexistentResearchAccount();
    for (const account of [test, "anthropic-api-key", "some-literal-account"]) {
      expect(
        isKeychainPresenceSpawn(
          spawn(SECURITY, ["find-generic-password", "-a", account, "-s", "com.example"]),
        ),
      ).toBe(true);
    }
  });

  it("does not select the install-secret read (-w), other verbs, other binaries or non-spawn events", () => {
    expect(
      isKeychainPresenceSpawn(
        spawn(SECURITY, ["find-generic-password", "-a", "install", "-s", "s", "-w"]),
      ),
    ).toBe(false);
    expect(
      isKeychainPresenceSpawn(spawn(SECURITY, ["delete-generic-password", "-a", "x", "-s", "s"])),
    ).toBe(false);
    expect(
      isKeychainPresenceSpawn(spawn("/usr/bin/other", ["find-generic-password", "-a", "x"])),
    ).toBe(false);
    expect(isKeychainPresenceSpawn({ kind: "lookup", host: "example.test" })).toBe(false);
  });

  it("requires the absolute binary: a relative or look-alike path is not the Keychain tool", () => {
    expect(isKeychainPresenceSpawn(spawn("security", ["find-generic-password", "-a", "x"]))).toBe(
      false,
    );
    expect(
      isKeychainPresenceSpawn(spawn("/tmp/security", ["find-generic-password", "-a", "x"])),
    ).toBe(false);
  });
});
