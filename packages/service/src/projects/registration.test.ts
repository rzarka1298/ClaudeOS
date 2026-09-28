import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isForbiddenRoot } from "../vault-root-policy.js";
import {
  detectProtectedLocation,
  type ProjectRefusalReason,
  ProjectRefusedError,
  validateProjectCandidate,
} from "./registration.js";

const REASONS: readonly ProjectRefusalReason[] = [
  "not-a-directory",
  "missing",
  "forbidden-location",
  "inside-vault",
  "above-vault",
  "runtime-dir",
  "access-denied",
];

let base: string;
let runtimeParent: string;
let runtimeDir: string;
let vaultParent: string;
let vaultRoot: string;
let control: string;
let locked: string | null;

function policy() {
  return { homeDir: homedir(), runtimeDir, vaultRoot };
}

/** Asserts `candidate` is refused with `reason` and the constant message. */
function expectRefused(candidate: string, reason: ProjectRefusalReason): void {
  let caught: unknown;
  try {
    validateProjectCandidate(candidate, policy());
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ProjectRefusedError);
  const refusal = caught as ProjectRefusedError;
  expect(refusal.message).toBe("project refused");
  expect(REASONS).toContain(refusal.reason);
  expect(refusal.reason).toBe(reason);
}

beforeEach(() => {
  locked = null;
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "ccc-registration-")));
  runtimeParent = join(base, "rt-parent");
  runtimeDir = join(runtimeParent, "runtime");
  vaultParent = join(base, "vault-parent");
  vaultRoot = join(vaultParent, "Vault");
  control = join(base, "code", "example-project");
  for (const d of [join(runtimeDir, "launch"), join(vaultRoot, "notes"), control]) {
    mkdirSync(d, { recursive: true });
  }
});

afterEach(() => {
  if (locked !== null) chmodSync(locked, 0o700);
  rmSync(base, { recursive: true, force: true });
});

describe("validateProjectCandidate: forbidden locations in realpath form (E-3, PR-06)", () => {
  it.each([
    ["/etc", "resolves to /private/etc"],
    ["/private", "the /private root"],
    ["/private/etc", "the real /etc"],
    ["/tmp", "resolves to /private/tmp"],
    ["/var", "resolves to /private/var"],
    ["/usr", "system tree"],
    ["/opt", "system tree"],
    ["/", "the filesystem root"],
    ["/Users", "every user's home parent"],
  ])("refuses %s (%s)", (candidate) => {
    expectRefused(candidate, "forbidden-location");
  });

  it("refuses the home directory", () => {
    expectRefused(homedir(), "forbidden-location");
  });

  it("refuses the home directory spelled in a different letter case", () => {
    expectRefused(homedir().toUpperCase(), "forbidden-location");
  });

  it("refuses a symlink that points at /etc", () => {
    const link = join(base, "innocent-looking");
    symlinkSync("/etc", link);
    expectRefused(link, "forbidden-location");
  });

  it("isForbiddenRoot compares realpath forms, so /private/etc matches the /etc entry", () => {
    expect(isForbiddenRoot(realpathSync.native("/etc"))).toBe(true);
    expect(isForbiddenRoot("/private/tmp")).toBe(true);
    expect(isForbiddenRoot(control)).toBe(false);
  });
});

describe("validateProjectCandidate: the service's own directories (D-04, A-06)", () => {
  it("refuses the runtime directory, a folder inside it and an ancestor of it", () => {
    expectRefused(runtimeDir, "runtime-dir");
    expectRefused(join(runtimeDir, "launch"), "runtime-dir");
    expectRefused(runtimeParent, "runtime-dir");
  });

  it("refuses the vault root and a folder inside it as inside-vault", () => {
    expectRefused(vaultRoot, "inside-vault");
    expectRefused(join(vaultRoot, "notes"), "inside-vault");
  });

  it("refuses the vault root's parent as above-vault", () => {
    expectRefused(vaultParent, "above-vault");
  });
});

describe("validateProjectCandidate: what the path must be", () => {
  it("refuses a regular file", () => {
    const file = join(base, "notes.txt");
    writeFileSync(file, "x");
    expectRefused(file, "not-a-directory");
  });

  it("refuses a missing path", () => {
    expectRefused(join(base, "does-not-exist"), "missing");
  });

  it("classifies EACCES as access-denied instead of propagating it", () => {
    const parent = join(base, "locked");
    mkdirSync(join(parent, "inner"), { recursive: true });
    chmodSync(parent, 0o000);
    locked = parent;
    expectRefused(join(parent, "inner"), "access-denied");
  });

  it("accepts a plain folder, returning its realpath (control: the refusal is not blanket)", () => {
    expect(validateProjectCandidate(control, policy())).toBe(control);
  });

  it("accepts a folder through a symlink or a case alias, returning the one realpath", () => {
    const link = join(base, "link-to-project");
    symlinkSync(control, link);
    expect(validateProjectCandidate(link, policy())).toBe(control);
    const upper = join(base, "code", "EXAMPLE-PROJECT");
    expect(validateProjectCandidate(upper, policy())).toBe(control);
  });

  it("accepts a project when no vault root is set up yet", () => {
    expect(validateProjectCandidate(control, { ...policy(), vaultRoot: null })).toBe(control);
  });
});

describe("detectProtectedLocation (D-29, PR-04, PR-10)", () => {
  // A home that does not exist: detection must be lexical, with no fs call.
  const HOME = "/Users/USERNAME";

  it.each([
    [`${HOME}/Documents/example-project`, "documents"],
    [`${HOME}/Documents`, "documents"],
    [`${HOME}/Desktop/example-project`, "desktop"],
    [`${HOME}/Downloads/example-project`, "downloads"],
    [`${HOME}/Library/Mobile Documents/com~apple~CloudDocs/x`, "icloud-drive"],
    [`${HOME}/documents/example-project`, "documents"],
  ] as const)("names %s as %s", (candidate, location) => {
    expect(detectProtectedLocation(candidate, HOME)).toBe(location);
  });

  it.each([
    `${HOME}/code/example-project`,
    `${HOME}/DocumentsArchive/example-project`,
    "/opt/work/example-project",
    `${HOME}`,
  ])("returns null for %s", (candidate) => {
    expect(detectProtectedLocation(candidate, HOME)).toBeNull();
  });

  it("resolves .. lexically before deciding", () => {
    expect(detectProtectedLocation(`${HOME}/code/../Desktop/x`, HOME)).toBe("desktop");
  });
});
