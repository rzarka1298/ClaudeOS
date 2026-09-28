import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Audit (04-04 truths 3 and 4): the forbidden roots the plan names but the
 * plan's own tests leave out, EPERM (not only EACCES) as access-denied, and
 * protected-location detection performing no filesystem read at all.
 */
const fault = vi.hoisted(() => ({
  code: null as string | null,
  on: null as "realpath" | "stat" | null,
  calls: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const raise = () => {
    const err = new Error("simulated") as NodeJS.ErrnoException;
    err.code = fault.code ?? "EIO";
    throw err;
  };
  const realpathNative = (p: string) => {
    fault.calls += 1;
    if (fault.on === "realpath") raise();
    return actual.realpathSync.native(p);
  };
  const realpathSync = Object.assign(
    (p: string) => {
      fault.calls += 1;
      return actual.realpathSync(p);
    },
    { native: realpathNative },
  );
  const statSync = (p: string) => {
    fault.calls += 1;
    if (fault.on === "stat") raise();
    return actual.statSync(p);
  };
  return { ...actual, default: { ...actual, realpathSync, statSync }, realpathSync, statSync };
});

const { ProjectRefusedError, detectProtectedLocation, validateProjectCandidate } = await import(
  "./registration.js"
);

let base: string;
let project: string;

function policy() {
  return { homeDir: homedir(), runtimeDir: join(base, "runtime"), vaultRoot: join(base, "vault") };
}

function reasonFor(candidate: string): string | null {
  try {
    validateProjectCandidate(candidate, policy());
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(ProjectRefusedError);
    expect((err as Error).message).toBe("project refused");
    return (err as { reason: string }).reason;
  }
}

beforeEach(() => {
  fault.code = null;
  fault.on = null;
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "ccc-reg-audit-")));
  project = join(base, "code", "example-project");
  mkdirSync(project, { recursive: true });
});

afterEach(() => {
  fault.on = null;
  rmSync(base, { recursive: true, force: true });
});

describe("forbidden roots the plan names explicitly (D-04, PR-06)", () => {
  it.each(["/bin", "/sbin", "/private/var", "/private/tmp"])("refuses %s", (candidate) => {
    expect(reasonFor(candidate)).toBe("forbidden-location");
  });
});

describe("EPERM is refused as access-denied, never propagated (D-29, PR-10)", () => {
  it.each(["realpath", "stat"] as const)("EPERM from %s", (on) => {
    fault.code = "EPERM";
    fault.on = on;
    expect(reasonFor(project)).toBe("access-denied");
  });

  it("control: an unrelated errno is not access-denied", () => {
    fault.code = "EIO";
    fault.on = "realpath";
    expect(reasonFor(project)).toBe("missing");
  });
});

describe("EPERM through a symlink names the protected location it leads into (PR-10)", () => {
  function refusalFor(candidate: string, homeDir: string) {
    try {
      validateProjectCandidate(candidate, { ...policy(), homeDir });
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectRefusedError);
      return err as { reason: string; protectedLocation: string | null };
    }
    throw new Error("expected a refusal");
  }

  it("a symlink to a folder under Documents", () => {
    const home = join(base, "home");
    const inDocuments = join(home, "Documents", "example-project");
    mkdirSync(inDocuments, { recursive: true });
    const link = join(base, "link-to-project");
    symlinkSync(inDocuments, link);
    fault.code = "EPERM";
    fault.on = "realpath";
    const refusal = refusalFor(link, home);
    expect(refusal.reason).toBe("access-denied");
    expect(refusal.protectedLocation).toBe("documents");
  });

  it("a folder reached through a symlinked ancestor that points into Desktop", () => {
    const home = join(base, "home");
    mkdirSync(join(home, "Desktop", "example-project"), { recursive: true });
    const linkedParent = join(base, "linked-desktop");
    symlinkSync(join(home, "Desktop"), linkedParent);
    fault.code = "EPERM";
    fault.on = "realpath";
    expect(refusalFor(join(linkedParent, "example-project"), home).protectedLocation).toBe(
      "desktop",
    );
  });

  it("control: EPERM on a plain folder names no location", () => {
    fault.code = "EPERM";
    fault.on = "realpath";
    expect(refusalFor(project, join(base, "home")).protectedLocation).toBeNull();
  });
});

describe("protected-location detection reads nothing from disk (PR-04)", () => {
  it("names Documents with zero realpath or stat calls", () => {
    fault.calls = 0;
    expect(
      detectProtectedLocation(join(homedir(), "Documents", "example-project"), homedir()),
    ).toBe("documents");
    expect(fault.calls).toBe(0);
  });
});
