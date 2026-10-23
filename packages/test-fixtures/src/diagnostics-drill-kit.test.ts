import { describe, expect, it } from "vitest";
import {
  findHomeFormLeaks,
  isKeychainPresenceSpawn,
  nonexistentResearchAccount,
  type RecordedEvent,
} from "./diagnostics-drill-kit.js";

// FIX3A MAJOR-3: "a reconnect never spawns security" must be provable. The old selector filtered on
// the test account, so a wiring that asked about any OTHER account (a literal) was invisible to it.
// The selector now picks EVERY presence lookup, whatever account it names.

const SECURITY = "/usr/bin/security";

function recorded(file: string, args: string[]): RecordedEvent {
  return { kind: "spawn", fn: "spawn", file, args };
}

describe("isKeychainPresenceSpawn", () => {
  it("selects a presence lookup for ANY account, including one the test never named", () => {
    const test = nonexistentResearchAccount();
    for (const account of [test, "anthropic-api-key", "some-literal-account"]) {
      expect(
        isKeychainPresenceSpawn(
          recorded(SECURITY, ["find-generic-password", "-a", account, "-s", "com.example"]),
        ),
      ).toBe(true);
    }
  });

  it("does not select the install-secret read (-w), other verbs, other binaries or non-spawn events", () => {
    expect(
      isKeychainPresenceSpawn(
        recorded(SECURITY, ["find-generic-password", "-a", "install", "-s", "s", "-w"]),
      ),
    ).toBe(false);
    expect(
      isKeychainPresenceSpawn(
        recorded(SECURITY, ["delete-generic-password", "-a", "x", "-s", "s"]),
      ),
    ).toBe(false);
    expect(
      isKeychainPresenceSpawn(recorded("/usr/bin/other", ["find-generic-password", "-a", "x"])),
    ).toBe(false);
    expect(isKeychainPresenceSpawn({ kind: "lookup", host: "example.test" })).toBe(false);
  });

  it("requires the absolute binary: a relative or look-alike path is not the Keychain tool", () => {
    expect(
      isKeychainPresenceSpawn(recorded("security", ["find-generic-password", "-a", "x"])),
    ).toBe(false);
    expect(
      isKeychainPresenceSpawn(recorded("/tmp/security", ["find-generic-password", "-a", "x"])),
    ).toBe(false);
  });
});

describe("findHomeFormLeaks (FIX3A: ~/ and …/ forms in reasons and facts, paths.* exempt by key)", () => {
  const clean = {
    rows: [{ id: "vault", reasonCode: "vault-ready", facts: { count: 3 } }],
    paths: { vault: "~/Notes/Vault", runtimeDir: "~/Library/x", socket: "…/svc.sock" },
  };

  it("passes a body whose only path-shaped strings are under paths", () => {
    expect(findHomeFormLeaks(JSON.stringify(clean))).toEqual([]);
  });

  it("flags a ~/ path in a row fact or a reason, by label and never by value", () => {
    const body = {
      ...clean,
      rows: [{ id: "vault", reasonCode: "x", facts: { where: "~/Secret/Place" } }],
    };
    const hits = findHomeFormLeaks(JSON.stringify(body));
    expect(hits).toEqual(["a home-form path in rows.0.facts.where"]);
    expect(hits.join(" ")).not.toContain("Secret");
    const reason = { ...clean, rows: [{ id: "vault", reasonCode: "see ~/x" }] };
    expect(findHomeFormLeaks(JSON.stringify(reason))).toEqual([
      "a home-form path in rows.0.reasonCode",
    ]);
  });

  it("flags the …/ display form outside paths, and a bare ~/ at the start or after a space", () => {
    expect(
      findHomeFormLeaks(JSON.stringify({ ...clean, rows: [{ facts: { a: "…/deep/name" } }] })),
    ).toEqual(["a home-form path in rows.0.facts.a"]);
    expect(
      findHomeFormLeaks(JSON.stringify({ ...clean, rows: [{ facts: { a: "open ~/x now" } }] })),
    ).toEqual(["a home-form path in rows.0.facts.a"]);
  });

  it("does not flag a tilde that is not a path or a version-like string", () => {
    expect(
      findHomeFormLeaks(
        JSON.stringify({ ...clean, rows: [{ facts: { a: "1.0.0~rc", b: "a~b" } }] }),
      ),
    ).toEqual([]);
  });

  it("keeps paths exempt only at the top level, not a nested key that happens to be named paths", () => {
    const nested = { ...clean, rows: [{ facts: { paths: { vault: "~/Hidden" } } }] };
    expect(findHomeFormLeaks(JSON.stringify(nested))).toEqual([
      "a home-form path in rows.0.facts.paths.vault",
    ]);
  });
});
