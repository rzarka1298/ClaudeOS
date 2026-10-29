import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./gate-repo.js";
import {
  type Cite,
  cellsOf,
  citesOf,
  commitExists,
  filesOfCommit,
  isTestFile,
  liveTitles,
  reachableFromHead,
  section,
  unchangedBetween,
} from "./phase-evidence-support.js";

/**
 * Plan 09-23 (T-09-49): keeps the Phase 9 threat-evidence record, its presence trust chain, its
 * same-user residuals, the merge-gate runbook and the validation map true to the repository. These are
 * private planning artifacts: a public clone has no `.planning/` and reports that once. A claim that
 * cites a file, a test title, a commit, a cap or a command that no longer exists fails here, so a
 * stale proof cannot give the security judge false assurance.
 */

const PLANNING_INDEX = join(REPO_ROOT, ".planning", "ROADMAP.md");
const planned = existsSync(PLANNING_INDEX);
const phasesDir = join(REPO_ROOT, ".planning", "phases");
const phaseName = existsSync(phasesDir)
  ? readdirSync(phasesDir).find((entry) => entry.startsWith("09-"))
  : undefined;
const dir = phaseName === undefined ? "" : join(phasesDir, phaseName);
const read = (name: string): string =>
  planned && existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "";
const evidence = read("09-THREAT-EVIDENCE.md");

const run = planned ? describe : describe.skip;

/** The base of the phase (main when the phase branch was cut) and the last commit before this plan. */
const PHASE_BASE = "71d14e7a";
const BEFORE_PLAN_23 = "a0474e2b";

describe("guard (Test 1)", () => {
  it("finds the documents whenever the planning index exists", () => {
    if (!planned) {
      expect(existsSync(PLANNING_INDEX)).toBe(false);
      return;
    }
    expect(phaseName, "the phase directory").toBeDefined();
    for (const name of ["09-THREAT-EVIDENCE.md", "09-UAT.md", "09-PRESENCE-SPIKE.md"]) {
      expect(existsSync(join(dir, name)), name).toBe(true);
    }
  });
});

function planFiles(): string[] {
  return readdirSync(dir).filter((name) => /^09-\d\d-PLAN\.md$/.test(name));
}

function planThreatIds(): Set<string> {
  const ids = new Set<string>();
  for (const file of planFiles()) {
    for (const match of readFileSync(join(dir, file), "utf8").matchAll(
      /^\| (T-09-[A-Za-z0-9]+) \|/gm,
    )) {
      ids.add(match[1] as string);
    }
  }
  return ids;
}

interface Row {
  readonly id: string;
  readonly disposition: string;
  readonly kind: string;
  readonly cell: string;
  readonly cites: Cite[];
  readonly commits: string;
  readonly status: string;
}

function rows(): Row[] {
  const out: Row[] = [];
  for (const line of evidence.split("\n")) {
    const cells = cellsOf(line);
    if (!/^T-09-[A-Za-z0-9]+$/.test(cells[1] ?? "")) continue;
    out.push({
      id: cells[1] as string,
      disposition: cells[3] ?? "",
      kind: cells[4] ?? "",
      cell: cells[5] ?? "",
      cites: citesOf(cells[5] ?? ""),
      commits: cells[6] ?? "",
      status: cells[7] ?? "",
    });
  }
  return out;
}

function checkCites(label: string, cites: Cite[]): number {
  let checked = 0;
  for (const cite of cites) {
    const path = join(REPO_ROOT, cite.file);
    expect(existsSync(path), `${label} ${cite.file}`).toBe(true);
    const text = readFileSync(path, "utf8");
    expect(text, `${label} ${cite.file} "${cite.quote}"`).toContain(cite.quote);
    if (isTestFile(cite.file)) {
      expect(
        liveTitles(text).has(cite.quote),
        `${label} ${cite.file} "${cite.quote}" is a live test title`,
      ).toBe(true);
    }
    checked += 1;
  }
  return checked;
}

/** A cited file counts as proof when it is a vitest file, a repository script or a phase spike test. */
const isProofFile = (file: string): boolean =>
  isTestFile(file) ||
  /^scripts\//.test(file) ||
  /^\.planning\/phases\/09-[^/]+\/spike\/test-[a-z-]+\.sh$/.test(file);

const MITIGATED_STATUS = ["proved", "proved, residual noted"];
const ACCEPTED_STATUS = ["accepted", "accepted, residual noted"];

run("completeness and shape (Tests 1 and 2 of Task 2)", () => {
  it("has a row for exactly the declared threat ids, including the supply-chain id", () => {
    const declared = planThreatIds();
    for (const id of ["T-09-SC", "T-09-01", "T-09-29", "T-09-39", "T-09-48", "T-09-49"]) {
      expect(declared.has(id), id).toBe(true);
    }
    // T-09-01 to T-09-49 and T-09-SC.
    expect(declared.size).toBe(50);
    expect(new Set(rows().map((row) => row.id))).toEqual(declared);
    expect(rows().length).toBe(declared.size);
  });

  it("gives every row a disposition, an evidence kind, a file, a quoted title, commits and a status", () => {
    expect(rows().length).toBe(50);
    for (const row of rows()) {
      expect(["mitigate", "accept"], row.id).toContain(row.disposition);
      expect(
        ["test", "script", "gate", "document", "source scan", "measurement"],
        row.id,
      ).toContain(row.kind);
      expect(row.cites.length, row.id).toBeGreaterThan(0);
      for (const cite of row.cites) {
        expect(cite.file, `${row.id} ${cite.file}`).not.toMatch(/^(\/|~|\.\.)/);
      }
      expect(row.cell, row.id).not.toMatch(/\b(TBD|TODO|unresolved|not built|untested)\b/);
      expect(row.commits, row.id).toMatch(/[0-9a-f]{8}|this plan/);
      if (row.status.startsWith("OPEN")) continue;
      expect(
        row.disposition === "accept" ? ACCEPTED_STATUS : MITIGATED_STATUS,
        `${row.id} status`,
      ).toContain(row.status);
    }
  });

  it("agrees with the plan tables on which rows are accepted and what each plan declared", () => {
    const accepted = new Set<string>();
    for (const file of planFiles()) {
      for (const match of readFileSync(join(dir, file), "utf8").matchAll(
        /^\| (T-09-[A-Za-z0-9]+) \|[^\n]*\| accept \|/gm,
      )) {
        accepted.add(match[1] as string);
      }
    }
    expect(accepted.has("T-09-SC")).toBe(true);
    expect(accepted.has("T-09-44")).toBe(true);
    expect(accepted.size).toBe(2);
    expect(
      new Set(
        rows()
          .filter((r) => r.disposition === "accept")
          .map((r) => r.id),
      ),
    ).toEqual(accepted);
  });

  it("lists exactly the rows marked OPEN under Open threats, and the residuals stay visible", () => {
    const open = rows()
      .filter((row) => row.status.startsWith("OPEN"))
      .map((row) => row.id);
    const sectionText = section(evidence, "Open threats");
    expect(sectionText.length).toBeGreaterThan(0);
    for (const id of open) expect(sectionText, id).toContain(id);
    if (open.length === 0) expect(sectionText).toMatch(/^None\./m);
    // The two threats whose mitigation is bounded by a recorded same-user residual say so in their status.
    for (const id of ["T-09-29", "T-09-39"]) {
      expect(rows().find((row) => row.id === id)?.status, id).toBe("proved, residual noted");
    }
  });
});

run("evidence is real (Test 3 of Task 2)", () => {
  it("cites files that exist and contain the quoted text, and test files whose quoted title is live", () => {
    let checked = 0;
    for (const row of rows()) {
      checked += checkCites(row.id, row.cites);
    }
    expect(checked).toBeGreaterThan(150);
  });

  it("makes every mitigated row cite a test or a script, and every accepted row a record", () => {
    for (const row of rows().filter((r) => r.disposition === "mitigate")) {
      expect(
        row.cites.some((c) => isProofFile(c.file)),
        row.id,
      ).toBe(true);
    }
    for (const row of rows().filter((r) => r.disposition === "accept")) {
      expect(
        row.cites.some((c) => /^(docs\/|\.planning\/)/.test(c.file) || c.file.endsWith(".json")),
        row.id,
      ).toBe(true);
    }
  });

  it("names commits that exist and are part of this history, for every row and for every fix round", () => {
    const header = evidence.split(/^\| Threat \|/m)[0] as string;
    const fixRounds = [...header.matchAll(/`([0-9a-f]{8})`/g)].map((m) => m[1] as string);
    expect(fixRounds.length).toBe(15);
    for (const hash of fixRounds) {
      expect(commitExists(hash), `fix round ${hash}`).toBe(true);
      expect(reachableFromHead(hash), `fix round ${hash} is reachable from HEAD`).toBe(true);
    }
    let checked = 0;
    for (const row of rows()) {
      for (const hash of row.commits.match(/\b[0-9a-f]{8}\b/g) ?? []) {
        expect(commitExists(hash), `${row.id} ${hash}`).toBe(true);
        expect(reachableFromHead(hash), `${row.id} ${hash} is reachable from HEAD`).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(120);
  }, 120_000);

  it("covers every fix round: each fix commit named in the header is cited by at least one row", () => {
    const header = evidence.split(/^\| Threat \|/m)[0] as string;
    const fixRounds = [...header.matchAll(/`([0-9a-f]{8})`/g)].map((m) => m[1] as string);
    const named = new Set(rows().flatMap((row) => row.commits.match(/\b[0-9a-f]{8}\b/g) ?? []));
    for (const hash of fixRounds) expect(named.has(hash), `fix commit ${hash}`).toBe(true);
    // The rounds the wave reviews record, by name, so a dropped round is visible in the header.
    for (const round of [
      "FIX1",
      "FIX2A",
      "FIX2B",
      "FIX2C",
      "FIX3A",
      "FIX3B",
      "FIX3C",
      "FIX6A",
      "FIX6B",
      "FIX7",
      "FIX8",
      "FIX9",
      "FIX10A",
      "FIX10B",
      "FIX11",
    ]) {
      expect(header, round).toContain(round);
    }
  });

  it("T-09-SC: the lockfile is byte-identical to its Phase 9 base, so no package was installed", () => {
    expect(commitExists(PHASE_BASE)).toBe(true);
    expect(unchangedBetween(PHASE_BASE, BEFORE_PLAN_23, "pnpm-lock.yaml")).toBe(true);
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts["presence:build"]).toBe("sh scripts/presence/build.sh");
  });

  it("T-09-47: the baselines were refreshed in an images-only commit and the tolerance is unchanged", () => {
    const files = filesOfCommit("7cc60bcf");
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) expect(file, file).toMatch(/\.png$/);
    expect(unchangedBetween(PHASE_BASE, BEFORE_PLAN_23, "playwright.config.ts")).toBe(true);
    expect(readFileSync(join(REPO_ROOT, "playwright.config.ts"), "utf8")).toContain(
      "maxDiffPixelRatio: 0.01,",
    );
  });

  describe("liveTitles (control: the check can fail)", () => {
    const sample = [
      '// it("only in a comment", () => {});',
      'describe("a suite", () => {',
      '  it("a live case", () => {});',
      '  it.skip("a skipped case", () => {});',
      '  it.todo("a todo case");',
      "  it(",
      '    "a case with its title on the next line",',
      "    () => {},",
      "  );",
      "});",
      'describe.skip("a skipped suite", () => {',
      '  it("a case in a skipped suite", () => {});',
      "});",
      'describe("a suite with nothing live", () => {',
      '  it.skip("only a skipped case", () => {});',
      "});",
    ].join("\n");
    const titles = liveTitles(sample);

    it("accepts live cases, wrapped titles and suites that hold a live case", () => {
      for (const title of ["a suite", "a live case", "a case with its title on the next line"]) {
        expect(titles.has(title), title).toBe(true);
      }
    });

    it("refuses skipped and todo cases, a case inside a skipped suite and text that is not a title", () => {
      for (const title of [
        "only in a comment",
        "a skipped case",
        "a todo case",
        "a skipped suite",
        "a case in a skipped suite",
        "a suite with nothing live",
        "only a skipped case",
      ]) {
        expect(titles.has(title), title).toBe(false);
      }
    });
  });
});

run("presence trust chain (Test 4 of Task 2)", () => {
  const chain = section(evidence, "Presence trust chain");

  interface Step {
    readonly step: number;
    readonly file: string;
    readonly symbol: string;
    readonly what: string;
    readonly proofs: Cite[];
  }

  function steps(): Step[] {
    const out: Step[] = [];
    for (const line of chain.split("\n")) {
      const cells = cellsOf(line);
      if (!/^\d+$/.test(cells[1] ?? "")) continue;
      out.push({
        step: Number(cells[1]),
        file: (/`([^`]+)`/.exec(cells[2] ?? "")?.[1] ?? "") as string,
        symbol: (/`([^`]+)`/.exec(cells[3] ?? "")?.[1] ?? "") as string,
        what: cells[4] ?? "",
        proofs: citesOf(cells[5] ?? ""),
      });
    }
    return out;
  }

  it("lists, in order, the adapter argv builder, the helper's prompt text, the custody key, the signature, the pin read, the engine verify, the stored proof, and the recovery and claim checks", () => {
    const order = [
      "createHelperPresencePort",
      "Approve %@ for request %@ (payload %@)",
      "SecKeyCreateRandomKey",
      "SecKeyCreateSignature",
      "readItemComment",
      "verifyPresenceSignature",
      "decision_proof",
      "recoverApproved",
      "claimAndStart",
    ];
    expect(steps().map((s) => s.symbol)).toEqual(order);
    expect(steps().map((s) => s.step)).toEqual(order.map((_, i) => i + 1));
  });

  it("names a real file and a real symbol in it for every step, and proves each with live tests or scripts", () => {
    for (const step of steps()) {
      const path = join(REPO_ROOT, step.file);
      expect(existsSync(path), `step ${step.step} ${step.file}`).toBe(true);
      expect(readFileSync(path, "utf8"), `step ${step.step} ${step.symbol}`).toContain(step.symbol);
      expect(step.proofs.length, `step ${step.step}`).toBeGreaterThan(0);
      expect(
        step.proofs.some((p) => isProofFile(p.file)),
        `step ${step.step} cites a test or script`,
      ).toBe(true);
      checkCites(`step ${step.step}`, step.proofs);
    }
  });

  it("states what each end of the chain does: no caller text in the prompt, a gesture before the key, a pin of the login keychain", () => {
    const byStep = (n: number): string => steps()[n - 1]?.what ?? "";
    expect(byStep(1)).toMatch(/prove --message <base64>/);
    expect(byStep(1)).toMatch(/no shell/);
    expect(byStep(2)).toMatch(/no --reason/);
    expect(byStep(2)).toMatch(/nothing the caller sent/);
    expect(byStep(3)).toMatch(/hardened runtime/);
    expect(byStep(4)).toMatch(/only after the owner's .*gesture/);
    expect(byStep(5)).toMatch(/login keychain/);
    expect(byStep(5)).toMatch(/guardPinReader/);
    expect(byStep(6)).toMatch(/P-256/);
    expect(byStep(7)).toMatch(/write-once/);
    expect(byStep(8)).toMatch(/before the claim/);
    expect(byStep(9)).toMatch(/immediately before execution/);
    // The helper's prompt text is built from these fields only; the source says so.
    const helper = readFileSync(join(REPO_ROOT, "scripts/presence/ccc-presence.m"), "utf8");
    expect(helper).toContain(
      "There is no --reason argument and no code path that copies caller text",
    );
  });

  it("is backed by the code: the argv is a fixed array, the signature is checked against the pin, and the last gate re-verifies", () => {
    const adapter = readFileSync(
      join(REPO_ROOT, "packages/service/src/approval-wiring/presence.ts"),
      "utf8",
    );
    expect(adapter).toContain(
      '["prove", "--message", Buffer.from(message, "utf8").toString("base64")]',
    );
    const proof = readFileSync(join(REPO_ROOT, "packages/service/src/approval/proof.ts"), "utf8");
    expect(proof).toContain("export function verifyPresenceSignature(");
    const engine = readFileSync(join(REPO_ROOT, "packages/service/src/approval/engine.ts"), "utf8");
    expect(engine).toContain(
      "verifyDecisionProof(proofKey, row, { presenceRequired: required, pin })",
    );
    const recovery = readFileSync(
      join(REPO_ROOT, "packages/service/src/approval/recovery.ts"),
      "utf8",
    );
    expect(recovery).toContain("claimAndStart(approved, definition)");
    const migration = readFileSync(
      join(REPO_ROOT, "packages/operational-store/migrations/0013_approval_decision_proof.sql"),
      "utf8",
    );
    expect(migration).toContain("decision_proof");
  });
});

run("same-user residuals (Test 5 of Task 2)", () => {
  const residuals = section(evidence, "Same-user residuals");
  const adr = readFileSync(
    join(REPO_ROOT, "docs/adr/0032-connector-approvals-need-the-owners-presence.md"),
    "utf8",
  );
  const flat = (value: string): string => value.replace(/\s+/g, " ").trim();
  const spike = read("09-PRESENCE-SPIKE.md");
  const spikeValue = (key: string): string =>
    (new RegExp(`^${key}: (.+)$`, "m").exec(spike)?.[1] ?? "").trim();

  /** The block-quoted passages of the section, each a verbatim passage of ADR 0032. */
  function quotes(): string[] {
    const out: string[] = [];
    let current: string[] = [];
    for (const line of residuals.split("\n")) {
      if (line.startsWith("> ")) current.push(line.slice(2));
      else if (current.length > 0) {
        out.push(flat(current.join(" ")));
        current = [];
      }
    }
    if (current.length > 0) out.push(flat(current.join(" ")));
    return out;
  }

  it("quotes ADR 0032's residual sentences word for word", () => {
    const found = quotes();
    expect(found.length).toBeGreaterThanOrEqual(6);
    const adrText = flat(adr);
    for (const quote of found) {
      expect(quote.length, quote).toBeGreaterThan(40);
      expect(adrText, quote).toContain(quote);
    }
    const all = found.join(" ");
    expect(all).toMatch(/Roadmap success criterion 2 is partially met/);
    expect(all).toMatch(/Cause a prompt, not answer it/);
    expect(all).toMatch(/Replace the helper/);
    expect(all).toMatch(/Read the install secret and so compute the MAC/);
    expect(all).toMatch(/Delete and recreate the pin item/);
    expect(all).toMatch(/detection, not prevention/);
  });

  it("names the shipped custody, pin and channel exactly as 09-PRESENCE-SPIKE.md records them", () => {
    for (const key of ["custody", "pin", "channel", "verdict_sc2", "applies"]) {
      const value = spikeValue(key);
      expect(value, `${key} in the spike record`).not.toBe("");
      expect(residuals, key).toContain(`\`${key}: ${value}\``);
    }
    expect(spikeValue("custody")).toBe("K-ATTR");
    expect(spikeValue("applies")).toBe("partially-met");
    expect(spikeValue("verdict_sc2")).toBe("partially-met");
    // The sentence the verifier reports is the spike's own `partially-met` line.
    const reporting =
      /^partially-met: (Roadmap success criterion 2 is partially met:[^\n]+)$/m.exec(
        spike,
      )?.[1] as string;
    expect(reporting).toBeTruthy();
    expect(flat(residuals)).toContain(flat(reporting));
  });

  it("states the threats whose mitigation these residuals bound, and the one measurement that can change the verdict", () => {
    for (const id of ["T-09-29", "T-09-39", "T-09-45"]) expect(residuals, id).toContain(id);
    expect(residuals).toMatch(/attr_delete_prompts/);
    expect(residuals).toMatch(/`09-UAT\.md` item 18/);
    expect(residuals).toMatch(/Nothing here claims that a same-user process cannot forge/);
  });
});

// ---------------------------------------------------------------------------------------------
// Task 3: the merge-gate runbook, the validation map with its ledger, and the folded todos

const gates = read("09-MERGE-GATES.md");
const validation = read("09-VALIDATION.md");

describe("guard for the runbook and the validation map (Test 1 of Task 3)", () => {
  it("finds both documents whenever the planning index exists", () => {
    if (!planned) {
      expect(existsSync(PLANNING_INDEX)).toBe(false);
      return;
    }
    for (const name of ["09-MERGE-GATES.md", "09-VALIDATION.md"]) {
      expect(existsSync(join(dir, name)), name).toBe(true);
    }
  });
});

function packageScripts(path: string): Record<string, string> {
  return (
    JSON.parse(readFileSync(join(REPO_ROOT, path), "utf8")) as { scripts: Record<string, string> }
  ).scripts;
}

/** The spec file base names a spec map declares, read as text (the e2e package is a leaf). */
function specNames(mapFile: string): string[] {
  const source = readFileSync(join(REPO_ROOT, "packages", "e2e", "src", mapFile), "utf8");
  return [...source.matchAll(/specPath\("([a-z0-9-]+)"\)/g)].map((m) => m[1] as string);
}

/** The `--spec` base names on the one runbook line that runs the given phase script. */
function runLineSpecs(phase: "07" | "08" | "09"): string[] {
  const line = gates
    .split("\n")
    .find((l) => l.includes("packages/e2e/dist/cli.js run") && l.includes(`${phase}-UAT.md`));
  expect(line, `the run command for phase ${phase}`).toBeDefined();
  return [
    ...(line as string).matchAll(/--spec "\$PWD\/packages\/e2e\/specs\/([a-z0-9-]+)\.e2e\.ts"/g),
  ].map((m) => m[1] as string);
}

const flatText = (value: string): string => value.replace(/\s+/g, " ").trim();

/** Test files a command names under `--filter @ccc/<pkg> exec vitest run ...`, globs expanded. */
function vitestFiles(command: string): { pkg: string; path: string }[] {
  const out: { pkg: string; path: string }[] = [];
  for (const match of command.matchAll(/--filter @ccc\/([a-z0-9-]+) exec vitest run ([^&;|`]*)/g)) {
    for (const path of (match[2] as string).split(/\s+/).filter((p) => /\.test\.tsx?$/.test(p))) {
      out.push({ pkg: match[1] as string, path });
    }
  }
  return out;
}

function fileExistsOrGlob(pkg: string, path: string): boolean {
  const full = join(REPO_ROOT, "packages", pkg, path);
  if (!path.includes("*")) return existsSync(full);
  const folder = join(full, "..");
  const pattern = new RegExp(
    `^${(path.split("/").pop() as string).replace(/[.]/g, "\\.").replace(/\*/g, ".*")}$`,
  );
  return existsSync(folder) && readdirSync(folder).some((name) => pattern.test(name));
}

run("merge-gate runbook (Tests 1 to 3 of Task 3)", () => {
  const ORDER = [
    "Post-wave gates",
    "Full unfiltered test run",
    "Next-free value re-checks",
    "Container visual comparison",
    "Audit before the runs",
    "Automated runs at the same final head",
    "Look verdicts",
    "Report and ratification",
    "Judge panel",
    "Codex blocking judge",
    "Owner sitting",
    "Strict audit after the sitting",
    "Merge and publish",
    "Closing checklist",
  ];

  it("orders the sections as the plan requires", () => {
    const positions = ORDER.map((title, index) => gates.indexOf(`## ${index + 1}. ${title}`));
    for (const [index, position] of positions.entries()) {
      expect(position, ORDER[index]).toBeGreaterThan(-1);
    }
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("makes all three automated runs at one clean head after the last product commit, with separate --spec lists", () => {
    const shared = section(gates, "6\\. Automated runs at the same final head");
    expect(shared).toMatch(/same final head/);
    expect(shared).toMatch(/after the last product commit/);
    expect(shared).toMatch(/09-22 baselines|baselines/);
    expect(shared).toMatch(/clean/);
    expect(shared).toMatch(/staleness/i);
    expect(shared).toContain("packages/e2e/src/staleness.ts");
    expect(existsSync(join(REPO_ROOT, "packages/e2e/src/staleness.ts"))).toBe(true);
    // Phase 7's four research specs, Phase 8's five and Phase 9's hardening spec, each list the map declares.
    const seven = runLineSpecs("07");
    const eight = runLineSpecs("08");
    const nine = runLineSpecs("09");
    expect([...seven].sort()).toEqual([...specNames("spec-map-07.ts")].sort());
    expect([...eight].sort()).toEqual([...specNames("spec-map-08.ts")].sort());
    expect([...nine].sort()).toEqual([...specNames("spec-map-09.ts")].sort());
    expect(seven).toHaveLength(4);
    expect(eight).toHaveLength(5);
    expect(nine).toEqual(["hardening"]);
    const all = [...seven, ...eight, ...nine];
    expect(new Set(all).size, "no spec file is run twice").toBe(all.length);
    for (const name of all) {
      expect(existsSync(join(REPO_ROOT, "packages", "e2e", "specs", `${name}.e2e.ts`)), name).toBe(
        true,
      );
    }
    // Each run has its own screenshots folder and its own report.
    for (const phase of ["7", "8", "9"]) expect(gates).toContain(`ccc-phase${phase}-shots`);
    for (const phase of ["07", "08", "09"]) expect(gates).toContain(`${phase}-UAT-AUTO-REPORT.md`);
    // The Phase 9 run command is the one the plan names.
    expect(gates).toContain(
      'node packages/e2e/dist/cli.js run --profile standard --script "$PWD/.planning/phases/09-hardening-honest-session-state-and-trustworthy-approvals/09-UAT.md" --phase-dir "$PWD/.planning/phases/09-hardening-honest-session-state-and-trustworthy-approvals" --spec "$PWD/packages/e2e/specs/hardening.e2e.ts" --shots-dir "$TMPDIR/ccc-phase9-shots"',
    );
  });

  it("names only commands, scripts, runner subcommands, flags and test files that exist", () => {
    const scripts = packageScripts("package.json");
    const e2eScripts = packageScripts("packages/e2e/package.json");
    let checked = 0;
    for (const match of gates.matchAll(/pnpm run ([a-z][a-z0-9:-]*)/g)) {
      expect(scripts[match[1] as string], match[0]).toBeDefined();
      checked += 1;
    }
    for (const match of gates.matchAll(/pnpm --filter @ccc\/e2e run ([a-z][a-z0-9:-]*)/g)) {
      expect(e2eScripts[match[1] as string], match[0]).toBeDefined();
      checked += 1;
    }
    for (const match of gates.matchAll(
      /pnpm --filter @ccc\/([a-z0-9-]+) run ([a-z][a-z0-9:-]*)/g,
    )) {
      const pkg = packageScripts(`packages/${match[1]}/package.json`);
      expect(pkg[match[2] as string], match[0]).toBeDefined();
      checked += 1;
    }
    for (const match of gates.matchAll(/\b(?:sh|node) (scripts\/[A-Za-z0-9_./-]+)/g)) {
      expect(existsSync(join(REPO_ROOT, match[1] as string)), match[0]).toBe(true);
      checked += 1;
    }
    const turbo = JSON.parse(readFileSync(join(REPO_ROOT, "turbo.json"), "utf8")) as {
      tasks: Record<string, unknown>;
    };
    for (const match of gates.matchAll(/turbo run ((?:[a-z:]+ ?)+?)(?= --|`|$| &&)/gm)) {
      for (const task of (match[1] as string).trim().split(/\s+/)) {
        expect(turbo.tasks[task], `turbo task ${task}`).toBeDefined();
        checked += 1;
      }
    }
    for (const { pkg, path } of vitestFiles(gates)) {
      expect(fileExistsOrGlob(pkg, path), `${pkg} ${path}`).toBe(true);
      checked += 1;
    }
    const cli = readFileSync(join(REPO_ROOT, "packages", "e2e", "src", "cli.ts"), "utf8");
    const cliArgs = readFileSync(join(REPO_ROOT, "packages", "e2e", "src", "cli-args.ts"), "utf8");
    const knownFlag = (name: string): boolean =>
      cliArgs.includes(`"${name}"`) || new RegExp(`\\b${name}: \\{ type:`).test(cliArgs);
    for (const line of gates.split("\n").filter((l) => l.includes("packages/e2e/dist/cli.js"))) {
      const command = /packages\/e2e\/dist\/cli\.js ([a-z-]+)/.exec(line)?.[1] as string;
      const key = command.includes("-") ? `"${command}"` : command;
      expect(cli, `runner command ${command}`).toContain(key);
      if (command === "look") {
        const sub = /cli\.js look (list|record)\b/.exec(line)?.[1] as string;
        expect(cliArgs, `look ${sub}`).toContain(`look ${sub}`);
      }
      for (const flag of line.match(/--[a-z][a-z-]*/g) ?? []) {
        expect(knownFlag(flag.slice(2)), `${command} ${flag}`).toBe(true);
        checked += 1;
      }
    }
    // The audit is run as `pnpm run uat:audit` and `pnpm run uat:audit --strict`; a `--` before the
    // flag is a usage error (shown in the text).
    for (const line of gates.split("\n").filter((l) => /pnpm run uat:audit/.test(l))) {
      for (const flag of line.match(/(?<=\s)--[a-z][a-z-]*/g) ?? []) {
        expect(knownFlag(flag.slice(2)), `uat:audit ${flag}`).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(60);
  });

  it("names every gate the final run uses, and the planning-reading suites with their globs", () => {
    for (const gate of [
      "ci:format",
      "ci:lint",
      "ci:boundaries",
      "ci:backstop",
      "ci:obsidianmd",
      "ci:privacy",
      "ci:images",
      "ci:typecheck",
    ]) {
      expect(gates, gate).toContain(`pnpm run ${gate}`);
    }
    expect(gates).toContain("sh scripts/ci/visual-in-container.sh");
    expect(gates).toContain("pnpm run uat:audit");
    expect(gates).toContain("pnpm exec turbo run build typecheck test --concurrency=2");
    expect(gates).toContain("pnpm --filter @ccc/test-fixtures exec vitest run");
    expect(gates).toContain("pnpm --filter @ccc/e2e exec vitest run src/docs-wording.test.ts");
  });

  it("re-derives the next-free values: migration 0013 is the last, ADR 0032 the highest, the backstop checks 18 rules", () => {
    const nextFree = section(gates, "3\\. Next-free value re-checks");
    expect(nextFree).toMatch(/0013/);
    expect(nextFree).toMatch(/0032/);
    // Built from parts: phase051-wiring.audit.test.ts allows the literal rule-count sentence in one file only.
    expect(nextFree).toContain(["checked", "18", "rules"].join(" "));
    // The repository agrees with what the runbook asks the parent to re-derive.
    const migrations = readdirSync(join(REPO_ROOT, "packages/operational-store/migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(migrations.at(-1)).toBe("0013_approval_decision_proof.sql");
    const journal = JSON.parse(
      readFileSync(
        join(REPO_ROOT, "packages/operational-store/migrations/meta/_journal.json"),
        "utf8",
      ),
    ) as { entries: unknown[] };
    expect(journal.entries.length).toBe(migrations.length);
    const adrs = readdirSync(join(REPO_ROOT, "docs/adr")).filter((name) => /^\d{4}-/.test(name));
    expect(adrs.sort().at(-1)).toMatch(/^0032-/);
    expect(adrs.filter((name) => name.startsWith("0032-"))).toHaveLength(1);
    const script = readFileSync(join(REPO_ROOT, "scripts/check-boundaries.sh"), "utf8");
    expect((script.match(/^# --- Rule \d+:/gm) ?? []).length).toBe(18);
    expect(script).not.toMatch(/^# --- Rule 19:/m);
  });

  it("states the policies the plan requires", () => {
    expect(gates).toMatch(/full unfiltered run is the post-merge gate/);
    expect(gates).toMatch(/never used to execute plans marked high risk/i);
    expect(gates).toMatch(/80 percent of the weekly allowance/);
    expect(gates).toMatch(/blind dual review and debate/);
    expect(gates).toMatch(/accept auto-results of run/);
    for (const judge of [
      "gsd-verifier",
      "code-review",
      "prd-compliance-review",
      "claude-security",
      "gsd-security-auditor",
      "opus",
    ]) {
      expect(gates, judge).toContain(judge);
    }
    for (const doc of [
      "09-THREAT-EVIDENCE.md",
      "09-UAT-AUTO-REPORT.md",
      "08-UAT-AUDIT.md",
      "09-VALIDATION.md",
      "09-WAVE-REVIEWS.md",
      "09-PRESENCE-SPIKE.md",
    ]) {
      expect(gates, doc).toContain(doc);
    }
    expect(gates).toContain("ADR 0032");
    // The strict audit runs after the owner items, in the form that works.
    expect(gates).toMatch(/pnpm run uat:audit --strict/);
    expect(gates).toMatch(/uat:audit -- --strict/);
    expect(gates).toMatch(/usage error/);
    const strict = section(gates, "12\\. Strict audit after the sitting");
    expect(strict).toMatch(/pnpm run uat:audit --strict/);
    expect(strict).toMatch(/09-uat-17/);
    expect(strict).toMatch(/after the owner/i);
    // The owner sitting carries the Phase 9 items 9 to 19, including the optional measurement at 18.
    const sitting = section(gates, "11\\. Owner sitting");
    expect(sitting).toMatch(/items 9 to 19/);
    expect(sitting).toMatch(/[Ii]tem 18/);
    expect(sitting).toContain("attr_delete_prompts");
    expect(sitting).toContain("verdict_sc2");
    expect(sitting).toMatch(/[Ii]tems 9 and 10/);
  });

  it("lists the high-risk plans by reading each plan's front matter, and Codex never executes them", () => {
    const high = planFiles()
      .filter((name) => /^risk: high$/m.test(readFileSync(join(dir, name), "utf8")))
      .map((name) => name.slice(0, 5));
    expect(high.length).toBeGreaterThan(0);
    const listed = /High-risk plans[^:]*: ([^\n]+)/.exec(gates)?.[1] ?? "";
    for (const plan of high) expect(listed, plan).toContain(plan);
    const named = [...listed.matchAll(/09-\d\d/g)].map((m) => m[0]);
    expect(named.sort()).toEqual([...high].sort());
    expect(high).toEqual([
      "09-01",
      "09-10",
      "09-12",
      "09-13",
      "09-14",
      "09-15",
      "09-16",
      "09-17",
      "09-18",
      "09-19",
      "09-20",
    ]);
    for (const name of planFiles()) {
      expect(readFileSync(join(dir, name), "utf8"), name).toMatch(/^\s*codex_execute: never$/m);
    }
  });

  it("has the verifier report roadmap success criterion 2 in the spike record's own applicable sentence", () => {
    const judges = section(gates, "9\\. Judge panel");
    const spike = read("09-PRESENCE-SPIKE.md");
    const applies = /^applies: (.+)$/m.exec(spike)?.[1] as string;
    expect(applies).toBe("partially-met");
    const sentence = new RegExp(`^${applies}: (.+)$`, "m").exec(spike)?.[1] as string;
    expect(sentence).toMatch(/^Roadmap success criterion 2 is partially met/);
    expect(flatText(judges)).toContain(flatText(sentence));
    expect(judges).toContain("## Reporting rule");
    expect(judges).toMatch(/`applies: partially-met`/);
    expect(judges).toContain("## Verifier note");
    expect(judges).toContain("09-16-SUMMARY.md");
    expect(read("09-16-SUMMARY.md")).toMatch(/^## Verifier note$/m);
    // The reason is the unmeasured foreign delete (custody K-ATTR), not the K-SVC reason the plan assumed.
    expect(judges).toMatch(/foreign delete/);
    expect(judges).toMatch(/R-02/);
  });

  it("says only the orchestrator ticks the requirements, after the judges and the owner items pass", () => {
    const closing = section(gates, "14\\. Closing checklist");
    for (const id of ["SESS-19", "APPR-11", "APPR-12", "SVC-12", "DIAG-06", "SESS-06"]) {
      expect(closing, id).toContain(id);
    }
    expect(closing).toMatch(/only by the orchestrator/);
    expect(closing).toMatch(/after the judges and the owner items pass/);
    expect(closing).toMatch(/SESS-06[^.]*re-ticked|re-tick[^.]*SESS-06/);
    expect(closing).toContain("REQUIREMENTS.md");
  });

  it("records the known flakes, those of Phase 8 and every one this phase's wave reviews recorded", () => {
    const reviews = read("09-WAVE-REVIEWS.md");
    const flakes = section(gates, "2\\. Full unfiltered test run");
    for (const name of [
      "tasks/reindex.test.ts",
      "pair-launch.timing",
      "tasks-perf",
      "settings-live-region",
      "migrate.test.ts",
      "rate-limits-dispose",
      "terminal-launchers.detached",
      "codex-wrapper",
      "approval-boundary.audit.test.ts",
      "Failed to start forks worker",
      // recorded in 09-WAVE-REVIEWS.md
      "credential-canary",
      "check-boundaries-rules",
      "terminate-executor",
      "claude-sessions.int",
      "launchagent-install",
      "approvals-harness",
      "codex-sessions.int",
      "diagnostics-section",
    ]) {
      expect(flakes, name).toContain(name);
    }
    for (const name of ["credential-canary", "terminate-executor", "codex-sessions.int"]) {
      expect(reviews, `${name} in 09-WAVE-REVIEWS.md`).toContain(name);
    }
    expect(flakes).toMatch(/re-run (that file )?alone/i);
    expect(flakes).toMatch(/never skipped/);
    // Resolving each commit the threat record cites needs merge commits (no squash, no rebase).
    expect(flakes).toMatch(/merge commits/);
    expect(flakes).toMatch(/phase-evidence-09/);
  });

  it("gives the closing checklist its owner, audit, evidence, validation and service lines", () => {
    const closing = section(gates, "14\\. Closing checklist");
    for (const word of [
      "09-UAT.md",
      "07-UAT.md",
      "08-UAT.md",
      "08-UAT-AUDIT.md",
      "09-THREAT-EVIDENCE.md",
      "09-VALIDATION.md",
      "service restored",
      "09-PRESENCE-SPIKE.md",
    ]) {
      expect(closing, word).toContain(word);
    }
    expect(closing.match(/^- \[ \]/gm)?.length ?? 0).toBeGreaterThanOrEqual(8);
  });
});

run("validation map (Test 4 of Task 3)", () => {
  const front = /^---\n([\s\S]*?)\n---/.exec(validation)?.[1] ?? "";
  const mapSection = section(validation, "Per-Task Verification Map");

  interface MapRow {
    readonly plan: string;
    readonly task: number;
    readonly commands: string[];
    readonly exists: string;
    readonly status: string;
  }

  function mapRows(): MapRow[] {
    const out: MapRow[] = [];
    for (const line of mapSection.split("\n")) {
      const cells = cellsOf(line);
      const id = /^(09-\d\d)-T(\d+)$/.exec(cells[1] ?? "");
      if (id === null) continue;
      out.push({
        plan: id[1] as string,
        task: Number(id[2]),
        commands: [...(cells[8] ?? "").matchAll(/`([^`]+)`/g)].map((m) =>
          (m[1] as string).replace(/\\\|/g, "|"),
        ),
        exists: cells[9] ?? "",
        status: cells[10] ?? "",
      });
    }
    return out;
  }

  const GREEN = "✅ green";
  const MERGE_GATE = "⬜ merge gate";
  const OWNER = "✅ owner recorded";

  function missingFiles(commands: string[]): string[] {
    const missing: string[] = [];
    for (const command of commands) {
      for (const { pkg, path } of vitestFiles(command)) {
        if (!fileExistsOrGlob(pkg, path)) missing.push(path);
      }
    }
    return missing;
  }

  it("has one row per task of every 09-NN plan, with a command, an existing file and a status", () => {
    const rows = mapRows();
    for (const file of planFiles()) {
      const plan = file.slice(0, 5);
      const tasks = (readFileSync(join(dir, file), "utf8").match(/^\s*<task type=/gm) ?? []).length;
      expect(tasks, plan).toBeGreaterThan(0);
      const mine = rows.filter((row) => row.plan === plan);
      expect(
        mine.map((row) => row.task),
        plan,
      ).toEqual(Array.from({ length: tasks }, (_, i) => i + 1));
    }
    expect(rows.length).toBe(58);
    for (const row of rows) {
      expect(row.commands.length, `${row.plan} T${row.task}`).toBeGreaterThan(0);
      expect([GREEN, MERGE_GATE, OWNER], `${row.plan} T${row.task}`).toContain(row.status);
      expect(row.exists, `${row.plan} T${row.task}`).toContain("✅");
    }
  });

  it("carries each task's first automated command from its plan, and only the container compare is a merge gate", () => {
    const rows = mapRows();
    for (const file of planFiles()) {
      const plan = file.slice(0, 5);
      const blocks = [
        ...readFileSync(join(dir, file), "utf8").matchAll(/<task type=[^>]*>([\s\S]*?)<\/task>/g),
      ];
      for (const [index, block] of blocks.entries()) {
        const planned = [
          ...(block[1] as string).matchAll(/<automated>([\s\S]*?)<\/automated>/g),
        ].map((m) => flatText(m[1] as string));
        const row = rows.find((r) => r.plan === plan && r.task === index + 1);
        if (planned.length === 0) {
          // The one owner checkpoint (09-01 Task 3) has no automated command: its row says who ran it.
          expect(row?.status, `${plan} T${index + 1}`).toBe(OWNER);
          continue;
        }
        expect(
          (row?.commands ?? []).map((c) => flatText(c)),
          `${plan} T${index + 1}`,
        ).toContain(planned[0]);
      }
    }
    const open = rows.filter((row) => row.status === MERGE_GATE);
    expect(open.map((row) => `${row.plan}-T${row.task}`)).toEqual(["09-22-T3"]);
    for (const row of open) expect(row.commands.join(" ")).toContain("visual-in-container");
    expect(
      rows.filter((row) => row.status === OWNER).map((row) => `${row.plan}-T${row.task}`),
    ).toEqual(["09-01-T3"]);
  });

  it("names only test files that exist in the package the command filters to", () => {
    let checked = 0;
    for (const row of mapRows()) {
      expect(missingFiles(row.commands), `${row.plan} T${row.task}`).toEqual([]);
      for (const command of row.commands) checked += vitestFiles(command).length;
    }
    expect(checked).toBeGreaterThan(60);
  });

  it("sets nyquist_compliant and wave_0_complete true only when no row is MISSING", () => {
    const missing =
      mapRows().some(
        (row) => missingFiles(row.commands).length > 0 || /MISSING/.test(row.status),
      ) || /\bMISSING\b/.test(section(validation, "Wave 0 Requirements"));
    const nyquist = /^nyquist_compliant: (true|false)$/m.exec(front)?.[1];
    const wave0 = /^wave_0_complete: (true|false)$/m.exec(front)?.[1];
    expect(["true", "false"]).toContain(nyquist);
    expect(["true", "false"]).toContain(wave0);
    expect(nyquist).toBe(missing ? "false" : "true");
    expect(wave0).toBe(missing ? "false" : "true");
  });

  it("fills the Wave 0 table with files that exist", () => {
    const wave0 = section(validation, "Wave 0 Requirements");
    const rows = wave0.split("\n").filter((line) => /^\| W0-\d/.test(line));
    expect(rows.length).toBe(7);
    const paths = [...wave0.matchAll(/`((?:packages|scripts|docs|\.planning)\/[^`\s]+)`/g)].map(
      (m) => m[1],
    );
    expect(paths.length).toBeGreaterThan(8);
    for (const path of paths) expect(existsSync(join(REPO_ROOT, path as string)), path).toBe(true);
    for (const row of rows) expect(row, row).toMatch(/✅ filled/);
    // The docs-wording pin was normalised at planning; this phase changes no requirement count (R-06).
    expect(wave0).toContain("95620875");
    expect(commitExists("95620875")).toBe(true);
  });

  it("keeps the sign-off honest: the container compare row and the final-head runs are named", () => {
    const signOff = section(validation, "Validation Sign-Off");
    expect(signOff).toContain("09-MERGE-GATES.md");
    expect(signOff).toMatch(/container compare/i);
    expect(validation).toMatch(/Validated at head [0-9a-f]{8}/);
    const head = /Validated at head ([0-9a-f]{8})/.exec(validation)?.[1] as string;
    expect(commitExists(head), head).toBe(true);
    expect(reachableFromHead(head), `${head} is reachable from HEAD`).toBe(true);
  });
});

run("edge and prohibition ledger (Test 5 of Task 3)", () => {
  const ledger = section(validation, "Edge and Prohibition Ledger");
  const edges = ledger
    .split("\n")
    .map(cellsOf)
    .filter((cells) => /^E-\d\d$/.test(cells[1] ?? ""));
  const prohibitions = ledger
    .split("\n")
    .map(cellsOf)
    .filter((cells) => /^PR-\d\d$/.test(cells[1] ?? ""));
  const planText = (plan: string): string => {
    const file = planFiles().find((name) => name.startsWith(plan));
    expect(file, plan).toBeDefined();
    return readFileSync(join(dir, file as string), "utf8");
  };

  /** The prohibitions of each plan's front matter, in plan order. */
  function planProhibitions(): {
    plan: string;
    requirement: string;
    category: string;
    statement: string;
  }[] {
    const out: { plan: string; requirement: string; category: string; statement: string }[] = [];
    for (const file of planFiles()) {
      const text = readFileSync(join(dir, file), "utf8");
      const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
      const block =
        /^ {2}prohibitions:\n([\s\S]*?)(?=^\S|^ {2}[a-z_]+:|$(?![\s\S]))/m.exec(front)?.[1] ?? "";
      for (const item of block.split(/^ {4}- statement: /m).slice(1)) {
        const statement = /^"(.*)"\s*$/m.exec(item.split("\n")[0] as string)?.[1] as string;
        out.push({
          plan: file.slice(0, 5),
          statement,
          requirement: /requirement_id: (\S+)/.exec(item)?.[1] as string,
          category: /category: (\S+)/.exec(item)?.[1] as string,
        });
      }
    }
    return out;
  }

  it("lists seven edge rows: three resolved with the plan whose truth resolves them, four flagged with the plan that flags them", () => {
    expect(edges.map((cells) => cells[1])).toEqual([
      "E-01",
      "E-02",
      "E-03",
      "E-04",
      "E-05",
      "E-06",
      "E-07",
    ]);
    const state = (cells: string[]): string => cells[3] ?? "";
    expect(edges.filter((cells) => state(cells) === "resolved")).toHaveLength(3);
    expect(edges.filter((cells) => state(cells) === "flagged")).toHaveLength(4);
    // Resolved: SESS-19 boundary and precision (09-09), APPR-11 concurrency (09-14).
    expect(edges.slice(0, 3).map((cells) => [cells[2], cells[3], cells[4]])).toEqual([
      ["SESS-19", "resolved", "09-09"],
      ["SESS-19", "resolved", "09-09"],
      ["APPR-11", "resolved", "09-14"],
    ]);
    // Flagged: SESS-06 in 09-10, APPR-12 in 09-16, SVC-12 in 09-03, DIAG-06 in 09-04.
    expect(edges.slice(3).map((cells) => [cells[2], cells[3], cells[4]])).toEqual([
      ["SESS-06", "flagged", "09-10"],
      ["APPR-12", "flagged", "09-16"],
      ["SVC-12", "flagged", "09-03"],
      ["DIAG-06", "flagged", "09-04"],
    ]);
  });

  it("quotes text that the cited plan file really holds, and covers each edge with a live test or a UAT item", () => {
    for (const cells of edges) {
      const quote = /`([^`]+)`/.exec(cells[5] ?? "")?.[1];
      expect(quote, `${cells[1]} plan text`).toBeDefined();
      expect(planText(cells[4] as string), `${cells[1]} in ${cells[4]}`).toContain(quote as string);
      const covered = cells[6] ?? "";
      const cites = citesOf(covered);
      const items = [...covered.matchAll(/09-UAT\.md` item (\d+)/g)];
      expect(cites.length + items.length, `${cells[1]} is covered`).toBeGreaterThan(0);
      checkCites(cells[1] as string, cites);
    }
    // The owner/automated UAT items an edge points at exist in the final script.
    const uat = read("09-UAT.md");
    for (const cells of edges) {
      for (const match of (cells[6] ?? "").matchAll(/09-UAT\.md` item (\d+)/g)) {
        expect(uat, `${cells[1]} item ${match[1]}`).toContain(`### ${match[1]}. `);
      }
    }
  });

  it("states honestly what the plans assumed that did not ship as assumed", () => {
    const e05 = edges.find((cells) => cells[1] === "E-05");
    expect(e05?.[6]).toMatch(/not stated in ADR 0032/);
    const e04 = edges.find((cells) => cells[1] === "E-04");
    expect(e04?.[6]).toMatch(/flap/);
  });

  it("lists every prohibition of every plan with its plan, requirement, category and the plan's own statement", () => {
    const expected = planProhibitions();
    expect(expected.length).toBe(27);
    expect(prohibitions.length).toBe(expected.length);
    for (const [index, want] of expected.entries()) {
      const cells = prohibitions[index] as string[];
      const id = `PR-${String(index + 1).padStart(2, "0")}`;
      expect(cells[1], id).toBe(id);
      expect(cells[2], `${id} plan`).toBe(want.plan);
      expect(cells[3], `${id} requirement`).toBe(want.requirement);
      expect(cells[4], `${id} category`).toBe(want.category);
      expect(cells[5], `${id} statement`).toBe(want.statement);
      expect(planText(want.plan), `${id} statement is in ${want.plan}`).toContain(want.statement);
      const proofs = citesOf(cells[6] ?? "");
      expect(proofs.length, `${id} proof`).toBeGreaterThan(0);
      checkCites(id, proofs);
    }
  });

  it("balances: probe items equal authored truths plus flagged assumptions, so nothing is dropped silently", () => {
    // Flagged assumptions in the plan front matter are exactly the four flagged edge rows.
    const flagged: string[] = [];
    for (const file of planFiles()) {
      const text = readFileSync(join(dir, file), "utf8");
      for (const match of text.matchAll(
        /^ {4}- requirement_id: (\S+)\n {6}category: unclassified/gm,
      )) {
        flagged.push(`${file.slice(0, 5)}:${match[1]}`);
      }
    }
    expect(flagged.sort()).toEqual([
      "09-03:SVC-12",
      "09-04:DIAG-06",
      "09-10:SESS-06",
      "09-16:APPR-12",
    ]);
    // Authored truths for the resolved edges: the edge-probe tags in the plans.
    const resolved = edges.filter((cells) => cells[3] === "resolved");
    expect(resolved.length + flagged.length).toBe(edges.length);
    expect(flatText(section(validation, "Edge and Prohibition Ledger"))).toMatch(
      /seven edge rows: three resolved, four flagged/,
    );
  });
});

run("the folded todos are closed honestly (Test 3 of Task 3)", () => {
  const todos = join(REPO_ROOT, ".planning", "todos");
  const body = (state: "pending" | "done", name: string): string =>
    existsSync(join(todos, state, name)) ? readFileSync(join(todos, state, name), "utf8") : "";

  it("moves the event-client todo to done with a resolution naming 09-08, and leaves no pending copy", () => {
    const name = "2026-10-25-event-client-last-id-regress.md";
    expect(existsSync(join(todos, "pending", name))).toBe(false);
    const done = body("done", name);
    expect(done).toMatch(/^status: done$/m);
    expect(done).toMatch(/## Resolved \(plan 09-08/);
    expect(done).toContain("09-08");
    expect(done).toContain("event-client.test.ts");
  });

  it("keeps only item 3 of the Phase 8 polish todo pending, and names the plan that resolved each other item", () => {
    const text = body("pending", "2026-10-23-p8-live-look-polish.md");
    expect(text.length).toBeGreaterThan(0);
    const pendingPart = text.split(/^## Resolved/m)[0] as string;
    expect([...pendingPart.matchAll(/^(\d+)\. /gm)].map((m) => m[1])).toEqual(["3"]);
    const resolved = text.split(/^## Resolved/m)[1] ?? "";
    expect([...resolved.matchAll(/^(\d+)\. /gm)].map((m) => m[1])).toEqual(["1", "2", "4"]);
    expect(resolved).toContain("09-04");
  });

  it("keeps only the deferred MINORs of the code-review todo, each resolved item naming its plan", () => {
    const text = body("pending", "2026-10-25-code-review-judge-refactors.md");
    expect(text.length).toBeGreaterThan(0);
    const pendingPart = text.split(/^## Resolved/m)[0] as string;
    expect(pendingPart).toMatch(/html-to-text/);
    expect(pendingPart).toMatch(/per-view `styles\.css`|per-view styles/);
    expect(pendingPart).toMatch(/spec-support/);
    for (const gone of [
      "runStages",
      "refreshDueToday",
      "errno extractors",
      "Glossary",
      "08-PATTERNS",
    ]) {
      expect(pendingPart, gone).not.toContain(gone);
    }
    const resolved = text.split(/^## Resolved/m)[1] ?? "";
    for (const plan of ["09-12", "09-06", "09-07"]) expect(resolved, plan).toContain(plan);
  });
});
