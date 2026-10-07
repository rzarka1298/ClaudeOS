// Doc gates for the Phase 6 decision records (plan 06-27, ADR-08, TASK-06,
// T-06-12, T-06-27, T-06-36). The records quote tables and constants that the
// code owns; these tests parse the marked tables and compare them with the
// code, so a record cannot drift from what it describes. Records are found by
// front matter and title, never by number (06-RECONCILE.md M-3).

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPROVAL_AUDIT_EVENTS,
  CLASSIFICATION,
  PROPOSAL_STATES,
  PROPOSAL_TRANSITIONS,
  TASK_FILTER_SORTS,
  TASK_FILTERS,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from "@ccc/domain";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ADR_DIR = join(REPO_ROOT, "docs", "adr");

// ---------------------------------------------------------------------------
// Helpers

interface Adr {
  readonly file: string;
  readonly text: string;
  readonly frontMatter: Readonly<Record<string, string>>;
  readonly body: string;
  readonly title: string;
}

function parseAdr(file: string): Adr {
  const text = readFileSync(join(ADR_DIR, file), "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  const frontMatter: Record<string, string> = {};
  for (const line of (match?.[1] ?? "").split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) frontMatter[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  const body = match?.[2] ?? text;
  const title = /^# (.+)$/m.exec(body)?.[1] ?? "";
  return { file, text, frontMatter, body, title };
}

function allAdrs(): Adr[] {
  return readdirSync(ADR_DIR)
    .filter((name) => /^\d{4}-.+\.md$/.test(name))
    .sort()
    .map(parseAdr);
}

/** Collapse whitespace so a phrase may wrap across lines in the source. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

function adrWhere(predicate: (adr: Adr) => boolean, what: string): Adr {
  const found = allAdrs().filter(predicate);
  if (found.length !== 1) {
    throw new Error(`expected exactly one ADR that ${what}, found ${found.length}`);
  }
  return found[0] as Adr;
}

/** The ADR that satisfies ADR-08 and says it completes another record. */
function approvalAdr(): Adr {
  return adrWhere(
    (adr) =>
      (adr.frontMatter.satisfies ?? "").startsWith("ADR-08") &&
      (adr.frontMatter.satisfies ?? "").includes("completes"),
    "satisfies ADR-08 and completes another record",
  );
}

/** The ADR that records the canonical task store: it amends the index-generation record. */
function tasksAdr(): Adr {
  return adrWhere(
    (adr) => Object.hasOwn(adr.frontMatter, "amends") && /task/i.test(adr.title),
    "amends another record and is about tasks",
  );
}

function adrByTitle(fragment: string): Adr {
  return adrWhere((adr) => adr.title.includes(fragment), `has a title containing "${fragment}"`);
}

/** The rows of the markdown table between `<!-- name:begin -->` and `<!-- name:end -->`, header and rule removed. */
function markedTable(adr: Adr, name: string): string[][] {
  const begin = `<!-- ${name}:begin -->`;
  const end = `<!-- ${name}:end -->`;
  const from = adr.text.indexOf(begin);
  const to = adr.text.indexOf(end);
  if (from < 0 || to < from) throw new Error(`no marked table "${name}" in ${adr.file}`);
  const lines = adr.text
    .slice(from + begin.length, to)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"));
  return lines.slice(2).map((line) =>
    line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim().replace(/`/g, "")),
  );
}

function section(adr: Adr, heading: string): string {
  const start = adr.text.indexOf(`\n${heading}`);
  if (start < 0) throw new Error(`no section "${heading}" in ${adr.file}`);
  const rest = adr.text.slice(start + 1 + heading.length);
  const next = rest.search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next);
}

const UNIT_MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 } as const;

function durationMs(text: string): number {
  const match = /^(\d+) (minute|hour|day)s?$/.exec(text);
  if (match === null) throw new Error(`not a duration: "${text}"`);
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

const HOME_PATH = /\/Users\/(?!USERNAME\b)[A-Za-z0-9._-]+/;

// ---------------------------------------------------------------------------
// Task 1: the completing approval ADR

describe("Task 1 Test 1: ADR-08 is satisfied by the original record and completed by the new one", () => {
  it("at least two ADR files satisfy ADR-08", () => {
    const satisfying = allAdrs().filter((adr) =>
      (adr.frontMatter.satisfies ?? "").startsWith("ADR-08"),
    );
    expect(satisfying.length).toBeGreaterThanOrEqual(2);
  });

  it("the new record says completes and names the record it completes by title", () => {
    const completing = approvalAdr();
    expect(completing.frontMatter.status).toBe("accepted");
    expect(completing.frontMatter.satisfies).toContain("completes");
    const original = adrWhere(
      (adr) =>
        adr.file !== completing.file &&
        (adr.frontMatter.satisfies ?? "").startsWith("ADR-08") &&
        !(adr.frontMatter.satisfies ?? "").includes("completes"),
      "is the original ADR-08 record",
    );
    expect(original.title.length).toBeGreaterThan(10);
    expect(flat(completing.body)).toContain(original.title);
    expect(flat(completing.body)).toMatch(/completes? .{0,40}(capability|half)/i);
  });
});

describe("Task 1 Test 2: the classification table matches the domain table", () => {
  it("lists every operation in the domain table and nothing else, with matching values", () => {
    const rows = markedTable(approvalAdr(), "classification");
    const byOperation = new Map(rows.map((row) => [row[0] as string, row]));
    expect(byOperation.size).toBe(rows.length);
    expect([...byOperation.keys()].sort()).toEqual(Object.keys(CLASSIFICATION).sort());
    for (const [operation, row] of Object.entries(CLASSIFICATION)) {
      const cells = byOperation.get(operation) as string[];
      expect(cells[1], `${operation} class`).toBe(row.class);
      if (row.class === "approval-required") {
        expect(cells[2], `${operation} status`).toBe(row.status);
        expect(durationMs(cells[3] as string), `${operation} lifetime`).toBe(row.ttlMs);
        expect(durationMs(cells[4] as string), `${operation} maximum approval age`).toBe(
          row.maxApprovalAgeMs,
        );
        expect(cells[5], `${operation} retry`).toBe(row.retry);
      } else {
        for (const index of [2, 3, 4, 5]) {
          expect(cells[index], `${operation} column ${index}`).toBe("-");
        }
      }
    }
  });

  it("lists the ten request states with their legal next states, matching the transition table", () => {
    const rows = markedTable(approvalAdr(), "states");
    expect(rows.map((row) => row[0])).toEqual([...PROPOSAL_STATES]);
    for (const state of PROPOSAL_STATES) {
      const row = rows.find((cells) => cells[0] === state) as string[];
      const next = row[1] === "-" ? [] : (row[1] as string).split(",").map((s) => s.trim());
      expect(next, `${state} next states`).toEqual([...PROPOSAL_TRANSITIONS[state]]);
    }
    expect(PROPOSAL_STATES).toContain("lapsed");
  });
});

describe("Task 1 Test 3: the required content is present", () => {
  const checks: ReadonlyArray<readonly [string, RegExp]> = [
    ["classification: enabled rows", /enabled/i],
    [
      "classification: reserved rows fail closed",
      /reserved[^.]*fail closed|fail closed[^.]*reserved/i,
    ],
    ["three enforcement layers", /three enforcement layers/i],
    ["layer: import-boundary lint", /import-boundary lint/i],
    ["layer: compiler project references", /project references/i],
    ["layer: grep backstop", /backstop/i],
    ["sub-folder compiler layer with its code", /sub-folder[^.]*TS6307/i],
    ["expiration is an automatic denial", /expiration is an automatic denial/i],
    ["lifetime default 24 hours", /24 hours/i],
    ["lifetime force-terminate 15 minutes", /15 minutes/i],
    ["lifetime ceiling seven days", /seven days/i],
    ["maximum approval age 5 minutes", /5 minutes/i],
    ["expiry sweep", /sweep/i],
    ["in-transaction re-check", /re-checked[^.]*decision transaction/i],
    ["ten states", /ten states/i],
    ["append-only audit", /append-only/i],
    [
      "decision channel on every audit row",
      /decision channel[^.]*every audit row|every audit row[^.]*decision channel/i,
    ],
    ["reconcile before retry", /reconcile[^.]*before[^.]*retr/i],
    ["late-refusal rule", /late-refusal rule/i],
    ["unknown is terminal", /unknown[^.]*terminal/i],
    ["payload hash binding", /payload hash/i],
    ["hash recomputed from the stored payload", /recomputed from the stored payload/i],
    ["notification content is generic", /generic/i],
    ["notification is plugin-originated only", /plugin-originated/i],
    [
      "no closed-Obsidian notification in milestone 1",
      /no notification[^.]*while obsidian is closed/i,
    ],
    ["mirror notes are templated by the engine", /templated by the engine/i],
    ["mirror cost measured", /8\.4 ms per write/i],
    ["mirror retention without deletion", /no deletion path/i],
    ["payload purge after thirty days", /thirty days/i],
    ["audit rows kept", /audit rows are (never deleted|kept)/i],
    ["measured snapshot size", /50,119 bytes/],
    ["measured ASCII snapshot size", /56,698 bytes/],
    ["measured largest detail view", /39,671 bytes/],
    ["a Phase 7 operation is a definition and one table row", /definition and one row/i],
  ];
  for (const [label, pattern] of checks) {
    it(label, () => {
      expect(flat(approvalAdr().body)).toMatch(pattern);
    });
  }

  it("names every trigger it relies on, and each exists in the approvals migration", () => {
    const adr = approvalAdr();
    const migrationDir = join(REPO_ROOT, "packages", "operational-store", "migrations");
    const sql = readdirSync(migrationDir)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => readFileSync(join(migrationDir, name), "utf8"))
      .join("\n");
    const named = [...adr.body.matchAll(/`((?:approval_audit|proposals)_[a-z_]+)`/g)].map(
      (match) => match[1] as string,
    );
    const triggers = [...new Set(named)].filter((name) =>
      sql.includes(`TRIGGER IF NOT EXISTS \`${name}\``),
    );
    expect(triggers.sort()).toEqual(
      [
        "approval_audit_no_delete",
        "approval_audit_no_replace",
        "approval_audit_no_update",
        "proposals_identity_immutable",
        "proposals_no_delete",
        "proposals_no_replace",
        "proposals_payload_purge_only",
        "proposals_transition_guard",
      ].sort(),
    );
  });

  it("names every audit event in the fixed vocabulary", () => {
    const body = approvalAdr().body;
    for (const event of APPROVAL_AUDIT_EVENTS) {
      expect(body, `audit event ${event}`).toContain(`\`${event}\``);
    }
  });

  it("records the findings that shaped the decision", () => {
    const text = flat(section(approvalAdr(), "## Findings that shaped this decision"));
    for (const finding of [
      /REPLACE/,
      /rebuild[^.]*drop[^.]*triggers|drop[^.]*triggers[^.]*rebuild/i,
      /response budget/i,
      /late-refusal rule/i,
      /two migrations/i,
    ]) {
      expect(text).toMatch(finding);
    }
  });
});

describe("Task 1 Test 4: the same-user residual risk is recorded in plain words", () => {
  const risk = (): string =>
    flat(section(approvalAdr(), "## Residual risk: same-user self-approval"));

  it("states the risk", () => {
    expect(risk()).toMatch(/prompt-injected[^.]*same user[^.]*decide/i);
  });

  it("states that it is accepted for milestone 1 and why", () => {
    expect(risk()).toMatch(/accepted for milestone 1/i);
    expect(risk()).toMatch(/only real operation is force-terminate/i);
  });

  it("states that the decision channel is an accident detector and not a trust signal", () => {
    expect(risk()).toMatch(/every audit row/i);
    expect(risk()).toMatch(/not a trust signal/i);
    expect(risk()).toMatch(/accident detector/i);
    expect(risk()).toMatch(/8\.4 ms|self-declared/i);
  });

  it("documents the optional deny rule as owner-applied and not enforced", () => {
    expect(risk()).toMatch(/deny rule/i);
    expect(risk()).toMatch(/owner-applied/i);
    expect(risk()).toMatch(/not enforced by the product/i);
  });

  it("requires a hardening decision before the Gmail and Calendar connectors", () => {
    const gate = flat(section(approvalAdr(), "## Milestone 2 gate"));
    expect(gate).toMatch(
      /hardening decision[^.]*required[^.]*before[^.]*Gmail and Calendar connectors/i,
    );
    expect(gate).toMatch(/native presence check|peer-process identification/i);
  });

  it("links to the owner's decision date and answer", () => {
    expect(risk()).toContain("2026-10-04");
    expect(risk()).toContain("Accept for now");
  });
});

describe("Task 1 Test 5: the deny-rule snippet matches the project's deny syntax and holds no real path", () => {
  it("is a fenced settings snippet whose entries have the shape of the existing deny entries", () => {
    const text = approvalAdr().text;
    const fence = /```json\n([\s\S]*?)\n```/.exec(text);
    expect(fence).not.toBeNull();
    const snippet = JSON.parse(fence?.[1] as string) as { permissions: { deny: string[] } };
    const entries = snippet.permissions.deny;
    expect(entries.length).toBeGreaterThan(0);

    const settings = JSON.parse(
      readFileSync(join(REPO_ROOT, ".claude", "settings.json"), "utf8"),
    ) as { permissions: { deny: string[] } };
    const existingShape = /^Bash\([^)]+:\*\)$/;
    expect(settings.permissions.deny.some((entry) => existingShape.test(entry))).toBe(true);
    for (const entry of entries) expect(entry).toMatch(/^(Bash|Read|Edit)\(.+\)$/);
    expect(entries.some((entry) => existingShape.test(entry))).toBe(true);
    expect(entries.some((entry) => entry.includes("/Users/USERNAME/.claude-command-center/"))).toBe(
      true,
    );
  });

  it("contains no real home directory", () => {
    expect(approvalAdr().text).not.toMatch(HOME_PATH);
  });
});

describe("Task 1 Test 6: the rejected options are recorded with reasons", () => {
  const options = (): string => flat(section(approvalAdr(), "## Considered Options"));

  for (const [label, pattern] of [
    ["visual-only expiry", /visual-only expiry\.\*\* Rejected/i],
    ["vault note as the authority", /vault note as the authority\.\*\* Rejected/i],
    [
      "a generic client-submitted proposal route",
      /generic client-submitted proposal route\.\*\* Rejected/i,
    ],
    ["a persistent allow", /persistent allow\.\*\* Rejected/i],
    ["building a native presence check now", /native presence check now\.\*\* Rejected/i],
  ] as const) {
    it(`rejects ${label}`, () => {
      expect(options()).toMatch(pattern);
    });
  }
});

// ---------------------------------------------------------------------------
// Task 2: the canonical task store ADR and the ADR 0022 amendment

describe("Task 2 Test 1: the tasks record's front matter", () => {
  it("is accepted, satisfies the task requirements and amends the index-generation record", () => {
    const adr = tasksAdr();
    expect(adr.frontMatter.status).toBe("accepted");
    expect(adr.frontMatter.satisfies).toMatch(/TASK-0\d/);
    expect(adr.frontMatter.amends).toBeTruthy();
    const indexAdr = adrByTitle("Indexes are recomputed wholesale");
    expect(flat(adr.body)).toContain(indexAdr.title);
  });
});

describe("Task 2 Test 2: the status and priority tables match the domain", () => {
  it("lists exactly the seven statuses in order", () => {
    const rows = markedTable(tasksAdr(), "statuses");
    expect(rows.map((row) => row[0])).toEqual([...TASK_STATUSES]);
  });

  it("lists exactly the four priorities in order", () => {
    const rows = markedTable(tasksAdr(), "priorities");
    expect(rows.map((row) => row[0])).toEqual([...TASK_PRIORITIES]);
  });

  it("says every task is stage capture", () => {
    expect(flat(tasksAdr().body)).toMatch(/every task (note )?is stage `?capture`?/i);
  });
});

describe("Task 2 Test 3: the filter predicate table matches the domain", () => {
  it("lists exactly the eight views of the domain filter list in order", () => {
    const rows = markedTable(tasksAdr(), "filters");
    expect(rows.map((row) => row[0])).toEqual([...TASK_FILTERS]);
    for (const row of rows) {
      expect(row.length).toBe(4);
      for (const cell of row) expect(cell.length).toBeGreaterThan(0);
    }
  });

  it("states each view's sort fields as the domain declares them", () => {
    const rows = markedTable(tasksAdr(), "filters");
    for (const filter of TASK_FILTERS) {
      const row = rows.find((cells) => cells[0] === filter) as string[];
      const fields = TASK_FILTER_SORTS[filter].map((key) => key.field);
      for (const field of fields) {
        expect(row[3], `${filter} sort`).toContain(field);
      }
    }
  });

  it("states the open rule and the daylight-saving handling", () => {
    const text = flat(tasksAdr().body);
    expect(text).toMatch(/23-hour/);
    expect(text).toMatch(/25-hour/);
    expect(text).toMatch(/skips midnight/i);
    expect(text).toMatch(/upcoming has no upper bound/i);
    expect(text).toMatch(/cancelled appears only under all/i);
    expect(text).toMatch(/dangling dependency[^.]*unmet|unmet[^.]*dangling dependency/i);
  });
});

describe("Task 2 Test 4: the required content is present", () => {
  const checks: ReadonlyArray<readonly [string, RegExp]> = [
    [
      "key order with the provenance prefix",
      /provenance keys[^.]*prefix|prefix[^.]*provenance keys/i,
    ],
    ["top-level decision key", /top-level `decision` key/i],
    ["decision two-key order", /`outcome`[^.]*`at`/],
    ["date-only versus instant columns", /date-only[^.]*instant/i],
    ["single-line title rule", /single line/i],
    ["tag rules", /tag/i],
    ["filename rule", /file name is fixed at creation/i],
    ["id suffix", /id suffix|last eight characters/i],
    ["size limits", /64 KiB[^.]*256 KiB/i],
    ["narrow YAML schema", /core schema/i],
    ["default schema is wrong for dates", /default schema[^.]*date/i],
    ["service creates", /the service creates/i],
    ["plugin edits conflict-safely", /conflict-safe/i],
    ["changed route never writes", /changed route never writes/i],
    ["only updateTaskNote edits", /updateTaskNote/],
    [
      "duplicate and missing ids are surfaced, never resolved",
      /never resolved|never auto-resolved/i,
    ],
    ["Done sets completed when empty", /done sets `completed` when (it is )?empty/i],
    ["leaving Done clears completed", /leaving done clears/i],
    ["Reopen sets ready", /reopen sets `ready`/i],
    ["proposed-task flow, accept", /accept[^.]*`ready`/i],
    ["proposed-task flow, dismiss", /dismiss[^.]*`cancelled`/i],
    ["structural containment of completion", /structurally contained/i],
    ["whole-file content hash", /whole file/i],
    ["TASK-08", /TASK-08/],
  ];
  for (const [label, pattern] of checks) {
    it(label, () => {
      expect(flat(tasksAdr().body)).toMatch(pattern);
    });
  }
});

describe("Task 2 Test 5: the index-generation record carries the summary-index amendment", () => {
  const adr = (): Adr => adrByTitle("Indexes are recomputed wholesale");

  it("has an amendment section stating the summary index and its measurements", () => {
    const amendment = flat(section(adr(), "## Amendment: the tasks folder summary index"));
    expect(amendment).toMatch(/constant size/i);
    expect(amendment).toMatch(/only by setup, repair and rebuild/i);
    expect(amendment).toMatch(/as of the last rebuild/i);
    expect(amendment).toMatch(/212 ms/);
    expect(amendment).toMatch(/1\.13 MB/);
    expect(amendment).toMatch(/task writes never touch the index/i);
  });

  it("leaves the original text unchanged (additions only against the Phase 6 base)", () => {
    const text = adr().text;
    const at = text.indexOf("\n## Amendment: the tasks folder summary index");
    expect(at).toBeGreaterThan(0);
    // The original text is everything before the amendment; it must still end with the Consequences list.
    expect(text.slice(0, at)).toContain("The cache can be deleted at any time.");
    expect(text.slice(0, at)).toMatch(/\n## Consequences\n/);
  });
});

describe("Task 2 Test 6: the rejected options are recorded with reasons", () => {
  const options = (): string => flat(section(tasksAdr(), "## Considered Options"));

  for (const [label, pattern] of [
    ["tasks in the inbox folder", /tasks in the inbox folder\.\*\* Rejected/i],
    ["one file for all tasks", /one file for all tasks\.\*\* Rejected/i],
    ["per-note rows in the tasks index", /per-note rows in the tasks index\.\*\* Rejected/i],
    [
      "parsing with the default YAML schema",
      /parsing with the default yaml schema\.\*\* Rejected/i,
    ],
    ["a service write for edits", /a service write for edits\.\*\* Rejected/i],
    [
      "auto-minting a new id for a copied note",
      /auto-minting a new id for a copied note\.\*\* Rejected/i,
    ],
  ] as const) {
    it(`rejects ${label}`, () => {
      expect(options()).toMatch(pattern);
    });
  }
});
