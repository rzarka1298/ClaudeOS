// VAULT-10's edge suite, and the verification half of threat T-02-01
// (constructed write paths). The tracer proved the headline case — one
// workspace reaching into another. These are the five ways that guard is
// actually attacked: a sibling workspace, the global scope used as a back
// door, `../` traversal, a symlink planted inside the workspace, and a
// scope string that is not a scope at all.
//
// Every violation is asserted twice: once against `assertScopedWrite`
// directly (the guard's own contract) and once through `writeNote` (the
// consequence that matters — nothing reaches disk). The second assertion
// is what makes "rejected" mean "wrote nothing" rather than "threw after
// creating the directory tree".
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  globalScope,
  type NoteScope,
  newWorkspaceId,
  type WorkspaceId,
  workspaceScope,
} from "@ccc/domain";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { assertScopedWrite, WorkspaceScopeViolationError } from "./workspace-scope.js";
import { writeNote } from "./write-note.js";

const TEST_BASE = join(homedir(), ".ccc-test");

let sandbox: string;
let vaultRoot: string;
let outside: string;
let workspaceA: WorkspaceId;
let workspaceB: WorkspaceId;

beforeEach(() => {
  mkdirSync(TEST_BASE, { recursive: true });
  sandbox = mkdtempSync(join(TEST_BASE, "vscope-"));
  vaultRoot = join(sandbox, "vault");
  outside = join(sandbox, "outside");
  workspaceA = newWorkspaceId();
  workspaceB = newWorkspaceId();
  mkdirSync(join(vaultRoot, "workspaces", workspaceA, "wiki"), { recursive: true });
  mkdirSync(join(vaultRoot, "workspaces", workspaceB, "wiki"), { recursive: true });
  mkdirSync(join(vaultRoot, "global", "wiki"), { recursive: true });
  mkdirSync(outside, { recursive: true });
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** Every path under the vault, sorted — the before/after fingerprint that
 * proves a rejected write created nothing. */
function vaultTree(): string[] {
  return readdirSync(vaultRoot, { recursive: true })
    .map((entry) => String(entry))
    .sort();
}

/** Asserts BOTH halves of a rejection: the guard throws, and the real
 * write path throws without leaving anything behind. */
function expectRefused(relativePath: string, scope: NoteScope): void {
  const before = vaultTree();

  expect(() => assertScopedWrite(join(vaultRoot, relativePath), scope, vaultRoot)).toThrow(
    WorkspaceScopeViolationError,
  );
  expect(() =>
    writeNote({
      vaultRoot,
      relativePath,
      body: "# Refused\n",
      scope,
      stage: "wiki",
      generatedBy: {},
      aiGenerated: false,
      confidence: "unverified",
    }),
  ).toThrow(WorkspaceScopeViolationError);

  expect(vaultTree()).toEqual(before);
}

describe("assertScopedWrite refuses every scope violation", () => {
  test("a workspace-scoped write targeting a SIBLING workspace is refused", () => {
    expectRefused(join("workspaces", workspaceB, "wiki", "stolen.md"), workspaceScope(workspaceA));
  });

  test("a global-scoped write reaching into workspaces/ is refused", () => {
    expectRefused(join("workspaces", workspaceA, "wiki", "smuggled.md"), globalScope());
  });

  test("a ../ traversal escaping the workspace root is refused", () => {
    expectRefused(
      join("workspaces", workspaceA, "wiki", "..", "..", "..", "escaped.md"),
      workspaceScope(workspaceA),
    );
  });

  test("a ../ traversal escaping the vault entirely is refused", () => {
    expectRefused(
      join("workspaces", workspaceA, "wiki", "..", "..", "..", "..", "outside", "escaped.md"),
      workspaceScope(workspaceA),
    );
  });

  test("a symlink inside the workspace pointing outside the vault is refused", () => {
    // Containment is decided on the REAL path: a link is not a loophole,
    // because `checkPathContainment` resolves before it compares.
    symlinkSync(outside, join(vaultRoot, "workspaces", workspaceA, "wiki", "escape"));

    expectRefused(
      join("workspaces", workspaceA, "wiki", "escape", "leaked.md"),
      workspaceScope(workspaceA),
    );
  });

  test("a malformed scope string is refused before any path math happens", () => {
    const malformed = "workspace:../../../etc" as NoteScope;

    expectRefused(join("workspaces", workspaceA, "wiki", "note.md"), malformed);

    // Refused even against a vault root that does not exist: the scope
    // grammar rejects it before the filesystem is ever consulted, which is
    // what makes the separator characters unreachable by path math.
    expect(() =>
      assertScopedWrite(
        join(sandbox, "no-such-vault", "note.md"),
        malformed,
        join(sandbox, "no-such-vault"),
      ),
    ).toThrow(WorkspaceScopeViolationError);
  });

  test("a scope naming a workspace with no tree on disk is refused", () => {
    const unknown = newWorkspaceId();

    expect(() =>
      assertScopedWrite(
        join(vaultRoot, "workspaces", unknown, "wiki", "note.md"),
        workspaceScope(unknown),
        vaultRoot,
      ),
    ).toThrow(WorkspaceScopeViolationError);
  });
});

describe("assertScopedWrite accepts what the scope genuinely owns", () => {
  test("a workspace-scoped write inside its own tree resolves", () => {
    const candidate = join(vaultRoot, "workspaces", workspaceA, "wiki", "mine.md");

    expect(assertScopedWrite(candidate, workspaceScope(workspaceA), vaultRoot)).toBe(candidate);
  });

  test("a global-scoped write outside workspaces/ resolves", () => {
    const candidate = join(vaultRoot, "global", "wiki", "shared.md");

    expect(assertScopedWrite(candidate, globalScope(), vaultRoot)).toBe(candidate);
  });
});
