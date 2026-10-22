import { join, resolve } from "node:path";
import { type AuditArgs, UsageError } from "./cli-args.js";
import { REPO_ROOT } from "./repo-paths.js";
import { AUTO_RESULT_PATTERN, parseUatScript } from "./uat-tags.js";

/**
 * The SLICE-02 audit (plan 08-06, D-24, D-25, D-29): one command that reads every milestone-1
 * phase's live-UAT evidence from an explicit table, classifies it, lists the known exceptions for
 * the owner's one acceptance statement, and writes 08-UAT-AUDIT.md.
 *
 * Read-only toward every phase file: the only file this module ever writes is the `--out` record
 * (never a registered evidence file), and an owner's `result:` line is only read. Output to the
 * console is counts, phase numbers and file names, never item titles or result text. The checker
 * uses the runner's own `parseUatScript`, so the `### N.` format is parsed by the same code that
 * the runner trusts; the other evidence formats have small adapters below.
 */

// --- result vocabulary ----------------------------------------------------------------------

export type ResultState = "pending" | "ok" | "issue" | "unrecognised";

const OK_RESULT = /^(?:pass|passed|resolved|accepted)\b/i;
const ISSUE_RESULT = /^(?:fail|failed|issue|blocked)\b/i;

/** Maps one `result:` value to a state. Anything it does not know is reported, never guessed. */
export function classifyResult(value: string | null): ResultState {
  const text = (value ?? "").trim();
  if (text === "" || text.startsWith("[pending]")) return "pending";
  if (OK_RESULT.test(text)) return "ok";
  if (ISSUE_RESULT.test(text)) return "issue";
  return "unrecognised";
}

// --- the evidence table ---------------------------------------------------------------------

export type EvidenceKind =
  | "uat-script"
  | "results-block"
  | "uat-log"
  | "verification-owner-uat"
  | "ratified-run"
  | "ratified-report";

export interface EvidenceEntry {
  readonly kind: EvidenceKind;
  /** File names inside the phase folder (found by phase-number prefix, never a full folder name). */
  readonly files: readonly string[];
}

export interface PhaseEvidence {
  readonly phase: string;
  readonly entries: readonly EvidenceEntry[];
  /** Phases 07 and 08 are walked in the owner's last sitting; pending is expected, not a failure. */
  readonly pendingAllowed: boolean;
}

const script = (phase: string): EvidenceEntry => ({
  kind: "uat-script",
  files: [`${phase}-UAT.md`],
});

/** Explicit, not a glob: a deleted evidence file must fail loudly (research B 4.2). */
export const PHASE_EVIDENCE: readonly PhaseEvidence[] = [
  {
    phase: "01",
    entries: [{ kind: "verification-owner-uat", files: ["01-VERIFICATION.md"] }],
    pendingAllowed: false,
  },
  { phase: "02", entries: [script("02")], pendingAllowed: false },
  { phase: "03", entries: [script("03")], pendingAllowed: false },
  { phase: "04", entries: [script("04")], pendingAllowed: false },
  {
    phase: "05",
    entries: [{ kind: "results-block", files: ["05-UAT.md"] }],
    pendingAllowed: false,
  },
  {
    phase: "05.1",
    entries: [{ kind: "uat-log", files: ["05.1-UAT.md", "05.1-UAT-RESULTS-LOG.md"] }],
    pendingAllowed: false,
  },
  {
    phase: "05.2",
    entries: [{ kind: "ratified-run", files: ["05.2-VERIFICATION.md"] }],
    pendingAllowed: false,
  },
  {
    phase: "06",
    entries: [script("06"), { kind: "ratified-report", files: ["06-UAT-AUTO-REPORT.md"] }],
    pendingAllowed: false,
  },
  { phase: "07", entries: [script("07")], pendingAllowed: true },
  { phase: "08", entries: [script("08")], pendingAllowed: true },
];

// --- results --------------------------------------------------------------------------------

export type PhaseStatus =
  | "recorded"
  | "recorded-with-exceptions"
  | "pending-live-uat"
  | "missing"
  | "issue"
  | "unrecognised";

/** A soft spot the owner accepts (OD-7): listed, never silently passed. */
export interface AuditException {
  readonly id: string;
  readonly phase: string;
  readonly summary: string;
  readonly pointer: string;
}

interface AdapterOutput {
  total: number;
  recorded: number;
  pending: number;
  issues: number;
  unrecognised: number;
  missing: boolean;
  defects: string[];
  exceptions: AuditException[];
}

export interface PhaseRow {
  readonly phase: string;
  readonly status: PhaseStatus;
  readonly recorded: number;
  readonly total: number;
  /** Repository-relative-looking pointers: `<phase folder>/<file>`. */
  readonly files: readonly string[];
  readonly exceptions: readonly AuditException[];
  readonly defects: readonly string[];
  readonly pendingAllowed: boolean;
}

export interface AuditResult {
  readonly rows: readonly PhaseRow[];
  readonly exceptions: readonly AuditException[];
  /** Defects in other phases' files, prefixed by the phase number. */
  readonly defects: readonly string[];
  /** UAT-named files in the folder that the table does not register. */
  readonly unregistered: readonly string[];
}

export interface AuditInput {
  readonly phasesDir: string;
  readonly readText: (path: string) => string | null;
  readonly listDir: (dir: string) => string[];
  /** A test-only filter of phase ids. */
  readonly only?: readonly string[] | undefined;
}

function emptyOutput(): AdapterOutput {
  return {
    total: 0,
    recorded: 0,
    pending: 0,
    issues: 0,
    unrecognised: 0,
    missing: false,
    defects: [],
    exceptions: [],
  };
}

function missingOutput(): AdapterOutput {
  return { ...emptyOutput(), missing: true };
}

/** Counts one classified item into an adapter output. */
function count(out: AdapterOutput, state: ResultState): void {
  out.total += 1;
  if (state === "ok") out.recorded += 1;
  else if (state === "pending") out.pending += 1;
  else if (state === "issue") out.issues += 1;
  else out.unrecognised += 1;
}

interface AdapterContext {
  readonly phase: string;
  readonly texts: readonly string[];
  /** Run ids whose automated results the owner (or the standing authorization) ratified. */
  readonly ratifiedRuns: ReadonlySet<string>;
}

// --- adapter: standard `### N.` script ------------------------------------------------------

function scriptAdapter(context: AdapterContext): AdapterOutput {
  const out = emptyOutput();
  const parsed = parseUatScript(context.texts[0] ?? "");
  if (parsed.items.length === 0) {
    out.unrecognised += 1;
    out.defects.push("the script holds no numbered items");
    return out;
  }
  for (const item of parsed.items) {
    let state = classifyResult(item.resultValue);
    if (state === "pending" && item.autoResult !== null) {
      // An automated result stands in for the owner's line only once its run is ratified.
      const match = AUTO_RESULT_PATTERN.exec(item.autoResult);
      if (match !== null && match[1] === "pass" && context.ratifiedRuns.has(match[2] as string)) {
        state = "ok";
      }
    }
    count(out, state);
  }
  const declaredComplete = (parsed.frontMatter.status ?? "").trim() === "complete";
  if (declaredComplete && out.pending > 0) {
    out.defects.push("the front matter says complete but items are still pending");
  } else if (!declaredComplete && out.pending === 0 && out.issues === 0) {
    out.defects.push("every item is recorded but the front matter does not say complete");
  }
  return out;
}

const adapters: Readonly<Record<EvidenceKind, (context: AdapterContext) => AdapterOutput>> = {
  "uat-script": scriptAdapter,
  "results-block": () => ({ ...emptyOutput(), unrecognised: 1, defects: ["adapter not built"] }),
  "uat-log": () => ({ ...emptyOutput(), unrecognised: 1, defects: ["adapter not built"] }),
  "verification-owner-uat": () => ({
    ...emptyOutput(),
    unrecognised: 1,
    defects: ["adapter not built"],
  }),
  "ratified-run": () => ({ ...emptyOutput(), unrecognised: 1, defects: ["adapter not built"] }),
  "ratified-report": () => emptyOutput(),
};

// --- the audit ------------------------------------------------------------------------------

/** The folder of a phase: the first entry whose name starts with `<phase>-`. */
function phaseFolder(listing: readonly string[], phase: string): string | null {
  return [...listing].sort().find((name) => name.startsWith(`${phase}-`)) ?? null;
}

/** Run ids ratified by any `*-AUTO-REPORT.md` in the phase folder. */
function ratifiedRunsOf(
  folder: string,
  listing: readonly string[],
  readText: (path: string) => string | null,
): Set<string> {
  const runs = new Set<string>();
  for (const name of listing) {
    if (!/AUTO-REPORT\.md$/.test(name)) continue;
    const text = readText(join(folder, name));
    if (text === null) continue;
    const front = parseUatScript(text).frontMatter;
    const ratified = (front.ratified ?? "").trim();
    const run = (front["run-id"] ?? "").trim();
    if (ratified !== "" && !/^pending\b/i.test(ratified) && /^[0-9a-f]{8}$/.test(run)) {
      runs.add(run);
    }
  }
  return runs;
}

function combine(outputs: readonly AdapterOutput[]): AdapterOutput {
  const total = emptyOutput();
  for (const out of outputs) {
    total.total += out.total;
    total.recorded += out.recorded;
    total.pending += out.pending;
    total.issues += out.issues;
    total.unrecognised += out.unrecognised;
    total.missing = total.missing || out.missing;
    total.defects.push(...out.defects);
    total.exceptions.push(...out.exceptions);
  }
  return total;
}

function statusOf(out: AdapterOutput): PhaseStatus {
  if (out.missing) return "missing";
  if (out.issues > 0) return "issue";
  if (out.unrecognised > 0) return "unrecognised";
  if (out.pending > 0) return "pending-live-uat";
  return out.exceptions.length > 0 ? "recorded-with-exceptions" : "recorded";
}

/** Reads every registered phase and classifies it. Pure apart from the injected reads. */
export function auditPhases(input: AuditInput): AuditResult {
  const listing = input.listDir(input.phasesDir);
  const rows: PhaseRow[] = [];
  const registered = new Set<string>();
  for (const evidence of PHASE_EVIDENCE) {
    if (input.only !== undefined && !input.only.includes(evidence.phase)) continue;
    const folderName = phaseFolder(listing, evidence.phase);
    if (folderName === null) {
      rows.push({
        phase: evidence.phase,
        status: "missing",
        recorded: 0,
        total: 0,
        files: [],
        exceptions: [],
        defects: [],
        pendingAllowed: evidence.pendingAllowed,
      });
      continue;
    }
    const folder = join(input.phasesDir, folderName);
    const folderListing = input.listDir(folder);
    const ratifiedRuns = ratifiedRunsOf(folder, folderListing, input.readText);
    const files: string[] = [];
    const outputs = evidence.entries.map((entry) => {
      const texts: string[] = [];
      for (const file of entry.files) {
        files.push(`${folderName}/${file}`);
        registered.add(`${folderName}/${file}`);
        const text = input.readText(join(folder, file));
        if (text === null) return missingOutput();
        texts.push(text);
      }
      return adapters[entry.kind]({ phase: evidence.phase, texts, ratifiedRuns });
    });
    const out = combine(outputs);
    rows.push({
      phase: evidence.phase,
      status: statusOf(out),
      recorded: out.recorded,
      total: out.total,
      files,
      exceptions: out.exceptions,
      defects: out.defects,
      pendingAllowed: evidence.pendingAllowed,
    });
  }
  const unregistered: string[] = [];
  if (input.only === undefined) {
    for (const folderName of listing) {
      for (const file of input.listDir(join(input.phasesDir, folderName))) {
        if (/UAT/.test(file) && file.endsWith(".md") && !registered.has(`${folderName}/${file}`)) {
          unregistered.push(`${folderName}/${file}`);
        }
      }
    }
  }
  return {
    rows,
    exceptions: rows.flatMap((row) => row.exceptions),
    defects: rows.flatMap((row) => row.defects.map((defect) => `${row.phase}: ${defect}`)),
    unregistered: unregistered.sort(),
  };
}

// --- exit rule ------------------------------------------------------------------------------

/** Acceptance markers by exception id, as parsed from the existing record. */
export type Acceptances = Readonly<Record<string, string>>;

function isAccepted(value: string | undefined): boolean {
  return value !== undefined && /^\d{4}-\d{2}-\d{2}/.test(value.trim());
}

/**
 * The exit rule (D-29). Not strict: every phase `recorded` or `recorded-with-exceptions`, and only
 * 07 and 08 may be `pending-live-uat`. Strict (milestone close) also fails on 07 or 08 pending and
 * on any exception without an acceptance date.
 */
export function problemsOf(
  result: AuditResult,
  options: { strict: boolean; accepted: Acceptances },
): string[] {
  const problems: string[] = [];
  for (const row of result.rows) {
    const fine =
      row.status === "recorded" ||
      row.status === "recorded-with-exceptions" ||
      (row.pendingAllowed && row.status === "pending-live-uat");
    if (!fine) problems.push(`${row.phase}: ${row.status}`);
    else if (options.strict && row.status === "pending-live-uat") {
      problems.push(`${row.phase}: pending-live-uat`);
    }
  }
  if (options.strict) {
    for (const exception of result.exceptions) {
      if (!isAccepted(options.accepted[exception.id])) {
        problems.push(`${exception.phase}: exception ${exception.id} not accepted`);
      }
    }
  }
  return problems;
}

// --- the record -----------------------------------------------------------------------------

const AMENDMENTS_DEFAULT =
  "## Amendments\n\n_None recorded yet. Plan 08-19 records the 07-UAT item 20 amendment here (D-47)._\n";
const STATEMENT_DEFAULT = [
  "## Milestone statement",
  "",
  "Written by the owner (OD-7 and OD-8). Agents never fill this block.",
  "",
  "- OD-7, accept the exceptions above in one statement: pending",
  "- SC5 verdict (OD-8), would you reach for it: pending",
  "",
].join("\n");

export interface PreservedBlocks {
  readonly accepted: Record<string, string>;
  readonly amendments: string | null;
  readonly statement: string | null;
}

/** The block that starts at `## <heading>` and runs to the next `## ` heading or the end. */
function blockOf(text: string, heading: string): string | null {
  const start = text.search(new RegExp(`^## ${heading}\\s*$`, "m"));
  if (start === -1) return null;
  const rest = text.slice(start);
  const next = rest.slice(3).search(/^## /m);
  const block = next === -1 ? rest : rest.slice(0, next + 3);
  return `${block.trimEnd()}\n`;
}

/** What an existing record holds that regeneration must keep byte for byte. */
export function parsePreservedBlocks(existing: string | null): PreservedBlocks {
  if (existing === null) return { accepted: {}, amendments: null, statement: null };
  const accepted: Record<string, string> = {};
  const exceptions = blockOf(existing, "Exceptions") ?? "";
  for (const line of exceptions.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const id = cells[0] ?? "";
    const value = cells[cells.length - 1] ?? "";
    if (/^\d{2}(?:\.\d)?-[a-z0-9-]+$/.test(id) && value !== "") accepted[id] = value;
  }
  return {
    accepted,
    amendments: blockOf(existing, "Amendments"),
    statement: blockOf(existing, "Milestone statement"),
  };
}

export interface RenderContext {
  readonly generated: string;
  readonly gitHead: string;
  readonly preserved: PreservedBlocks;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/** The whole record: generated sections are rebuilt, the preserved blocks are kept verbatim. */
export function renderAudit(result: AuditResult, context: RenderContext): string {
  const accepted = context.preserved.accepted;
  const count = (status: PhaseStatus): number =>
    result.rows.filter((row) => row.status === status).length;
  const acceptedCount = result.exceptions.filter((entry) => isAccepted(accepted[entry.id])).length;
  const strictClean = problemsOf(result, { strict: true, accepted }).length === 0;
  const lines: string[] = [
    "---",
    `generated: ${context.generated}`,
    `git-head: ${context.gitHead}`,
    `phases: ${result.rows.length}`,
    `recorded: ${count("recorded")}`,
    `recorded-with-exceptions: ${count("recorded-with-exceptions")}`,
    `pending-live-uat: ${count("pending-live-uat")}`,
    `not-recorded: ${result.rows.filter((row) => ["missing", "issue", "unrecognised"].includes(row.status)).length}`,
    `exceptions: ${result.exceptions.length}`,
    `exceptions-accepted: ${acceptedCount}`,
    `strict-clean: ${strictClean}`,
    "---",
    "",
    "# SLICE-02 UAT audit",
    "",
    "Generated by `pnpm run uat:audit` (plan 08-06). The Phases, Exceptions and Defects sections are",
    "rebuilt on every run; the `accepted:` column, the Amendments block and the Milestone statement",
    "block are kept as the owner left them. Other phases' files are only read, never edited.",
    "",
    "## Phases",
    "",
    "| Phase | Evidence | Items recorded | Status | Pointer |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const row of result.rows) {
    const evidence = row.files.length === 0 ? "none found" : `${row.files.length} file(s)`;
    lines.push(
      `| ${row.phase} | ${evidence} | ${row.recorded}/${row.total} | ${row.status} | ${
        row.files.length === 0 ? "-" : cell(row.files.join(", "))
      } |`,
    );
  }
  lines.push("", "## Exceptions", "");
  if (result.exceptions.length === 0) {
    lines.push("None found.", "");
  } else {
    lines.push(
      "| id | Phase | Exception | Pointer | accepted: |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const entry of result.exceptions) {
      lines.push(
        `| ${entry.id} | ${entry.phase} | ${cell(entry.summary)} | ${entry.pointer} | ${
          accepted[entry.id] ?? "pending"
        } |`,
      );
    }
    lines.push("");
  }
  lines.push("## Defects in other phases' files", "");
  if (result.defects.length === 0 && result.unregistered.length === 0) {
    lines.push("None found.", "");
  } else {
    for (const defect of result.defects) lines.push(`- ${defect}`);
    for (const name of result.unregistered) lines.push(`- unregistered UAT file: ${name}`);
    lines.push("");
  }
  lines.push(
    (context.preserved.amendments ?? AMENDMENTS_DEFAULT).trimEnd(),
    "",
    (context.preserved.statement ?? STATEMENT_DEFAULT).trimEnd(),
    "",
  );
  return lines.join("\n");
}

// --- the command ----------------------------------------------------------------------------

export interface AuditCommandIo {
  readonly readText: (path: string) => string | null;
  readonly writeText: (path: string, text: string) => void;
  readonly listFiles: (dir: string) => string[];
  readonly exists: (path: string) => boolean;
  readonly now: () => Date;
  readonly gitHead: () => Promise<string>;
}

const PHASES_SEGMENTS = [".planning", "phases"] as const;
const RECORD_NAME = "08-UAT-AUDIT.md";

/** Runs the audit and writes the record. Exit codes: 0 fine, 1 a phase is not recorded, 2 usage. */
export async function runAuditCommand(
  args: AuditArgs,
  io: AuditCommandIo,
  write: (line: string) => void,
): Promise<number> {
  const knownPhases = PHASE_EVIDENCE.map((entry) => entry.phase);
  if (args.only?.some((phase) => !knownPhases.includes(phase))) {
    throw new UsageError("--only names a phase the audit does not know.");
  }
  const phasesDir = args.phasesDir ?? join(REPO_ROOT, ...PHASES_SEGMENTS);
  if (!io.exists(phasesDir)) {
    if (args.phasesDir === undefined) {
      // A public clone has no planning folder: nothing to audit, nothing failed.
      write("not applicable (no planning directory)");
      return 0;
    }
    throw new UsageError("--phases-dir must be an existing folder.");
  }

  const result = auditPhases({
    phasesDir,
    readText: io.readText,
    listDir: io.listFiles,
    only: args.only,
  });

  let outPath = args.out;
  if (outPath === undefined) {
    const phase08 = phaseFolder(io.listFiles(phasesDir), "08");
    if (phase08 === null) throw new UsageError("--out is required when no Phase 8 folder exists.");
    outPath = join(phasesDir, phase08, RECORD_NAME);
  }
  const target = resolve(outPath);
  for (const row of result.rows) {
    for (const file of row.files) {
      if (resolve(phasesDir, file) === target) {
        throw new UsageError("--out must not be one of the evidence files.");
      }
    }
  }

  const preserved = parsePreservedBlocks(io.readText(outPath));
  const text = renderAudit(result, {
    generated: io.now().toISOString().slice(0, 10),
    gitHead: await io.gitHead(),
    preserved,
  });
  io.writeText(outPath, text);

  for (const row of result.rows) {
    write(`Phase ${row.phase}: ${row.status} (${row.recorded}/${row.total} items recorded)`);
  }
  write(`Exceptions listed: ${result.exceptions.length}.`);
  const problems = problemsOf(result, { strict: args.strict, accepted: preserved.accepted });
  for (const problem of problems) write(`Problem: ${problem}.`);
  write(`Record written: ${outPath.split("/").pop() ?? RECORD_NAME}.`);
  return problems.length === 0 ? 0 : 1;
}
