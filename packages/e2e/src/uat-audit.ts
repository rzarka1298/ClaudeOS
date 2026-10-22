import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalPath, isSameOrInside } from "./canonical-path.js";
import { type AuditArgs, UsageError } from "./cli-args.js";
import { REPO_ROOT } from "./repo-paths.js";
import { specMapForPhase } from "./spec-map.js";
import { AUTO_RESULT_PATTERN, parseUatScript, type TagFinding } from "./uat-tags.js";

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
  /** A test-only filter of phase ids. The command line has no such flag (FIX1B B-M1). */
  readonly only?: readonly string[] | undefined;
  /**
   * The item count each phase's script must have. Defaults to the spec map's count for phases 06,
   * 07 and 08 (FIX1B B-M2 b); tests with miniature fixtures override it.
   */
  readonly expectedItems?: Readonly<Record<string, number>> | undefined;
}

/** Test-only seams of {@link runAuditCommand}; the production parser reaches none of them. */
export interface AuditTestHooks {
  readonly only?: readonly string[] | undefined;
  readonly expectedItems?: Readonly<Record<string, number>> | undefined;
}

const OD7 = "OD-7";
/** The record this module writes; it is never listed as an unregistered UAT file. */
const RECORD_NAME = "08-UAT-AUDIT.md";

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
  /** The item count the phase's script must have, or null when nothing pins it. */
  readonly expectedItems: number | null;
}

// --- adapter: standard `### N.` script ------------------------------------------------------

/** A finding as a record line: the stable code and the item number, never script content. */
function findingLine(found: TagFinding): string {
  return found.item === null ? found.code : `${found.code} (item ${found.item})`;
}

function scriptAdapter(context: AdapterContext): AdapterOutput {
  const out = emptyOutput();
  const parsed = parseUatScript(context.texts[0] ?? "");
  if (parsed.items.length === 0) {
    out.unrecognised += 1;
    out.defects.push("the script holds no numbered items");
    return out;
  }
  // Any parse finding (a repeated item, a repeated tag, a malformed auto-result) makes the
  // affected item unreadable; a finding about the script as a whole makes the script unreadable.
  const flagged = new Set<number>();
  for (const found of parsed.findings) {
    out.defects.push(`the script has a parse finding: ${findingLine(found)}`);
    if (found.item === null) out.unrecognised += 1;
    else flagged.add(found.item);
  }
  for (const item of parsed.items) {
    let state: ResultState;
    if (item.resultLines !== 1) {
      state = "unrecognised";
      out.defects.push(`item ${item.number} has ${item.resultLines} result line(s), not one`);
    } else if (flagged.has(item.number)) {
      state = "unrecognised";
    } else {
      state = classifyResult(item.resultValue);
      const match = item.autoResult === null ? null : AUTO_RESULT_PATTERN.exec(item.autoResult);
      if (state === "pending" && match !== null) {
        // An automated result stands in for the owner's line only once its run is ratified.
        if (match[1] === "pass" && context.ratifiedRuns.has(match[2] as string)) state = "ok";
      }
      // An explicit automated failure is an issue even while the owner has not walked the item;
      // only the owner's own passing result supersedes it.
      if (match !== null && match[1] === "fail" && state !== "ok") state = "issue";
    }
    count(out, state);
  }
  const total = parsed.summary.total;
  if (total === undefined || !/^\d+$/.test(total)) {
    out.unrecognised += 1;
    out.defects.push("the Summary has no readable total");
  } else if (Number(total) !== parsed.items.length) {
    out.unrecognised += 1;
    out.defects.push(
      `the script has ${parsed.items.length} item(s) but the Summary total says ${total}`,
    );
  }
  if (context.expectedItems !== null && context.expectedItems !== parsed.items.length) {
    out.unrecognised += 1;
    out.defects.push(
      `the script has ${parsed.items.length} item(s) but the spec map has ${context.expectedItems}`,
    );
  }
  const status = (parsed.frontMatter.status ?? "").trim();
  const declaredComplete = status === "complete";
  if (declaredComplete && out.pending > 0) {
    out.defects.push("the front matter says complete but items are still pending");
  } else if (!declaredComplete && out.pending === 0 && out.issues === 0) {
    out.defects.push("every item is recorded but the front matter does not say complete");
  } else if (status === "testing" && out.pending > 0 && context.phase !== "08") {
    // Phase 8's own script is the audit's subject; every other phase still saying testing is a
    // defect in that phase's file (research B 4.2).
    out.defects.push("the front matter still says status: testing; the live walk has not happened");
  }
  return out;
}

// --- adapter: Phase 5 free-form results block ----------------------------------------------

/** The lines of the section that starts at the first heading matching `heading`. */
function sectionLines(text: string, heading: RegExp): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return end === -1 ? rest : rest.slice(0, end);
}

/** Records an item whose result exists but is a soft spot the owner accepts. */
function recordException(out: AdapterOutput, exception: AuditException): void {
  out.total += 1;
  out.recorded += 1;
  out.exceptions.push(exception);
}

const exceptionOf = (
  phase: string,
  id: string,
  summary: string,
  pointer: string = OD7,
): AuditException => ({ id, phase, summary, pointer });

function resultsBlockAdapter(context: AdapterContext): AdapterOutput {
  const out = emptyOutput();
  const text = context.texts[0] ?? "";
  const items = sectionLines(text, /^## Items\b/)
    .map((line) => /^- UAT-(\d+)\b/.exec(line)?.[1])
    .filter((id): id is string => id !== undefined);
  if (items.length === 0) {
    out.unrecognised += 1;
    out.defects.push("no items found in the Items list");
    return out;
  }
  // The latest line per item wins, and `UAT-9 (re-run on ...)` is the same item as `UAT-9`.
  const latest = new Map<string, string>();
  for (const line of sectionLines(text, /^## Results\b/)) {
    const match = /^- UAT-(\d+)(?: \([^)]*\))?:\s*(.*)$/.exec(line);
    if (match !== null) latest.set(match[1] as string, (match[2] as string).trim());
  }
  for (const id of items) {
    const value = latest.get(id);
    if (value === undefined) count(out, "pending");
    else if (/^UNVERIFIED\b/i.test(value)) {
      recordException(
        out,
        exceptionOf(context.phase, `${context.phase}-uat-${id}`, `UAT-${id} recorded UNVERIFIED`),
      );
    } else count(out, classifyResult(value));
  }
  if (/^Status:\s*NOT RUN\b/im.test(text) && latest.size > 0) {
    out.defects.push("the header still says NOT RUN although results are recorded");
  }
  return out;
}

// --- adapter: Phase 05.1 headings plus a results log ----------------------------------------

/** What one complete `U<n> <verb> ...` log line says. */
type LogVerdict = "ok" | "issue" | "not applicable" | "not run" | "partial" | "unrecognised";

function logVerdictOf(rest: string): LogVerdict {
  if (/^(?:pass|passed)\b/i.test(rest)) return "ok";
  if (/^(?:fail|failed|blocked|issue)\b/i.test(rest)) return "issue";
  if (/^not applicable\b/i.test(rest)) return "not applicable";
  if (/^not run\b/i.test(rest)) return "not run";
  if (/^partial\b/i.test(rest)) return "partial";
  return "unrecognised";
}

function uatLogAdapter(context: AdapterContext): AdapterOutput {
  const out = emptyOutput();
  const script = context.texts[0] ?? "";
  const log = context.texts[1] ?? "";
  const items = [...script.matchAll(/^### U(\d+) \u2014/gm)].map((match) => match[1] as string);
  if (items.length === 0) {
    out.unrecognised += 1;
    out.defects.push("no U-numbered items found");
    return out;
  }
  // `U10 part 1 pass` is not a complete result; every other `U<n> <words>` line is one, and the
  // latest wins whatever it says (so a later failure or an unknown verb supersedes an earlier pass).
  const latest = new Map<string, string>();
  for (const line of log.split(/\r?\n/)) {
    const match = /^U(\d+)\s+(\S.*)/.exec(line);
    if (match === null) continue;
    const rest = (match[2] as string).trim();
    if (/^part\s+\d+\b/i.test(rest)) continue;
    latest.set(match[1] as string, rest);
  }
  for (const id of latest.keys()) {
    if (!items.includes(id))
      out.defects.push(`the log has a result for U${id}, which the script lacks`);
  }
  for (const id of items) {
    const rest = latest.get(id);
    if (rest === undefined) {
      count(out, "pending");
      continue;
    }
    const verdict = logVerdictOf(rest);
    if (verdict === "ok") count(out, "ok");
    else if (verdict === "issue") count(out, "issue");
    else if (verdict === "unrecognised") {
      count(out, "unrecognised");
      out.defects.push(`U${id} has a result line whose verb is not recognised`);
    } else {
      recordException(
        out,
        exceptionOf(context.phase, `${context.phase}-u${id}`, `U${id} recorded as ${verdict}`),
      );
    }
  }
  if (/^Status:.*run by Claude with computer use/im.test(script)) {
    out.exceptions.push(
      exceptionOf(
        context.phase,
        `${context.phase}-claude-run`,
        "Items run by Claude with computer use rather than by the owner (header note)",
      ),
    );
  }
  const inFilePending = (script.match(/^result:\s*\[pending\]/gm) ?? []).length;
  if (inFilePending > 0) {
    out.defects.push(
      `${inFilePending} in-file result line(s) still read [pending]; the log is the record`,
    );
  }
  return out;
}

// --- adapter: Phase 1 owner UAT heading in the verification file -----------------------------

function verificationAdapter(context: AdapterContext): AdapterOutput {
  const out = emptyOutput();
  const text = context.texts[0] ?? "";
  out.total = 1;
  if (!/^## Owner UAT \u2014 PASSED \(\d{4}-\d{2}-\d{2}\)/m.test(text)) {
    out.pending = 1;
    out.defects.push("no Owner UAT PASSED heading found");
    return out;
  }
  out.recorded = 1;
  if (/Item 10[\s\S]{0,80}deferred/i.test(text)) {
    out.exceptions.push(
      exceptionOf(
        context.phase,
        `${context.phase}-item-10`,
        "Item 10 (CI red on a real push) deferred until a remote exists",
      ),
    );
  }
  return out;
}

// --- adapter: Phase 05.2 ratified run --------------------------------------------------------

const RATIFIED_MARKER =
  /\b(?:was|were|been|is|are|got)\s+ratified\b|\bratified\s*:|\bratified by\b/i;
const NOT_A_RATIFICATION = /\bnot\b|\bun-?ratified\b|\bwhether\b|\bdecide\b|\bunless\b|\bif\b|\?/i;

/**
 * Run ids the record states were ratified: a sentence that names `run <8 hex>` and carries a
 * ratified marker (`was ratified`, `ratified by`, `ratified:`) and is not a question, a negation
 * or a pending decision. A bare mention of a run id proves nothing.
 */
export function ratifiedRunsIn(text: string): string[] {
  const found: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    if (!RATIFIED_MARKER.test(sentence) || NOT_A_RATIFICATION.test(sentence)) continue;
    for (const match of sentence.matchAll(/\brun\s+\**([0-9a-f]{8})\b/gi)) {
      found.push((match[1] as string).toLowerCase());
    }
  }
  return found;
}

function ratifiedRunAdapter(context: AdapterContext): AdapterOutput {
  const out = emptyOutput();
  const text = context.texts[0] ?? "";
  out.total = 1;
  const passed = (parseUatScript(text).frontMatter.status ?? "").trim() === "passed";
  if (!passed || ratifiedRunsIn(text).length === 0) {
    out.pending = 1;
    out.defects.push("the verification record is not passed or names no ratified run");
    return out;
  }
  out.recorded = 1;
  out.exceptions.push(
    exceptionOf(
      context.phase,
      `${context.phase}-no-uat-file`,
      "No UAT file of its own; the evidence is the verification record and a ratified run",
    ),
  );
  return out;
}

// --- adapter: the ratification statement of an auto report -----------------------------------

function ratifiedReportAdapter(context: AdapterContext): AdapterOutput {
  const out = emptyOutput();
  const ratified = (parseUatScript(context.texts[0] ?? "").frontMatter.ratified ?? "").trim();
  if (ratified === "" || /^pending\b/i.test(ratified)) {
    out.defects.push("the auto report is not ratified");
  } else if (/^Ratified by Claude\b/i.test(ratified)) {
    out.exceptions.push(
      exceptionOf(
        context.phase,
        `${context.phase}-claude-ratified`,
        "Auto run ratified by Claude under standing authorization, not by the owner's one-line statement",
      ),
    );
  }
  return out;
}

const adapters: Readonly<Record<EvidenceKind, (context: AdapterContext) => AdapterOutput>> = {
  "uat-script": scriptAdapter,
  "results-block": resultsBlockAdapter,
  "uat-log": uatLogAdapter,
  "verification-owner-uat": verificationAdapter,
  "ratified-run": ratifiedRunAdapter,
  "ratified-report": ratifiedReportAdapter,
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

/** The item count a phase's script must have: an explicit override, else the spec map's. */
function expectedItemsOf(
  phase: string,
  overrides: Readonly<Record<string, number>> | undefined,
): number | null {
  const override = overrides?.[phase];
  if (override !== undefined) return override;
  if (overrides !== undefined) return null;
  return specMapForPhase(phase)?.itemPlan.length ?? null;
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
      return adapters[entry.kind]({
        phase: evidence.phase,
        texts,
        ratifiedRuns,
        expectedItems: expectedItemsOf(evidence.phase, input.expectedItems),
      });
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
        if (
          /UAT/.test(file) &&
          file.endsWith(".md") &&
          file !== RECORD_NAME &&
          !registered.has(`${folderName}/${file}`)
        ) {
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

const ACCEPTANCE = /^(?:accepted )?(\d{4})-(\d{2})-(\d{2})$/;

/** True only for exactly `YYYY-MM-DD` or `accepted YYYY-MM-DD`, and only for a real calendar day. */
function isAccepted(value: string | undefined): boolean {
  const match = value === undefined ? null : ACCEPTANCE.exec(value.trim());
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
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
      const value = options.accepted[exception.id]?.trim();
      if (value === undefined || value === "" || /^pending\b/i.test(value)) {
        problems.push(`${exception.phase}: exception ${exception.id} not accepted`);
      } else if (!isAccepted(value)) {
        // Anything that is not exactly a date is an unreadable acceptance, never a quiet pass.
        problems.push(`${exception.phase}: exception ${exception.id} acceptance unreadable`);
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
  /**
   * Everything from the first owner heading (`## Amendments`, else `## Milestone statement`) to
   * the end of the file, verbatim. Nested headings (an amendment per item, a signature) are the
   * owner's and survive regeneration whatever they are called (FIX1B B-M4).
   */
  readonly ownerRegion: string | null;
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
  if (existing === null) return { accepted: {}, ownerRegion: null };
  const starts = [/^## Amendments\s*$/m, /^## Milestone statement\s*$/m]
    .map((heading) => existing.search(heading))
    .filter((index) => index !== -1);
  const regionStart = starts.length === 0 ? -1 : Math.min(...starts);
  // Only the generated part is read for acceptances: a table pasted into the owner's region is
  // the owner's prose, not a record the checker may take a date from.
  const generated = regionStart === -1 ? existing : existing.slice(0, regionStart);
  const accepted: Record<string, string> = {};
  const exceptions = blockOf(generated, "Exceptions") ?? "";
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
    ownerRegion: regionStart === -1 ? null : existing.slice(regionStart),
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
  const region = context.preserved.ownerRegion ?? `${AMENDMENTS_DEFAULT}\n${STATEMENT_DEFAULT}`;
  // `lines` ends with a blank entry, so the join ends with one newline; one more leaves the blank
  // line before the owner's region, which is appended exactly as it was read.
  return `${lines.join("\n")}\n${region}`;
}

// --- the command ----------------------------------------------------------------------------

export interface AuditCommandIo {
  readonly readText: (path: string) => string | null;
  readonly writeText: (path: string, text: string) => void;
  readonly listFiles: (dir: string) => string[];
  readonly exists: (path: string) => boolean;
  readonly now: () => Date;
  readonly gitHead: () => Promise<string>;
  /** The path with every existing component resolved (`realpath.native`); defaults to the real one. */
  readonly canonical?: (path: string) => string;
  /** `<device>:<inode>` of an existing file, or null; defaults to the real `stat`. */
  readonly identity?: (path: string) => string | null;
  /** The OS temp folder; defaults to `os.tmpdir()`. */
  readonly tmpRoot?: () => string;
}

const PHASES_SEGMENTS = [".planning", "phases"] as const;

const realIdentity = (path: string): string | null => {
  try {
    const info = statSync(path);
    return `${info.dev}:${info.ino}`;
  } catch {
    return null;
  }
};

export const MSG_OUT_EVIDENCE = "--out must not be one of the evidence files.";
export const MSG_OUT_LOCATION = "--out must be inside the Phase 8 folder or the temp folder.";

/**
 * Why an `--out` path is refused, or null. The check ignores any phase filter: it covers EVERY
 * registered evidence file the folder holds, compares canonical (`realpath.native`) paths and
 * inode identities, so case variants, symbolic links and hard links all land on the same file;
 * and it only lets the record go to the Phase 8 folder or the OS temp folder (FIX1B B-M1).
 */
export function outRefusal(
  out: string,
  phasesDir: string,
  io: Pick<AuditCommandIo, "listFiles" | "canonical" | "identity" | "tmpRoot">,
): string | null {
  const canonical = io.canonical ?? ((path: string): string => canonicalPath(path));
  const identity = io.identity ?? realIdentity;
  const target = canonical(resolve(out));
  const targetId = identity(target);
  const listing = io.listFiles(phasesDir);
  for (const evidence of PHASE_EVIDENCE) {
    const folderName = phaseFolder(listing, evidence.phase);
    if (folderName === null) continue;
    for (const entry of evidence.entries) {
      for (const file of entry.files) {
        const path = join(phasesDir, folderName, file);
        const evidenceId = identity(path);
        if (canonical(path) === target) return MSG_OUT_EVIDENCE;
        if (targetId !== null && evidenceId !== null && targetId === evidenceId) {
          return MSG_OUT_EVIDENCE;
        }
      }
    }
  }
  const phase08 = phaseFolder(listing, "08");
  const allowed = [(io.tmpRoot ?? tmpdir)()];
  if (phase08 !== null) allowed.push(join(phasesDir, phase08));
  return allowed.some((root) => isSameOrInside(canonical(resolve(root)), target))
    ? null
    : MSG_OUT_LOCATION;
}

/** Runs the audit and writes the record. Exit codes: 0 fine, 1 a phase is not recorded, 2 usage. */
export async function runAuditCommand(
  args: AuditArgs,
  io: AuditCommandIo,
  write: (line: string) => void,
  hooks: AuditTestHooks = {},
): Promise<number> {
  const knownPhases = PHASE_EVIDENCE.map((entry) => entry.phase);
  if (hooks.only?.some((phase) => !knownPhases.includes(phase))) {
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
    only: hooks.only,
    expectedItems: hooks.expectedItems,
  });

  let outPath = args.out;
  if (outPath === undefined) {
    const phase08 = phaseFolder(io.listFiles(phasesDir), "08");
    if (phase08 === null) throw new UsageError("--out is required when no Phase 8 folder exists.");
    outPath = join(phasesDir, phase08, RECORD_NAME);
  }
  const refusal = outRefusal(outPath, phasesDir, io);
  if (refusal !== null) throw new UsageError(refusal);

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
