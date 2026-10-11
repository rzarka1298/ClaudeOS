// The static classification table (D-04, D-05, D-10, APPR-05) and its
// exhaustiveness proofs. Every claim here is a property of the table itself or
// of the product source that must stay tied to it; nothing is mocked.
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as classificationModule from "./classification.js";
import {
  CAPABILITY_CLASSES,
  CAPABILITY_FAMILY_OPERATION,
  CAPABILITY_OPERATION,
  CLASSIFICATION,
  type ClassificationTable,
  classifyCapability,
  classifyOperation,
  DEFAULT_TTL_MS,
  resolveTtlMs,
  TTL_CEILING_MS,
} from "./classification.js";
import { LAUNCH_ACTIONS } from "./launch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = join(HERE, "..", "..");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const ENABLED = ["diagnostic.test", "session.force-terminate"];
const RESERVED = [
  "automation.git-write",
  "codex.hooks.install",
  "hooks.install",
  "publish",
  "skill.run",
  "vault.cross-scope-move",
  "vault.delete",
];

/** Every descriptor capability string 06-RECONCILE.md R-CAPS lists (the exact-string ones). */
const R_CAPS_DESCRIPTOR_STRINGS = [
  "connect:claude-hooks",
  "connect:google",
  "connect:github",
  "launch:antigravity",
  "launch:claude-code",
  "launch:finder",
  "launch:github",
  "launch:claude-desktop",
  "launch:codex",
  "launch:claude-codex-pair",
  "codex:open-transcript",
  "codex:follow-log",
  "switcher:claude-code",
  "session:focus",
  "session:resume",
  "session:branch",
  "session:open-transcript",
  "session:interrupt",
  "session:associate",
  "session:terminate",
  "usage:enable-transcript-analysis",
  "skill:run",
  "task:create",
  "note:capture",
  "data:refresh",
];

describe("classification table shape (Test 1)", () => {
  it("has the three classes and no row outside them", () => {
    expect([...CAPABILITY_CLASSES]).toEqual(["approval-required", "no-approval", "direct-gesture"]);
    for (const [name, row] of Object.entries(CLASSIFICATION)) {
      expect(CAPABILITY_CLASSES as readonly string[], name).toContain(row.class);
    }
  });

  it("gives every approval-required row the full set of policy fields", () => {
    const approvalRows = Object.entries(CLASSIFICATION).filter(
      ([, row]) => row.class === "approval-required",
    );
    expect(approvalRows.length).toBeGreaterThan(0);
    for (const [name, row] of approvalRows) {
      if (row.class !== "approval-required") throw new Error("unreachable");
      expect(["enabled", "reserved"], name).toContain(row.status);
      expect(row.ttlMs, name).toBeGreaterThan(0);
      expect(row.ttlMs, name).toBeLessThanOrEqual(TTL_CEILING_MS);
      expect(row.maxApprovalAgeMs, name).toBeGreaterThan(0);
      expect(["idempotent", "never"], name).toContain(row.retry);
      expect(row.modifiable, name).toBe(false);
      expect(row.summary.length, name).toBeGreaterThan(0);
    }
  });

  it("gives every other row a non-empty reason and no policy fields", () => {
    for (const [name, row] of Object.entries(CLASSIFICATION)) {
      if (row.class === "approval-required") continue;
      expect(row.reason.trim().length, name).toBeGreaterThan(0);
      expect(Object.keys(row).sort(), name).toEqual(["class", "reason"]);
    }
  });

  it("holds the owner-tuned lifetimes from D-10", () => {
    expect(TTL_CEILING_MS).toBe(7 * DAY);
    expect(DEFAULT_TTL_MS).toBe(DAY);
    expect(CLASSIFICATION["session.force-terminate"].ttlMs).toBe(15 * MINUTE);
    expect(CLASSIFICATION["session.force-terminate"].maxApprovalAgeMs).toBe(5 * MINUTE);
    expect(CLASSIFICATION["diagnostic.test"].ttlMs).toBe(DAY);
    expect(CLASSIFICATION["diagnostic.test"].maxApprovalAgeMs).toBe(5 * MINUTE);
    expect(CLASSIFICATION["session.force-terminate"].retry).toBe("idempotent");
    expect(CLASSIFICATION["diagnostic.test"].retry).toBe("idempotent");
  });
});

describe("enabled and reserved sets (Test 2)", () => {
  it("enables exactly session.force-terminate and diagnostic.test", () => {
    const enabled = Object.entries(CLASSIFICATION)
      .filter(([, row]) => row.class === "approval-required" && row.status === "enabled")
      .map(([name]) => name)
      .sort();
    expect(enabled).toEqual(ENABLED);
  });

  it("reserves exactly vault delete, cross-scope move, both hook installs, automation Git write, publish and skill run", () => {
    const reserved = Object.entries(CLASSIFICATION)
      .filter(([, row]) => row.class === "approval-required" && row.status === "reserved")
      .map(([name]) => name)
      .sort();
    expect(reserved).toEqual(RESERVED);
  });

  it("classifies the no-approval operations the plan names", () => {
    for (const name of [
      "vault.write-note",
      "vault.initialize",
      "vault.repair-index",
      "task.write",
      "approval.mirror-note",
      "store.write",
      "notify.local",
      "data.refresh",
      "note.capture",
    ]) {
      expect(classifyOperation(name)?.row.class, name).toBe("no-approval");
    }
    expect(classifyOperation("connect.navigate")?.row.class).toBe("direct-gesture");
  });
});

describe("exhaustiveness over descriptor capability strings (Test 3)", () => {
  it("resolves every R-CAPS descriptor string to a row", () => {
    for (const capability of R_CAPS_DESCRIPTOR_STRINGS) {
      const hit = classifyCapability(capability);
      expect(hit, capability).toBeDefined();
      expect(CLASSIFICATION[hit?.operation as keyof typeof CLASSIFICATION], capability).toBe(
        hit?.row,
      );
    }
  });

  it("keeps the exact-string map and the R-CAPS list identical, minus the connect family", () => {
    const mapped = Object.keys(CAPABILITY_OPERATION)
      .filter((capability) => !capability.startsWith("connect:"))
      .sort();
    const listed = R_CAPS_DESCRIPTOR_STRINGS.filter((c) => !c.startsWith("connect:")).sort();
    expect(mapped).toEqual(listed);
  });

  it("maps the terminate control to the approval-required force-terminate operation", () => {
    const hit = classifyCapability("session:terminate");
    expect(hit?.operation).toBe("session.force-terminate");
    expect(hit?.row.class).toBe("approval-required");
    expect(classifyCapability("skill:run")?.operation).toBe("skill.run");
    expect(classifyCapability("skill:run")?.row.class).toBe("approval-required");
  });

  it("resolves the connect: family for any non-empty suffix", () => {
    expect(CAPABILITY_FAMILY_OPERATION["connect:"]).toBe("connect.navigate");
    for (const capability of ["connect:google", "connect:something-new", "connect:x"]) {
      expect(classifyCapability(capability)?.operation, capability).toBe("connect.navigate");
    }
  });

  it("returns undefined for an unknown string so the caller fails closed", () => {
    for (const capability of [
      "",
      "no.such.operation",
      "session:nuke",
      "launch:",
      "connect:",
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      "Launch:finder",
    ]) {
      expect(classifyCapability(capability), capability).toBeUndefined();
    }
  });

  it("has a launch row for every Phase 4 launch action", () => {
    for (const action of LAUNCH_ACTIONS) {
      expect(classifyCapability(`launch:${action}`)?.row.class, action).toBe("direct-gesture");
    }
  });

  /**
   * The same exhaustiveness, taken from the product source rather than from a
   * remembered list: every string literal in the plugin's non-test source that
   * has the shape of a capability descriptor must classify.
   */
  it("classifies every capability-shaped string literal in the plugin's non-test source", () => {
    const literals = new Set<string>();
    for (const file of listSourceFiles(join(PACKAGES_DIR, "plugin", "src"))) {
      for (const match of readFileSync(file, "utf8").matchAll(CAPABILITY_LITERAL)) {
        if (match[1] !== undefined) literals.add(match[1]);
      }
    }
    expect(literals.size).toBeGreaterThan(10);
    for (const literal of literals) {
      expect(classifyCapability(literal), literal).toBeDefined();
    }
  });
});

/** A double-quoted `<prefix>:<name>` capability descriptor literal. Template literals are not matched. */
const CAPABILITY_LITERAL =
  /"((?:launch|session|usage|skill|task|note|data|switcher|connect|codex):[a-z][a-z-]*)"/g;

describe("source scan exclusion of test-only directories", () => {
  it("skips test-support/ but still scans product paths (a planted literal is caught)", () => {
    const root = mkdtempSync(join(tmpdir(), "scan-guard-"));
    try {
      mkdirSync(join(root, "test-support"));
      mkdirSync(join(root, "view"));
      writeFileSync(join(root, "test-support", "fx.ts"), 'x("note:fixture-only");');
      writeFileSync(join(root, "view", "product.ts"), 'x("note:planted");');
      const files = listSourceFiles(root).map((f) => f.slice(root.length + 1));
      expect(files).toEqual([join("view", "product.ts")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("no product source imports from a test-only directory (the exclusion hides nothing shipped)", () => {
    for (const pkg of readdirSync(PACKAGES_DIR)) {
      const src = join(PACKAGES_DIR, pkg, "src");
      try {
        if (!statSync(src).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const file of listSourceFiles(src)) {
        const text = readFileSync(file, "utf8");
        for (const dirName of TEST_ONLY_DIRS) {
          expect(text, file).not.toMatch(new RegExp(`from\\s+"[^"]*/${dirName}/`));
        }
      }
    }
  });
});

describe("exhaustiveness over CapabilityToken literals (Test 4)", () => {
  it("finds the real literal, so the scan is not vacuous", () => {
    const found = collectTokenLiterals();
    expect(found.some((hit) => hit.literal === "session.force-terminate")).toBe(true);
  });

  it("requires every CapabilityToken<'literal'> in non-test source to be an approval-required key", () => {
    for (const hit of collectTokenLiterals()) {
      const row = classifyOperation(hit.literal)?.row;
      expect(row?.class, `${hit.file}: CapabilityToken<"${hit.literal}">`).toBe(
        "approval-required",
      );
    }
  });

  it("fails on an invented literal (the scan reads source, it does not trust a list)", () => {
    const hits = tokenLiteralsIn('type T = CapabilityToken<"no.such.operation">;', "fixture.ts");
    expect(hits.map((hit) => hit.literal)).toEqual(["no.such.operation"]);
    const bad = hits.filter(
      (hit) => classifyOperation(hit.literal)?.row.class !== "approval-required",
    );
    expect(bad).toHaveLength(1);

    const nonApproval = tokenLiteralsIn('x: CapabilityToken<"vault.write-note">', "fixture.ts");
    expect(
      nonApproval.filter(
        (hit) => classifyOperation(hit.literal)?.row.class !== "approval-required",
      ),
    ).toHaveLength(1);
  });

  it("sees a literal split over lines", () => {
    const hits = tokenLiteralsIn('CapabilityToken<\n  "diagnostic.test"\n>', "fixture.ts");
    expect(hits.map((hit) => hit.literal)).toEqual(["diagnostic.test"]);
  });
});

describe("resolveTtlMs (Test 6)", () => {
  const force = CLASSIFICATION["session.force-terminate"];
  const diag = CLASSIFICATION["diagnostic.test"];
  const huge = { ttlMs: 30 * DAY };

  const cases: Array<[string, number | undefined, { ttlMs: number }, number]> = [
    ["nothing requested (force)", undefined, force, 15 * MINUTE],
    ["nothing requested (diag)", undefined, diag, DAY],
    ["shorter than default", 5 * MINUTE, force, 5 * MINUTE],
    ["equal to default", 15 * MINUTE, force, 15 * MINUTE],
    ["longer than default is clamped", 60 * MINUTE, force, 15 * MINUTE],
    ["far longer is clamped", 100 * DAY, force, 15 * MINUTE],
    ["one hour on a 24 h row", HOUR, diag, HOUR],
    ["two days on a 24 h row is clamped", 2 * DAY, diag, DAY],
    ["one millisecond", 1, diag, 1],
    ["zero falls back to the default", 0, diag, DAY],
    ["negative falls back to the default", -5, diag, DAY],
    ["minus zero falls back to the default", -0, diag, DAY],
    ["NaN falls back to the default", Number.NaN, diag, DAY],
    ["Infinity falls back to the default", Number.POSITIVE_INFINITY, diag, DAY],
    ["-Infinity falls back to the default", Number.NEGATIVE_INFINITY, diag, DAY],
    ["fractional is floored", 1500.9, diag, 1500],
    ["a sub-millisecond request is raised to one", 0.4, diag, 1],
    ["row above the ceiling, nothing requested", undefined, huge, 7 * DAY],
    ["row above the ceiling, shorter requested", 3 * DAY, huge, 3 * DAY],
    ["row above the ceiling, exactly the ceiling", 7 * DAY, huge, 7 * DAY],
    ["row above the ceiling, longer than the ceiling", 8 * DAY, huge, 7 * DAY],
    ["row above the ceiling, enormous", Number.MAX_SAFE_INTEGER, huge, 7 * DAY],
    ["largest safe integer on a 15 minute row", Number.MAX_SAFE_INTEGER, force, 15 * MINUTE],
  ];

  it.each(cases)("%s", (_label, requested, row, expected) => {
    expect(resolveTtlMs(requested, row)).toBe(expected);
  });

  it("has at least twenty cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });

  it("never lengthens and never exceeds the ceiling, for a sweep of requests", () => {
    const requests = [undefined, -1, 0, 1, 1000, HOUR, DAY, 3 * DAY, 7 * DAY, 9 * DAY, 1e15, 1e300];
    for (const row of [force, diag, huge, { ttlMs: 1 }]) {
      const rowDefault = Math.min(row.ttlMs, TTL_CEILING_MS);
      for (const requested of requests) {
        const value = resolveTtlMs(requested, row);
        expect(value).toBeLessThanOrEqual(rowDefault);
        expect(value).toBeLessThanOrEqual(TTL_CEILING_MS);
        expect(value).toBeGreaterThan(0);
        if (requested !== undefined && requested >= 1 && requested <= rowDefault) {
          expect(value).toBe(Math.floor(requested));
        }
      }
    }
  });
});

describe("no always-allow concept (Test 7, APPR-05)", () => {
  const FAMILY = /always|allow|remember|persist|blanket|forever|standing|dont-?ask|don't|sticky/i;

  it("has no exported name in the classification module that matches", () => {
    const names = Object.keys(classificationModule);
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) {
      expect(FAMILY.test(name), name).toBe(false);
    }
  });

  it("has no row field, row name or class that matches", () => {
    const keys = new Set<string>();
    for (const [name, row] of Object.entries(CLASSIFICATION)) {
      keys.add(name);
      for (const key of Object.keys(row)) keys.add(key);
    }
    for (const klass of CAPABILITY_CLASSES) keys.add(klass);
    for (const key of keys) {
      expect(FAMILY.test(key), key).toBe(false);
    }
  });

  it("gives approval-required rows exactly the documented field set", () => {
    for (const [name, row] of Object.entries(CLASSIFICATION)) {
      if (row.class !== "approval-required") continue;
      expect(Object.keys(row).sort(), name).toEqual([
        "class",
        "maxApprovalAgeMs",
        "modifiable",
        "retry",
        "status",
        "summary",
        "ttlMs",
      ]);
    }
  });
});

describe("the table type is usable for injection (D-43)", () => {
  it("accepts a hand-built table with the same row shapes", () => {
    const injected = {
      "test.op": {
        class: "approval-required",
        status: "enabled",
        ttlMs: MINUTE,
        maxApprovalAgeMs: MINUTE,
        retry: "never",
        modifiable: false,
        summary: "a test operation",
      },
      "test.other": { class: "no-approval", reason: "a reason" },
    } as const satisfies ClassificationTable;
    expect(Object.keys(injected)).toHaveLength(2);
  });
});

// --- source scan helpers ----------------------------------------------------

/** Directory names holding test-only helpers (fixtures), never shipped product source. */
const TEST_ONLY_DIRS: readonly string[] = ["test-support"];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (TEST_ONLY_DIRS.includes(entry)) continue;
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\./.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

interface TokenLiteralHit {
  readonly file: string;
  readonly literal: string;
}

function tokenLiteralsIn(source: string, file: string): TokenLiteralHit[] {
  const hits: TokenLiteralHit[] = [];
  for (const match of source.matchAll(/CapabilityToken\s*<\s*"([^"]+)"/g)) {
    if (match[1] !== undefined) hits.push({ file, literal: match[1] });
  }
  return hits;
}

/** Every `CapabilityToken<"literal">` in every non-test source file under packages/*\/src. */
function collectTokenLiterals(): TokenLiteralHit[] {
  const hits: TokenLiteralHit[] = [];
  for (const pkg of readdirSync(PACKAGES_DIR)) {
    const src = join(PACKAGES_DIR, pkg, "src");
    try {
      if (!statSync(src).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of listSourceFiles(src)) {
      hits.push(...tokenLiteralsIn(readFileSync(file, "utf8"), file));
    }
  }
  return hits;
}

describe("Phase 05.1 capabilities (D-31, assumption A10)", () => {
  const DIRECT = [
    ["launch:codex", "launch.codex"],
    ["launch:claude-codex-pair", "launch.claude-codex-pair"],
    ["codex:open-transcript", "codex.open-transcript"],
    ["codex:follow-log", "codex.follow-log"],
  ] as const;

  it("classifies the four launch and open capabilities as direct gestures naming the click as the decision", () => {
    for (const [capability, operation] of DIRECT) {
      const hit = classifyCapability(capability);
      expect(hit?.operation, capability).toBe(operation);
      expect(hit?.row.class, capability).toBe("direct-gesture");
      if (hit?.row.class !== "direct-gesture") throw new Error("unreachable");
      expect(hit.row.reason.trim().length, capability).toBeGreaterThan(0);
      expect(hit.row.reason, capability).toMatch(/click/);
    }
  });

  it("reserves codex.hooks.install with the same policy as the merged hooks.install row", () => {
    const codex = CLASSIFICATION["codex.hooks.install"];
    const claude = CLASSIFICATION["hooks.install"];
    expect(codex.class).toBe("approval-required");
    expect(codex.status).toBe("reserved");
    const { summary: codexSummary, ...codexPolicy } = codex;
    const { summary: claudeSummary, ...claudePolicy } = claude;
    expect(codexPolicy).toEqual(claudePolicy);
    expect(codexSummary).toMatch(/Codex hook/);
    expect(codexSummary).not.toBe(claudeSummary);
    // Like hooks.install it has no capability string: only the engine can name it.
    expect(Object.values(CAPABILITY_OPERATION)).not.toContain("codex.hooks.install");
  });

  it("makes no other new row reserved, and adds no connect row", () => {
    for (const [, operation] of DIRECT) {
      expect(CLASSIFICATION[operation].class).toBe("direct-gesture");
    }
    expect(Object.keys(CLASSIFICATION).filter((name) => name.startsWith("connect."))).toEqual([
      "connect.navigate",
    ]);
  });

  it("fails the exhaustiveness proof when any one of the five rows is removed (copy of the table)", () => {
    const names = [...DIRECT.map(([, operation]) => operation), "codex.hooks.install"] as const;
    for (const removed of names) {
      const copy: Record<string, unknown> = { ...CLASSIFICATION };
      delete copy[removed];
      const unresolved = [
        ...Object.entries(CAPABILITY_OPERATION)
          .filter(([, operation]) => !Object.hasOwn(copy, operation))
          .map(([capability]) => capability),
        ...(Object.hasOwn(copy, "codex.hooks.install") ? [] : ["codex.hooks.install"]),
      ];
      expect(unresolved, removed).not.toEqual([]);
    }
  });
});
