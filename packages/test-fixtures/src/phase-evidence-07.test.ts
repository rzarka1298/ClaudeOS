import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./gate-repo.js";

/**
 * Plan 07-18 Tasks 2 and 3 (T-07-48): keeps the Phase 7 threat-evidence record, its summariser
 * call-path trace (success criterion 4), its security scan inputs, the merge-gate runbook and the
 * validation map true to the repository. These are private planning artifacts: a public clone has
 * no `.planning/` and reports that once. A claim that cites a file or a test title that no longer
 * exists fails here, so a stale proof cannot give the security judge false assurance.
 */

const PLANNING_INDEX = join(REPO_ROOT, ".planning", "ROADMAP.md");
const planned = existsSync(PLANNING_INDEX);
const phasesDir = join(REPO_ROOT, ".planning", "phases");
const phaseName = existsSync(phasesDir)
  ? readdirSync(phasesDir).find((entry) => entry.startsWith("07-"))
  : undefined;
const dir = phaseName === undefined ? "" : join(phasesDir, phaseName);
const read = (name: string): string =>
  planned && existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "";
const evidence = read("07-THREAT-EVIDENCE.md");

const run = planned ? describe : describe.skip;

describe("guard (Test 1)", () => {
  it("finds the documents whenever the planning index exists", () => {
    if (!planned) {
      expect(existsSync(PLANNING_INDEX)).toBe(false);
      return;
    }
    expect(phaseName, "the phase directory").toBeDefined();
    for (const name of ["07-THREAT-EVIDENCE.md", "07-UAT.md"]) {
      expect(existsSync(join(dir, name)), name).toBe(true);
    }
  });
});

function planFiles(): string[] {
  return readdirSync(dir).filter((name) => /^07-\d\d-PLAN\.md$/.test(name));
}

function planThreatIds(): Set<string> {
  const ids = new Set<string>();
  for (const file of planFiles()) {
    for (const match of readFileSync(join(dir, file), "utf8").matchAll(
      /^\| (T-07-[A-Z0-9]+) \|/gm,
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
  readonly cites: { file: string; quote: string }[];
}

function rows(): Row[] {
  const out: Row[] = [];
  for (const line of evidence.split("\n")) {
    const cells = line.split(/(?<!\\)\|/).map((cell) => cell.trim());
    if (!/^T-07-[A-Z0-9]+$/.test(cells[1] ?? "")) continue;
    const cell = cells[5] ?? "";
    out.push({
      id: cells[1] as string,
      disposition: cells[3] ?? "",
      kind: cells[4] ?? "",
      cell,
      cites: [...cell.matchAll(/`([^`]+)`\s+"([^"]+)"/g)].map((m) => ({
        file: m[1] as string,
        quote: m[2] as string,
      })),
    });
  }
  return out;
}

/** The text between a level-2 heading and the next level-2 heading. */
function section(source: string, heading: string): string {
  const match = new RegExp(`^## ${heading}$`, "m").exec(source);
  if (match === null) return "";
  const rest = source.slice(match.index + match[0].length);
  return rest.split(/^## /m)[0] as string;
}

run("completeness and shape (Tests 1 and 2 of Task 2)", () => {
  it("has a row for exactly the declared threat ids, including the supply-chain and provenance ids", () => {
    const declared = planThreatIds();
    expect(declared.has("T-07-SC")).toBe(true);
    expect(declared.has("T-07-F6")).toBe(true);
    expect(declared.size).toBeGreaterThan(40);
    expect(new Set(rows().map((row) => row.id))).toEqual(declared);
    expect(rows().length).toBe(declared.size);
  });

  it("gives every row a disposition, an evidence kind, a file and a quoted title, and leaves none open", () => {
    expect(rows().length).toBeGreaterThan(40);
    for (const row of rows()) {
      expect(["mitigate", "accept", "transfer"], row.id).toContain(row.disposition);
      expect(["test", "gate", "lint", "document", "source scan", "measurement"], row.id).toContain(
        row.kind,
      );
      expect(row.cites.length, row.id).toBeGreaterThan(0);
      expect(row.cell, row.id).not.toMatch(/\b(TBD|TODO|unresolved|not built|untested)\b/i);
    }
  });
});

run("evidence is real (Tests 3 and 4)", () => {
  it("cites files that exist and contain the quoted text", () => {
    let checked = 0;
    for (const row of rows()) {
      for (const cite of row.cites) {
        const path = join(REPO_ROOT, cite.file);
        expect(existsSync(path), `${row.id} ${cite.file}`).toBe(true);
        expect(readFileSync(path, "utf8"), `${row.id} ${cite.file}`).toContain(cite.quote);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("makes document rows cite docs, the coverage record or a planning record", () => {
    expect(rows().filter((r) => r.kind === "document").length).toBeGreaterThan(0);
    for (const row of rows().filter((r) => r.kind === "document")) {
      expect(
        row.cites.some(
          (c) =>
            /^(docs\/|\.planning\/)/.test(c.file) ||
            c.file.endsWith("package.json") ||
            c.file.endsWith("COVERAGE.md"),
        ),
        row.id,
      ).toBe(true);
    }
  });

  it("cites a test file or a gate script for every mitigated row that is not a document row", () => {
    expect(rows().filter((r) => r.disposition === "mitigate").length).toBeGreaterThan(40);
    for (const row of rows().filter((r) => r.disposition === "mitigate" && r.kind !== "document")) {
      expect(
        row.cites.some(
          (c) =>
            /\.test\.tsx?$/.test(c.file) ||
            /^scripts\//.test(c.file) ||
            /\.audit\.test\./.test(c.file),
        ),
        row.id,
      ).toBe(true);
    }
  });

  it("covers the provenance model of 07-FIX6 and 07-FIX6b: the store is the trust root", () => {
    const row = rows().find((r) => r.id === "T-07-F6");
    const files = row?.cites.map((c) => c.file) ?? [];
    expect(files).toContain("docs/adr/0030-research-provenance-store-trust-root.md");
    expect(files).toContain("packages/service/src/research/view-model-store-trust.test.ts");
    expect(files).toContain("packages/service/src/research/view-model-report-binding.test.ts");
    expect(files).toContain("packages/test-fixtures/src/research-routes-hostile.int.test.ts");
    expect(files).toContain("packages/operational-store/src/research-source-store.test.ts");
    expect(files).toContain("packages/operational-store/src/research-report-store.test.ts");
    expect(row?.cell).toMatch(/vault-confined/);
  });
});

run("summariser call path (SC4, Test 4)", () => {
  const trace = section(evidence, "Summariser call path");

  interface Step {
    readonly step: number;
    readonly file: string;
    readonly symbol: string;
    readonly proofs: { file: string; quote: string }[];
  }

  function steps(): Step[] {
    const out: Step[] = [];
    for (const line of trace.split("\n")) {
      const cells = line.split(/(?<!\\)\|/).map((cell) => cell.trim());
      if (!/^\d+$/.test(cells[1] ?? "")) continue;
      out.push({
        step: Number(cells[1]),
        file: (/`([^`]+)`/.exec(cells[2] ?? "")?.[1] ?? "") as string,
        symbol: (/`([^`]+)`/.exec(cells[3] ?? "")?.[1] ?? "") as string,
        proofs: [...(cells[5] ?? "").matchAll(/`([^`]+)`\s+"([^"]+)"/g)].map((m) => ({
          file: m[1] as string,
          quote: m[2] as string,
        })),
      });
    }
    return out;
  }

  it("lists the call, in order, from the composition root to the response parser", () => {
    const order = [
      "main.ts",
      "createResearchServices",
      "pipeline",
      "summarizeUntrusted",
      "TextTransport",
      "AnthropicRequestSchema",
      "parseAnthropicResponse",
    ];
    let from = 0;
    for (const marker of order) {
      const at = trace.indexOf(marker, from);
      expect(at, marker).toBeGreaterThanOrEqual(0);
      from = at;
    }
    const found = steps();
    expect(found.map((s) => s.step)).toEqual(found.map((_, i) => i + 1));
    expect(found.length).toBeGreaterThanOrEqual(7);
  });

  it("names a real file and a real symbol in it for every step, and proves each with a real test", () => {
    expect(steps().length).toBeGreaterThanOrEqual(7);
    for (const step of steps()) {
      const path = join(REPO_ROOT, step.file);
      expect(existsSync(path), `step ${step.step} ${step.file}`).toBe(true);
      expect(readFileSync(path, "utf8"), `step ${step.step} ${step.symbol}`).toContain(step.symbol);
      expect(step.proofs.length, `step ${step.step}`).toBeGreaterThan(0);
      for (const proof of step.proofs) {
        const proofPath = join(REPO_ROOT, proof.file);
        expect(existsSync(proofPath), `step ${step.step} ${proof.file}`).toBe(true);
        expect(readFileSync(proofPath, "utf8"), `step ${step.step} ${proof.file}`).toContain(
          proof.quote,
        );
      }
    }
  });

  it("states the three enforcement layers of plan 07-02 by name and the two conclusions", () => {
    for (const layer of ["eslint boundary element", "compiler layer", "backstop rule 17"]) {
      expect(trace, layer).toContain(layer);
    }
    expect(trace).toMatch(/cannot invoke a tool/);
    expect(trace).toMatch(/cannot write a file/);
    expect(trace).toContain('"types": []');
  });

  it("reflects the provenance model: the operational store, not the vault, vouches for a quote", () => {
    expect(trace).toContain("ADR 0030");
    expect(trace).toMatch(/operational store/);
    expect(trace).toContain("research_source_records");
    expect(trace).toContain("research_report_records");
  });
});

run("security scan inputs (Test 5)", () => {
  const scan = section(evidence, "Security scan inputs");

  it("names each trust boundary, each attack attempt and the accepted risks", () => {
    for (const word of [
      "Outbound fetcher",
      "Sanitiser and feed parser",
      "Delimiter",
      "Untrusted port",
      "Transport",
      "Trusted validation",
      "Vault writers",
      "Provenance store",
      "Routes and guard",
      "Keychain read",
      "SSRF",
      "Forged delimiter",
      "Prompt injection",
      "Image beacon",
      "tool_use",
      "Hostile frontmatter",
      "Traversal",
      "Oversized",
      "Test override in the installed service",
      "Forged report and raw note",
      "Edited report",
      "Accepted risks",
      "stylesheet-hidden",
      "existing vault",
      "assumption A1",
    ]) {
      expect(scan, word).toContain(word);
    }
  });

  it("gives the SSRF attempts as a table of hosts and redirects", () => {
    const table = scan.split("\n").filter((line) => /^\| `/.test(line));
    expect(table.length).toBeGreaterThan(10);
    for (const host of [
      "127.0.0.1",
      "169.254.169.254",
      "[::1]",
      "2130706433",
      "[::ffff:7f00:1]",
      "redirect",
      "rebinding",
    ]) {
      expect(scan, host).toContain(host);
    }
  });

  it("lists only paths that exist", () => {
    const paths = [...scan.matchAll(/`((?:packages|docs|scripts)\/[^`\s]+)`/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(20);
    for (const path of paths) expect(existsSync(join(REPO_ROOT, path as string)), path).toBe(true);
  });
});
