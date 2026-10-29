// Doc gates for the Phase 6 decision records (plan 06-27, ADR-08, TASK-06,
// T-06-12, T-06-27, T-06-36). The records quote tables and constants that the
// code owns; these tests parse the marked tables and compare them with the
// code, so a record cannot drift from what it describes. Records are found by
// front matter and title, never by number (06-RECONCILE.md M-3).

import { existsSync, readdirSync, readFileSync } from "node:fs";
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
        expect(cells[6], `${operation} presence`).toBe(row.presence);
      } else {
        for (const index of [2, 3, 4, 5, 6]) {
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
      "decision channel only on approved and denied rows",
      /recorded only on the `approved` and `denied` audit rows/i,
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

// ---------------------------------------------------------------------------
// Task 3: the ADR 0019 addendum, the ADR 0016 note, the glossary, deferred items

const BOUNDARY_ADR_TITLE = "The import boundary is enforced by three independent layers, not one";
const HANDSHAKE_LAST_LINE = "keeping the token format and verification logic small enough";
const BOUNDARY_LAST_LINE = "Revisit this ADR when that happens.";

function glossaryEntry(name: string): string {
  const text = readFileSync(join(REPO_ROOT, "CONTEXT.md"), "utf8");
  const start = text.indexOf(`**${name}**:`);
  if (start < 0) throw new Error(`no glossary entry "${name}"`);
  const rest = text.slice(start + 1);
  const next = rest.search(/\n\*\*[^*]+\*\*:|\n#{2,3} /);
  return flat(next < 0 ? rest : rest.slice(0, next));
}

describe("Task 3 Test 1: the import-boundary record carries the repair addendum", () => {
  const adr = (): Adr => adrByTitle(BOUNDARY_ADR_TITLE);
  const addendum = (): string => {
    const text = adr().text;
    const at = text.indexOf("\n## Addendum: the lint repair in Phase 6");
    if (at < 0) throw new Error("no addendum section in the import-boundary record");
    return flat(text.slice(at));
  };

  it("keeps the original text and only adds after it", () => {
    const text = adr().text;
    const at = text.indexOf("\n## Addendum: the lint repair in Phase 6");
    expect(at).toBeGreaterThan(0);
    expect(text.slice(0, at)).toContain(BOUNDARY_LAST_LINE);
  });

  for (const [label, pattern] of [
    ["defect: descriptor order", /descriptor order[^.]*(enclosing package|classif)/i],
    ["defect: .js suffix imports unresolved", /\.js suffix[^.]*unresolved/i],
    [
      "defect: intra-package edges were never evaluated",
      /intra-package edges? (was|were) never evaluated/i,
    ],
    ["defect: no test exercised an intra-service edge", /no test exercised an intra-service edge/i],
    [
      "untrusted boundary was inert and is now proven",
      /untrusted[^.]*inert[^.]*now proven|inert[^.]*untrusted[^.]*now proven/i,
    ],
    ["local resolver", /local resolver/i],
    ["new elements", /approval-minter/],
    ["root path pinned", /root-path/],
    ["compiler layer for sub-folders", /sub-folders?[^.]*(approval|executors)/i],
    ["relative import out of the folder fails with TS6307", /TS6307/],
    ["an unreferenced package import fails only on a clean build", /fails only on a clean build/i],
    ["new backstop rules are described", /backstop[^.]*rules?/i],
    ["backstop: minter import confinement", /minter[^.]*(import|confin)/i],
    ["backstop: process.kill confinement", /process\.kill/],
    ["backstop: terminate confinement", /\.terminate\(/],
    ["states earlier text is unchanged", /earlier text is unchanged|original text is unchanged/i],
  ] as const) {
    it(label, () => {
      expect(addendum()).toMatch(pattern);
    });
  }
});

describe("Task 3 Test 2: the handshake record points at the residual-risk record", () => {
  const adr = (): Adr => adrByTitle("Handshake mints");

  it("keeps the original text and adds the note after it", () => {
    const text = parseAdr(adrFileContaining(HANDSHAKE_LAST_LINE)).text;
    const at = text.indexOf("\n## Note: the approval engine and the same-user limitation");
    expect(at).toBeGreaterThan(0);
    expect(text.slice(0, at)).toContain(HANDSHAKE_LAST_LINE);
  });

  it("names the completing approval record by title and states the milestone 2 gate", () => {
    const text = flat(
      parseAdr(adrFileContaining(HANDSHAKE_LAST_LINE)).text.split(
        "## Note: the approval engine and the same-user limitation",
      )[1] ?? "",
    );
    expect(text).toContain(approvalAdr().title);
    expect(text).toMatch(/same-user[^.]*(material|limitation)/i);
    expect(text).toMatch(
      /hardening decision[^.]*required[^.]*before[^.]*Gmail and Calendar connectors/i,
    );
    expect(adr().title.length).toBeGreaterThan(0);
  });
});

function adrFileContaining(fragment: string): string {
  const found = allAdrs().filter((adr) => adr.text.includes(fragment));
  if (found.length !== 1) throw new Error(`expected one ADR containing "${fragment}"`);
  return (found[0] as Adr).file;
}

describe("Task 3 Test 3: the glossary follows the interface amendments", () => {
  it("Proposal keeps its definition and takes the new avoid list and the interface-word note", () => {
    const entry = glossaryEntry("Proposal");
    expect(entry).toContain(
      "A consequential action a Connector, Skill, or Automation Run has requested",
    );
    expect(entry).toContain("_Avoid_: approval item, pending action");
    expect(entry).not.toContain("approval request,");
    expect(entry).toMatch(
      /In the UI a Proposal is called a request[^.]*because Proposed is a Task status/,
    );
  });

  it("Approval Inbox notes its Agent runs section", () => {
    expect(glossaryEntry("Approval Inbox")).toMatch(
      /Shown as the Approvals section of the Agent runs destination/,
    );
  });

  it("has a Proposed task entry with its definition and avoid list", () => {
    const entry = glossaryEntry("Proposed task");
    expect(entry).toMatch(/A Task an automation suggested/);
    expect(entry).toMatch(/Not a Proposal and never subject to approval/);
    expect(entry).toContain("_Avoid_: pending task, suggestion");
  });

  it("has a Waiting for approval entry that is not a Proposal", () => {
    const entry = glossaryEntry("Waiting for approval");
    expect(entry).toMatch(
      /Run state in which Claude Code is asking permission in its own terminal/,
    );
    expect(entry).toMatch(/Not a Proposal awaiting decision/);
  });

  it("adds no implementation detail", () => {
    for (const name of ["Proposed task", "Waiting for approval"]) {
      expect(glossaryEntry(name)).not.toMatch(/\.ts\b|SQLite|table|route|socket|packages\//i);
    }
  });
});

describe("Task 3 Test 4: the deferred-items table records the hardening condition", () => {
  const path = join(REPO_ROOT, ".planning", "deferred-items.md");
  it.skipIf(!existsSync(path))("has a row for the same-user self-approval decision", () => {
    const row = flat(
      readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => /self-approval/i.test(line) && line.startsWith("|"))
        .join(" "),
    );
    expect(row).toMatch(/accepted for milestone 1/i);
    expect(row).toMatch(
      /hardening decision[^.|]*required[^.|]*before[^.|]*Gmail and Calendar connectors/i,
    );
    expect(row).toContain(approvalAdr().title);
  });
});

describe("Task 3 Test 5: no edited document holds a real home directory", () => {
  const files = [
    "docs/adr/0016-socket-handshake-token-auth.md",
    "docs/adr/0019-import-boundary-enforcement.md",
    "docs/adr/0022-deterministic-index-generation-and-repair.md",
    "CONTEXT.md",
  ];
  for (const file of files) {
    it(`${file} uses placeholders only`, () => {
      expect(readFileSync(join(REPO_ROOT, file), "utf8")).not.toMatch(HOME_PATH);
    });
  }
  it("both new records use placeholders only", () => {
    expect(approvalAdr().text).not.toMatch(HOME_PATH);
    expect(tasksAdr().text).not.toMatch(HOME_PATH);
  });
});

describe("Task 3 Test 6: ADR cross references resolve", () => {
  it("every ADR number and file mentioned by the Phase 6 records exists", () => {
    const existing = new Set(allAdrs().map((adr) => adr.file.slice(0, 4)));
    const files = new Set(allAdrs().map((adr) => adr.file));
    for (const adr of [
      approvalAdr(),
      tasksAdr(),
      adrByTitle(BOUNDARY_ADR_TITLE),
      adrByTitle("Handshake mints"),
    ]) {
      for (const match of adr.text.matchAll(/ADR[- ](\d{4})\b/g)) {
        expect(existing.has(match[1] as string), `${adr.file} mentions ADR ${match[1]}`).toBe(true);
      }
      for (const match of adr.text.matchAll(/docs\/adr\/([\w.-]+\.md)/g)) {
        expect(files.has(match[1] as string), `${adr.file} mentions ${match[1]}`).toBe(true);
      }
    }
  });

  it("every title quoted by a Phase 6 record names an existing record", () => {
    const titles = allAdrs().map((adr) => adr.title);
    const tasksText = flat(tasksAdr().text);
    const quoted = /titled "([^"]+)"/.exec(tasksText);
    expect(quoted).not.toBeNull();
    expect(titles).toContain((quoted as RegExpExecArray)[1]);
    const amendment = flat(adrByTitle("Indexes are recomputed wholesale").text);
    const back = /titled "([^"]+)"/.exec(amendment);
    expect(titles).toContain((back as RegExpExecArray)[1]);
  });
});

// ---------------------------------------------------------------------------
// Plan 07-05 Task 3 (ADR-09): the record that completes ADR 0013

/** The ADR that satisfies ADR-09 and says it completes another record. */
function jobRunAdr(): Adr {
  return adrWhere(
    (adr) =>
      (adr.frontMatter.satisfies ?? "").startsWith("ADR-09") &&
      (adr.frontMatter.satisfies ?? "").includes("completes"),
    "satisfies ADR-09 and completes another record",
  );
}

describe("07-05 Task 3 Test 1: ADR-09 is satisfied by the scope record and completed by the new one", () => {
  it("exactly one ADR other than the scope record completes ADR-09, and it is accepted", () => {
    const completing = jobRunAdr();
    expect(completing.frontMatter.status).toBe("accepted");
    expect(completing.file.startsWith("0013")).toBe(false);
    expect(completing.file).toMatch(/^\d{4}-job-run-idempotency-and-missed-run-semantics\.md$/);
  });

  it("ADR 0013 still satisfies ADR-09 without saying completes", () => {
    const scope = adrWhere((adr) => adr.file.startsWith("0013-"), "is ADR 0013");
    expect(scope.frontMatter.satisfies ?? "").toMatch(/^ADR-09\b/);
    expect(scope.frontMatter.satisfies ?? "").not.toContain("completes");
  });
});

describe("07-05 Task 3 Test 2: the completing record states the decision", () => {
  const checks: ReadonlyArray<readonly [string, RegExp]> = [
    ["names the manual key form", /<jobId>:manual:<runId>/],
    [
      "names the scheduled key form with the IANA zone",
      /<jobId>:<cadence>:<YYYY-MM-DD>@<IANA zone>/,
    ],
    ["gives the worked manual example", /research\.daily-tech:manual:0mfk1a2b3c4d5e6f7a8b9c0d2/],
    [
      "gives the worked scheduled example",
      /research\.daily-tech:daily:2026-10-13@America\/New_York/,
    ],
    ["the zone sits inside the key", /zone[^.]*inside the (scheduled )?key/i],
    ["a changed zone opens a new window", /new window/i],
    ["one date may produce a duplicate run", /duplicate/i],
    ["manual runs never consume a scheduled window", /never (consume|alter)[^.]*scheduled window/i],
    ["outcome success", /\bsuccess\b/],
    ["outcome partial", /\bpartial\b/],
    ["outcome failure", /\bfailure\b/],
    [
      "skipped and missed are reserved",
      /skipped[^.]*missed[^.]*reserved|reserved[^.]*skipped[^.]*missed/i,
    ],
    ["partial is a completed run with outcome partial", /completed[^.]*outcome partial/i],
    ["outcome is null while running and for stale", /null while[^.]*running[^.]*stale/i],
    ["recovery to stale in the run table", /`runs`[^.]*stale|stale[^.]*`runs`/i],
    ["recovery to stale in the job run table", /`job_runs`[^.]*stale|stale[^.]*`job_runs`/i],
    ["recovery happens in one transaction", /one transaction/i],
    ["never an invented terminal state", /never an invented terminal state|invent/i],
    ["the in-flight lock", /in-flight lock/i],
    ["the partial unique index backstop", /partial unique index/i],
    ["the index name", /job_runs_one_inflight_per_job/],
    ["a second press returns the running run", /second press[^.]*running run/i],
    ["scheduled_for is the start instant for manual runs", /`scheduled_for`[^.]*start instant/i],
    ["raw snapshots are content-addressed", /content-addressed/i],
    ["milestone 1 deletes no raw snapshot", /never deleted|deletes nothing|no deletion/i],
    ["vault.delete is a reserved approval row", /`vault\.delete`[^.]*reserved/i],
    ["the catch-up seam", /`decideCatchUp\(/],
    [
      "catch-up is milestone-2 work",
      /decideCatchUp[^.]*milestone[ -]2|milestone[ -]2[^.]*decideCatchUp/i,
    ],
    [
      "the window functions are named",
      /`windowDate`[\s\S]*`wallToInstant`|`wallToInstant`[\s\S]*`windowDate`/,
    ],
    ["DST windows use the local date", /local date/i],
  ];
  for (const [label, pattern] of checks) {
    it(label, () => {
      expect(flat(jobRunAdr().body)).toMatch(pattern);
    });
  }

  it("names the scope record it completes by title", () => {
    const scope = adrWhere((adr) => adr.file.startsWith("0013-"), "is ADR 0013");
    expect(scope.title.length).toBeGreaterThan(10);
    expect(flat(jobRunAdr().body)).toContain(scope.title);
    expect(flat(jobRunAdr().body)).toMatch(/completes? .{0,60}(scope|half)/i);
  });

  it("uses placeholders only and every ADR number it mentions exists", () => {
    const adr = jobRunAdr();
    expect(adr.text).not.toMatch(HOME_PATH);
    const existing = new Set(allAdrs().map((a) => a.file.slice(0, 4)));
    for (const match of adr.text.matchAll(/ADR[- ](\d{4})\b/g)) {
      expect(existing.has(match[1] as string), `mentions ADR ${match[1]}`).toBe(true);
    }
  });
});

describe("07-05 Task 3 Test 3: the requirement is ticked", () => {
  const path = join(REPO_ROOT, ".planning", "REQUIREMENTS.md");
  it.skipIf(!existsSync(path))(
    "marks ADR-09 complete in the list and the traceability table",
    () => {
      const text = readFileSync(path, "utf8");
      expect(text).toMatch(/^- \[x\] \*\*ADR-09\*\*/m);
      expect(text).toMatch(/^\| ADR-09 \| Phase 7[^|]*\| Complete \|/m);
    },
  );
});

describe("09-07 Task 2: the glossary defines job run and Probe", () => {
  const NO_IMPLEMENTATION_DETAIL =
    /\.ts\b|SQLite|table|route|socket|storage|\bfiles?\b|packages\//i;

  it("Test 1: Job run is one execution of a job for one window or one press, with an avoid list", () => {
    const entry = glossaryEntry("Job run");
    expect(entry).toMatch(/One execution of a (named )?job/);
    expect(entry).toMatch(/schedule window/);
    expect(entry).toMatch(/one press/);
    expect(entry).toMatch(/second press[^.]*or a retry for the same[^.]*window[^.]*same Job run/i);
    expect(entry).toContain("_Avoid_:");
  });

  it("Test 2: Probe is a read-only, time-bounded check that answers with a reason", () => {
    const entry = glossaryEntry("Probe");
    expect(entry).toMatch(/read-only/);
    expect(entry).toMatch(/time-bounded/);
    expect(entry).toMatch(/one subsystem/);
    expect(entry).toMatch(/reason/);
    expect(entry).toMatch(/never changes anything/);
    expect(entry).toMatch(/unfinished one reads unknown/);
    expect(entry).toContain("_Avoid_:");
  });

  it("Test 3: neither entry carries implementation detail", () => {
    for (const name of ["Job run", "Probe"]) {
      expect(glossaryEntry(name), name).not.toMatch(NO_IMPLEMENTATION_DETAIL);
    }
  });
});

// ---------------------------------------------------------------------------
// Plan 09-20 Task 1 (APPR-11, APPR-12): the record of the presence decision

const PRESENCE_ADR_TITLE_FRAGMENT = "need the owner's presence";
const PRESENCE_SPIKE = join(
  REPO_ROOT,
  ".planning",
  "phases",
  "09-hardening-honest-session-state-and-trustworthy-approvals",
  "09-PRESENCE-SPIKE.md",
);
const hasPresenceSpike = existsSync(PRESENCE_SPIKE);

/** The ADR that records the Phase 9 presence mechanism (found by title, never by number). */
function presenceAdr(): Adr {
  return adrByTitle(PRESENCE_ADR_TITLE_FRAGMENT);
}

describe("09-20 Task 1: the presence decision record", () => {
  const decision = (): string => flat(section(presenceAdr(), "## Decision"));
  const residual = (): string => flat(section(presenceAdr(), "## Residual risk"));

  it("Test 1: is accepted, satisfies APPR-11 and APPR-12 and its title states the decision", () => {
    const adr = presenceAdr();
    expect(adr.frontMatter.status).toBe("accepted");
    expect(adr.frontMatter.satisfies ?? "").toMatch(/\bAPPR-11\b/);
    expect(adr.frontMatter.satisfies ?? "").toMatch(/\bAPPR-12\b/);
    expect(adr.title).toMatch(/^Connector-class approvals need the owner's presence/);
    expect(adr.title.length).toBeGreaterThan(60);
    for (const heading of [
      "## Context",
      "## Decision",
      "## Findings that shaped this decision",
      "## Residual risk",
      "## Considered Options",
      "## Consequences",
    ]) {
      expect(adr.text, heading).toContain(`\n${heading}`);
    }
  });

  describe("Test 2: the Decision section records what shipped", () => {
    const checks: ReadonlyArray<readonly [string, RegExp]> = [
      ["LocalAuthentication", /LocalAuthentication/],
      ["Objective-C", /Objective-C/],
      ["compiled locally with clang", /xcrun clang/],
      ["the custody that shipped", /\bK-ATTR\b/],
      ["the pin lives in a helper-only Keychain item attribute", /helper-acl-attribute/],
      ["the proof column", /`decision_proof`/],
      ["the key derivation", /HKDF-SHA256/],
      ["the MAC is detection only", /MAC[^.]*detection/i],
      ["the signature scheme", /P-256/],
      ["connector-class writes only", /connector-class[^.]*writes? only|only[^.]*connector-class/i],
      ["denial needs no gesture", /deny[^.]*(needs|without)[^.]*(gesture|presence)/i],
      [
        "force-terminate is unchanged",
        /force-terminate[^.]*unchanged|unchanged[^.]*force-terminate/i,
      ],
      ["Diagnostics availability", /Diagnostics[^.]*`unavailable`/],
      ["five-minute replay bound", /replay[^.]*five minutes|five minutes[^.]*replay/i],
      ["the header no longer authorises", /header[^.]*(no longer|never)[^.]*authoris/i],
      ["the prompt budget", /3 (prompts )?per minute|three prompts per minute/i],
    ];
    for (const [label, pattern] of checks) {
      it(label, () => {
        expect(decision()).toMatch(pattern);
      });
    }

    it.skipIf(!hasPresenceSpike)(
      "names the custody, pin and channel the spike record computed",
      () => {
        const spike = readFileSync(PRESENCE_SPIKE, "utf8");
        const custody = /^custody: (K-[A-Z]+)$/m.exec(spike)?.[1];
        const pin = /^pin: (\S+)$/m.exec(spike)?.[1];
        const channel = /^channel: (\S+)$/m.exec(spike)?.[1];
        expect(custody).toBeDefined();
        expect(decision()).toContain(custody as string);
        expect(decision()).toContain(pin as string);
        expect(decision()).toMatch(new RegExp(`channel[^.]*\\b${channel as string}\\b`, "i"));
      },
    );
  });

  describe("Test 3: the Residual risk section says what a same-user process can still do", () => {
    const checks: ReadonlyArray<readonly [string, RegExp]> = [
      ["can cause a prompt but cannot answer it", /cause[^.]*prompt[^.]*cannot answer/i],
      ["can replace the helper", /replace[^.]*helper/i],
      [
        "can read the install secret and compute the MAC: detection",
        /install secret[^.]*MAC[^.]*detection/i,
      ],
      ["a debugger or code injection", /debugger|code injection/i],
      ["out of scope", /out of scope/i],
      ["delete and recreate", /delete[^.]*recreate/i],
      [
        "a marker write plus a pin replacement suffices",
        /same-user marker write within the window plus a pin replacement suffices/i,
      ],
      ["detection, not prevention", /detection, not prevention/i],
      [
        "the prompt budget can be spent",
        /3 per minute[^.]*pending requests|pending requests[^.]*3 per minute/i,
      ],
      ["the audit reason names the budget", /`presence-budget`/],
      [
        "the MAC does not cover the presence part",
        /MAC[^.]*(does not|deliberately)[^.]*cover[^.]*presence part/i,
      ],
      ["the pending measurement", /`attr_delete_prompts`/],
      ["mitigations: hardened runtime", /hardened runtime/i],
      ["mitigations: login keychain", /login keychain/i],
      ["mitigations: code-directory hash", /code-directory hash|cdhash/i],
      ["detection: trust on first use", /trust on first use/i],
      ["detection: the closed warnings", /`presence-pin-changed`/],
    ];
    for (const [label, pattern] of checks) {
      it(label, () => {
        expect(residual()).toMatch(pattern);
      });
    }

    it("never claims a same-user process cannot forge a decision", () => {
      expect(presenceAdr().text).not.toMatch(/cannot forge|unforgeable|cannot be bypassed/i);
      expect(residual()).not.toMatch(/cannot forge/i);
    });

    it.skipIf(!hasPresenceSpike)(
      "carries the spike record's applicable reporting sentence word for word",
      () => {
        const spike = readFileSync(PRESENCE_SPIKE, "utf8");
        const applies = /^applies: (\S+)$/m.exec(spike)?.[1];
        expect(applies).toBeDefined();
        const sentence = new RegExp(`^${applies as string}: (.+)$`, "m").exec(spike)?.[1];
        expect(sentence).toBeDefined();
        expect(flat(presenceAdr().text)).toContain(flat(sentence as string));
      },
    );

    it.skipIf(!hasPresenceSpike)(
      "carries the spike record's stated residual paragraph word for word",
      () => {
        const spike = flat(readFileSync(PRESENCE_SPIKE, "utf8"));
        const start = spike.indexOf(
          "A same-user process that replaces the pin item and then writes",
        );
        const end = spike.indexOf("is detection, not prevention.", start);
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        const paragraph = spike.slice(start, end);
        expect(flat(presenceAdr().text)).toContain(paragraph);
      },
    );
  });

  describe("Test 4: the exception to the no-native-compilation stance and criterion 2", () => {
    it("states the exception to the stack's no-native-compilation stance and why", () => {
      const text = flat(presenceAdr().text);
      expect(text).toMatch(/no native compilation/i);
      expect(text).toMatch(/exception/i);
      expect(text).toMatch(/Command Line Tools[^.]*(already|prerequisite)/i);
      expect(text).toMatch(/no node-gyp/i);
      expect(text).toMatch(
        /no (prebuilt )?binary[^.]*(in Git|committed)|binary[^.]*not (committed|in Git)/i,
      );
    });

    it("reports roadmap success criterion 2 as partially met, with the reason", () => {
      const text = flat(presenceAdr().text);
      expect(text).toMatch(/success criterion 2 is partially met/i);
      expect(text).toMatch(/not a proof against every same-user process/i);
      expect(text).not.toMatch(/success criterion 2 is met\b/i);
    });

    it("records the rejected and the unchosen alternatives with their reasons", () => {
      const options = flat(section(presenceAdr(), "## Considered Options"));
      const checks: ReadonlyArray<readonly [string, RegExp]> = [
        ["Swift via swiftc", /Swift compiled with swiftc\.\*\* Rejected/],
        ["peer-process identification", /Peer-process identification on the socket\.\*\* Rejected/],
        ["a separate decide credential", /A separate decide credential\.\*\* Rejected/],
        ["K-SE", /K-SE[\s\S]{0,400}-34018/],
        ["K-ATTR chosen", /K-ATTR[^\n]*\*\* Chosen/],
        ["K-SVC", /K-SVC[\s\S]{0,400}install secret[\s\S]{0,200}detection/],
        ["node-gyp or a prebuilt binary", /node-gyp\) or a prebuilt binary in Git\.\*\* Rejected/],
      ];
      for (const [label, pattern] of checks) expect(options, label).toMatch(pattern);
    });

    it("uses placeholders only and every ADR number it mentions exists", () => {
      const adr = presenceAdr();
      expect(adr.text).not.toMatch(HOME_PATH);
      const existing = new Set(allAdrs().map((a) => a.file.slice(0, 4)));
      for (const match of adr.text.matchAll(/ADR[- ](\d{4})\b/g)) {
        expect(existing.has(match[1] as string), `ADR ${match[1]}`).toBe(true);
      }
    });
  });
});
