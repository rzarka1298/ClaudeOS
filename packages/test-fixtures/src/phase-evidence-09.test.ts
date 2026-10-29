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
  });

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
