import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./gate-repo.js";

/**
 * Plan 06-28 Task 3 (T-06-36): keeps the threat-evidence record and the merge-gate runbook
 * true to the repository. Private planning artifacts: a public clone has no `.planning/`.
 */

const PLANNING_INDEX = join(REPO_ROOT, ".planning", "ROADMAP.md");
const planned = existsSync(PLANNING_INDEX);
const phasesDir = join(REPO_ROOT, ".planning", "phases");
const phaseName = existsSync(phasesDir)
  ? readdirSync(phasesDir).find((entry) => entry.startsWith("06-"))
  : undefined;
const dir = phaseName === undefined ? "" : join(phasesDir, phaseName);
const read = (name: string): string =>
  planned && existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "";
const evidence = read("06-THREAT-EVIDENCE.md");
const gates = read("06-MERGE-GATES.md");

const run = planned ? describe : describe.skip;

describe("guard (Test 1)", () => {
  it("finds the documents whenever the planning index exists", () => {
    if (!planned) {
      expect(existsSync(PLANNING_INDEX)).toBe(false);
      return;
    }
    expect(phaseName, "the phase directory").toBeDefined();
    for (const name of ["06-THREAT-EVIDENCE.md", "06-MERGE-GATES.md", "06-UAT.md"]) {
      expect(existsSync(join(dir, name)), name).toBe(true);
    }
  });
});

function planThreatIds(): Set<string> {
  const ids = new Set<string>();
  for (const file of readdirSync(dir).filter((name) => /^06-\d\d-PLAN\.md$/.test(name))) {
    for (const match of readFileSync(join(dir, file), "utf8").matchAll(
      /^\| (T-06-[A-Z0-9]+) \|/gm,
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
    if (!/^T-06-[A-Z0-9]+$/.test(cells[1] ?? "")) continue;
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

run("completeness and shape (Tests 2 and 3)", () => {
  it("has a row for exactly the declared threat ids, including the supply-chain id", () => {
    const declared = planThreatIds();
    expect(declared.has("T-06-SC")).toBe(true);
    expect(new Set(rows().map((row) => row.id))).toEqual(declared);
    expect(rows().length).toBe(declared.size);
  });

  it("gives every row a disposition, a kind, a file and a quoted title", () => {
    for (const row of rows()) {
      expect(["mitigate", "accept", "transfer"], row.id).toContain(row.disposition);
      expect(["test", "gate", "lint", "document", "source scan", "measurement"], row.id).toContain(
        row.kind,
      );
      expect(row.cites.length, row.id).toBeGreaterThan(0);
      expect(row.cell, row.id).not.toMatch(/\b(TBD|TODO|pending)\b/i);
    }
  });
});

run("evidence is real (Tests 4 and 5)", () => {
  it("cites files that exist and contain the quoted text", () => {
    for (const row of rows()) {
      for (const cite of row.cites) {
        const path = join(REPO_ROOT, cite.file);
        expect(existsSync(path), `${row.id} ${cite.file}`).toBe(true);
        expect(readFileSync(path, "utf8"), `${row.id} ${cite.file}`).toContain(cite.quote);
      }
    }
  });

  it("makes document rows cite docs, the deferred-items record or a planning record", () => {
    for (const row of rows().filter((r) => r.kind === "document")) {
      expect(
        row.cites.some(
          (c) => /^(docs\/|\.planning\/)/.test(c.file) || c.file.endsWith("package.json"),
        ),
        row.id,
      ).toBe(true);
    }
  });

  it("states the acceptance for the accepted risks, the same-user row by heading", () => {
    const byId = new Map(rows().map((row) => [row.id, row]));
    for (const id of ["T-06-12", "T-06-17", "T-06-33", "T-06-SC"]) {
      expect(byId.get(id)?.disposition, id).toBe("accept");
    }
    const sameUser = byId.get("T-06-12");
    const files = sameUser?.cites.map((c) => c.file) ?? [];
    expect(files.some((f) => f.startsWith("docs/adr/") && /0026/.test(f))).toBe(true);
    expect(files.some((f) => /0016/.test(f))).toBe(true);
    expect(files).toContain(".planning/deferred-items.md");
    expect(sameUser?.cell).toContain("## Residual risk: same-user self-approval");
  });
});

run("security scan inputs (Test 6)", () => {
  const section = evidence.split(/^## Security scan inputs$/m)[1] ?? "";

  it("names the boundaries, the attacks and the accepted risks", () => {
    for (const word of [
      "Socket and token",
      "Decide path",
      "Minter and executors",
      "Protocol handler",
      "Mirror writer",
      "Task routes",
      "Parser and serializer",
      "Migrations",
      "Forge a capability token",
      "Replay",
      "Tamper with the audit table",
      "protocol URL",
      "Hostile requester text",
      "Hostile frontmatter",
      "Traversal",
      "Oversize",
      "Accepted risks",
      "T-06-12",
    ]) {
      expect(section, word).toContain(word);
    }
  });

  it("lists only paths that exist", () => {
    const paths = [...section.matchAll(/`((?:packages|docs|scripts)\/[^`]+)`/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(10);
    for (const path of paths) expect(existsSync(join(REPO_ROOT, path as string)), path).toBe(true);
  });
});

run("runbook (Tests 7 and 8)", () => {
  it("names only commands and scripts that exist", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    for (const match of gates.matchAll(/pnpm run ([a-z][a-z0-9:-]*)/g)) {
      expect(pkg.scripts[match[1] as string], match[0]).toBeDefined();
    }
    for (const match of gates.matchAll(/\b(?:sh|node) (scripts\/[A-Za-z0-9_./-]+)/g)) {
      expect(existsSync(join(REPO_ROOT, match[1] as string)), match[0]).toBe(true);
    }
  });

  it("orders the sections as the plan requires", () => {
    const order = [
      "Post-wave gates",
      "Full test run",
      "Migration-position re-check",
      "Visual comparison in the container",
      "Judge panel",
      "Codex blocking judge",
      "Merge and publish",
      "Closing checklist",
    ];
    const positions = order.map((title) =>
      gates.indexOf(`## ${order.indexOf(title) + 1}. ${title}`),
    );
    for (const [index, position] of positions.entries())
      expect(position, order[index]).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("states the policies and lists the high-risk plans from their front matter", () => {
    expect(gates).toMatch(/blind dual review and debate/);
    expect(gates).toMatch(/three rounds/);
    expect(gates).toMatch(/80 percent of the weekly allowance/);
    expect(gates).toMatch(/never used to execute plans marked high risk/i);
    expect(gates).toMatch(/full unfiltered run is the post-merge gate/);
    expect(gates).toMatch(/live script[^.]*must be complete before phase closure/);
    expect(gates).toMatch(
      /generated on top of the merged journal and never at a number written in advance/,
    );
    expect(gates).toMatch(/service and Claude settings are restored/);
    const high = readdirSync(dir)
      .filter((name) => /^06-\d\d-PLAN\.md$/.test(name))
      .filter((name) => /^risk: high$/m.test(readFileSync(join(dir, name), "utf8")))
      .map((name) => name.slice(0, 5));
    expect(high.length).toBeGreaterThan(0);
    for (const plan of high) expect(gates, plan).toContain(plan);
  });
});
