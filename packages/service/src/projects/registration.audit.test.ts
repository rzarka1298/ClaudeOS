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
  /** Paths any SYNCHRONOUS fs call was made on (wave-4b: registration must not block). */
  syncPaths: [] as string[],
}));

// Registration resolves and stats through node:fs/promises; the faults are
// injected there. The synchronous functions are wrapped only to record use.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const raise = () => {
    const err = new Error("simulated") as NodeJS.ErrnoException;
    err.code = fault.code ?? "EIO";
    throw err;
  };
  const realpath = async (p: string) => {
    fault.calls += 1;
    if (fault.on === "realpath") raise();
    return actual.realpath(p);
  };
  const stat = async (p: string) => {
    fault.calls += 1;
    if (fault.on === "stat") raise();
    return actual.stat(p);
  };
  return { ...actual, default: { ...actual, realpath, stat }, realpath, stat };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const record =
    <A extends unknown[], R>(fn: (p: string, ...rest: A) => R) =>
    (p: string, ...rest: A): R => {
      fault.calls += 1;
      fault.syncPaths.push(String(p));
      return fn(p, ...rest);
    };
  const realpathSync = Object.assign(record(actual.realpathSync), {
    native: record(actual.realpathSync.native),
  });
  const statSync = record(actual.statSync);
  const lstatSync = record(actual.lstatSync);
  const readlinkSync = record(actual.readlinkSync);
  const wrapped = { realpathSync, statSync, lstatSync, readlinkSync };
  return { ...actual, default: { ...actual, ...wrapped }, ...wrapped };
});

const { ProjectRefusedError, detectProtectedLocation, validateProjectCandidate } = await import(
  "./registration.js"
);

let base: string;
let project: string;

function policy() {
  return { homeDir: homedir(), runtimeDir: join(base, "runtime"), vaultRoot: join(base, "vault") };
}

async function reasonFor(candidate: string): Promise<string | null> {
  try {
    await validateProjectCandidate(candidate, policy());
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
  fault.syncPaths = [];
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "ccc-reg-audit-")));
  project = join(base, "code", "example-project");
  mkdirSync(project, { recursive: true });
});

afterEach(() => {
  fault.on = null;
  rmSync(base, { recursive: true, force: true });
});

describe("forbidden roots the plan names explicitly (D-04, PR-06)", () => {
  it.each(["/bin", "/sbin", "/private/var", "/private/tmp"])("refuses %s", async (candidate) => {
    expect(await reasonFor(candidate)).toBe("forbidden-location");
  });
});

describe("EPERM is refused as access-denied, never propagated (D-29, PR-10)", () => {
  it.each(["realpath", "stat"] as const)("EPERM from %s", async (on) => {
    fault.code = "EPERM";
    fault.on = on;
    expect(await reasonFor(project)).toBe("access-denied");
  });

  it("control: an unrelated errno is not access-denied", async () => {
    fault.code = "EIO";
    fault.on = "realpath";
    expect(await reasonFor(project)).toBe("missing");
  });
});

describe("EPERM through a symlink names the protected location it leads into (PR-10)", () => {
  async function refusalFor(candidate: string, homeDir: string) {
    try {
      await validateProjectCandidate(candidate, { ...policy(), homeDir });
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectRefusedError);
      return err as { reason: string; protectedLocation: string | null };
    }
    throw new Error("expected a refusal");
  }

  it("a symlink to a folder under Documents", async () => {
    const home = join(base, "home");
    const inDocuments = join(home, "Documents", "example-project");
    mkdirSync(inDocuments, { recursive: true });
    const link = join(base, "link-to-project");
    symlinkSync(inDocuments, link);
    fault.code = "EPERM";
    fault.on = "realpath";
    const refusal = await refusalFor(link, home);
    expect(refusal.reason).toBe("access-denied");
    expect(refusal.protectedLocation).toBe("documents");
  });

  it("a folder reached through a symlinked ancestor that points into Desktop", async () => {
    const home = join(base, "home");
    mkdirSync(join(home, "Desktop", "example-project"), { recursive: true });
    const linkedParent = join(base, "linked-desktop");
    symlinkSync(join(home, "Desktop"), linkedParent);
    fault.code = "EPERM";
    fault.on = "realpath";
    expect((await refusalFor(join(linkedParent, "example-project"), home)).protectedLocation).toBe(
      "desktop",
    );
  });

  it("control: EPERM on a plain folder names no location", async () => {
    fault.code = "EPERM";
    fault.on = "realpath";
    expect((await refusalFor(project, join(base, "home"))).protectedLocation).toBeNull();
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

describe("registration never blocks the event loop on the candidate (wave-4b)", () => {
  it("resolves, stats and follows links asynchronously: no synchronous fs call touches the candidate", async () => {
    const link = join(base, "link-to-project");
    symlinkSync(project, link);
    fault.syncPaths = [];
    await expect(validateProjectCandidate(link, policy())).resolves.toBe(project);
    fault.code = "EPERM";
    fault.on = "realpath";
    expect(await reasonFor(link)).toBe("access-denied");
    expect(fault.syncPaths.filter((p) => p.startsWith(base))).toEqual([]);
  });

  it("returns a promise, so a pending Files & Folders prompt cannot freeze the service", () => {
    const pending = validateProjectCandidate(project, policy());
    expect(pending).toBeInstanceOf(Promise);
    return pending;
  });
});
