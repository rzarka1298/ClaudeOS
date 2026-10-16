import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertVaultInsideRunRoot, type NoteFile, parseNoteFrontmatter } from "./tasks-support.js";

/**
 * Pure readers and checks over the notes and store rows of a research run (plan 07-17, RSRCH-02,
 * RSRCH-03, RSRCH-06). The service writes these notes in fixed shapes (the run note, the raw
 * snapshot, the wiki note, the report), so a spec reads them as text and checks the facts the UAT
 * items name; nothing here is a general YAML or Markdown parser, and none of it touches Obsidian.
 * The unit tests run these over notes the REAL pipeline wrote (samples copied from a run against
 * the built service), so a changed note shape fails here before it fails a live run.
 */

// ---------------------------------------------------------------------------
// Reading the sandbox vault

/** The folders of the managed vault a research run writes to, relative to the vault root. */
export const RESEARCH_FOLDERS = {
  raw: "global/raw",
  wiki: "global/wiki",
  output: "global/output",
  runs: "automation-runs",
} as const;

/**
 * Every `.md` file directly in a managed folder of the sandbox vault (the generated `index.md`
 * excluded), after the vault has been checked against the run root. A folder that does not exist
 * yet is empty.
 */
export function readFolderNotes(
  vaultPath: string,
  runRoot: string,
  folder: (typeof RESEARCH_FOLDERS)[keyof typeof RESEARCH_FOLDERS],
): NoteFile[] {
  assertVaultInsideRunRoot(vaultPath, runRoot);
  const dir = join(vaultPath, folder);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".md") && name !== "index.md")
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => ({
      path: `${folder}/${name}`,
      name,
      text: readFileSync(join(dir, name), "utf8"),
    }));
}

// ---------------------------------------------------------------------------
// Small text helpers

function unquote(value: string | undefined): string {
  if (value === undefined) return "";
  const quote = value[0];
  if ((quote === "'" || quote === '"') && value.length >= 2 && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  return value;
}

/** The text between the first pair of frontmatter fences, or null for a note without one. */
function frontmatterOf(text: string): string[] | null {
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  return end < 0 ? null : lines.slice(1, end);
}

/** The lines after the closing frontmatter fence. */
function bodyOf(text: string): string[] {
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (lines[0] !== "---") return lines;
  const end = lines.indexOf("---", 1);
  return end < 0 ? lines : lines.slice(end + 1);
}

/** The values of every inline-code span of a line, trimmed (`` ` id ` `` gives `id`). */
function codeSpans(line: string): string[] {
  return [...line.matchAll(/`([^`]+)`/g)].map((match) => (match[1] as string).trim());
}

/** The note's top-level scalar `key`, unquoted, or null. */
export function scalarOf(text: string, key: string): string | null {
  const parsed = parseNoteFrontmatter(text);
  if (!parsed.ok) return null;
  const value = parsed.map[key];
  return value === undefined ? null : unquote(value);
}

/** The stage and id of a managed note, from its frontmatter. */
export function noteHead(text: string): {
  id: string | null;
  stage: string | null;
  type: string | null;
} {
  return { id: scalarOf(text, "id"), stage: scalarOf(text, "stage"), type: scalarOf(text, "type") };
}

// ---------------------------------------------------------------------------
// The run note

export interface ParsedRunStage {
  readonly stage: string;
  readonly at: string;
  readonly noteIds: readonly string[];
}

export interface ParsedRunNote {
  readonly runId: string | null;
  readonly outcome: string | null;
  readonly trigger: string | null;
  readonly started: string | null;
  readonly ended: string | null;
  readonly error: string | null;
  readonly report: string | null;
  readonly stages: readonly ParsedRunStage[];
  /** `{label}: {words}` of the Sources section, in order. */
  readonly sources: readonly { readonly label: string; readonly words: string }[];
}

/** Reads `automation-runs/<run id>.md` (see `renderRunNote` in the service). */
export function parseRunNote(text: string): ParsedRunNote {
  const lines = bodyOf(text);
  const field = (name: string): string | null => {
    const line = lines.find((entry) => entry.startsWith(`- ${name}: `));
    if (line === undefined) return null;
    const spans = codeSpans(line);
    return spans[0] ?? line.slice(`- ${name}: `.length).trim();
  };
  const heading = lines.find((line) => line.startsWith("# Research run "));
  const stages: ParsedRunStage[] = [];
  const sources: { label: string; words: string }[] = [];
  let section = "";
  for (const line of lines) {
    if (line.startsWith("## ")) {
      section = line.slice(3).trim();
      continue;
    }
    if (section === "Stages") {
      const match = /^\d+\. (.+?) at (.+?): (.*)$/.exec(line);
      if (match === null) continue;
      const stage = codeSpans(match[1] as string)[0];
      const at = codeSpans(match[2] as string)[0];
      if (stage === undefined || at === undefined) continue;
      const produced = match[3] as string;
      stages.push({
        stage,
        at,
        noteIds: produced.startsWith("notes ") ? codeSpans(produced) : [],
      });
    } else if (section === "Sources" && line.startsWith("- ")) {
      const split = line.slice(2).lastIndexOf(": ");
      if (split < 0) continue;
      const rest = line.slice(2);
      sources.push({ label: rest.slice(0, split), words: rest.slice(split + 2) });
    }
  }
  return {
    runId: heading === undefined ? null : (codeSpans(heading)[0] ?? null),
    outcome:
      lines.find((line) => line.startsWith("- Outcome: "))?.slice("- Outcome: ".length) ?? null,
    trigger:
      lines.find((line) => line.startsWith("- Trigger: "))?.slice("- Trigger: ".length) ?? null,
    started: field("Started"),
    ended: field("Ended"),
    error: field("Error"),
    report: field("Report"),
    stages,
    sources,
  };
}

// ---------------------------------------------------------------------------
// The store's stage log

export interface StageLogEntry {
  readonly stage: string;
  readonly at: string;
  readonly noteIds: readonly string[];
}

/** Parses the `stage_log` column; anything that is not an array of stage entries is `null`. */
export function parseStageLog(json: unknown): StageLogEntry[] | null {
  if (typeof json !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const entries: StageLogEntry[] = [];
  for (const item of value) {
    const entry = item as { stage?: unknown; at?: unknown; noteIds?: unknown } | null;
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.stage !== "string" ||
      typeof entry.at !== "string" ||
      !Array.isArray(entry.noteIds) ||
      !entry.noteIds.every((id) => typeof id === "string")
    ) {
      return null;
    }
    entries.push({ stage: entry.stage, at: entry.at, noteIds: entry.noteIds as string[] });
  }
  return entries;
}

/** The six lifecycle stages of a run that wrote a report, in order (D-12). */
export const RUN_STAGES = ["capture", "raw", "synthesis", "wiki", "deliverable", "output"] as const;

export type TraceVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly problems: string[] };

/**
 * One run traced end to end (07-UAT item 3, SC1): the run note lists the six stages in order with
 * increasing instants, the same stages the store holds (stage, instant and note ids), and every
 * note id a stage names exists in the vault with the stage the lifecycle gives it: raw notes
 * `raw`, wiki notes `wiki`, the report `output`.
 */
export function checkRunTrace(input: {
  readonly runNote: ParsedRunNote;
  readonly stageLog: readonly StageLogEntry[] | null;
  /** Every managed note of the vault by its id. */
  readonly stageOfNote: ReadonlyMap<string, string | null>;
}): TraceVerdict {
  const problems: string[] = [];
  const { runNote, stageLog, stageOfNote } = input;
  const names = runNote.stages.map((entry) => entry.stage);
  if (names.join(",") !== RUN_STAGES.join(",")) {
    problems.push(`the run note lists the stages ${names.join(", ") || "(none)"}`);
  }
  for (let index = 1; index < runNote.stages.length; index += 1) {
    const before = Date.parse((runNote.stages[index - 1] as ParsedRunStage).at);
    const now = Date.parse((runNote.stages[index] as ParsedRunStage).at);
    if (!Number.isFinite(before) || !Number.isFinite(now) || now < before) {
      problems.push(
        `the stage ${(runNote.stages[index] as ParsedRunStage).stage} has no later instant`,
      );
    }
  }
  if (stageLog === null) {
    problems.push("the store holds no readable stage log");
  } else {
    const same =
      stageLog.length === runNote.stages.length &&
      stageLog.every((entry, index) => {
        const noted = runNote.stages[index] as ParsedRunStage;
        return (
          entry.stage === noted.stage &&
          entry.at === noted.at &&
          entry.noteIds.join(",") === noted.noteIds.join(",")
        );
      });
    if (!same) problems.push("the store's stage log differs from the run note");
  }
  const expectedStage: Readonly<Record<string, string>> = {
    raw: "raw",
    wiki: "wiki",
    deliverable: "output",
    output: "output",
  };
  for (const entry of runNote.stages) {
    const want = expectedStage[entry.stage];
    if (want === undefined) {
      if (entry.noteIds.length > 0) problems.push(`the stage ${entry.stage} names notes`);
      continue;
    }
    if (entry.noteIds.length === 0) problems.push(`the stage ${entry.stage} names no note`);
    for (const id of entry.noteIds) {
      const stage = stageOfNote.get(id);
      if (stage !== want) {
        problems.push(`a ${entry.stage} note is stage ${stage ?? "missing"}, not ${want}`);
      }
    }
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

// ---------------------------------------------------------------------------
// The report note

export interface ParsedReportNote {
  readonly stage: string | null;
  readonly type: string | null;
  readonly jobRunId: string | null;
  readonly partial: string | null;
  readonly sourceTotal: string | null;
  /** The kind of each entry of the frontmatter `items` list, in order. */
  readonly itemKinds: readonly string[];
  /** One map of key to value per entry of `sourceRefs`. */
  readonly sourceRefs: readonly Record<string, string>[];
  /** How often each kind label appears as a bold label in the body. */
  readonly bodyLabels: Readonly<Record<string, number>>;
  /** The sentence that counts the findings, or null. */
  readonly countsLine: string | null;
  /** The vault-relative snapshot path of each source entry. */
  readonly snapshotPaths: readonly string[];
}

/** The block of lines under a top-level key, up to the next top-level key. */
function blockOf(front: readonly string[], key: string): string[] {
  const start = front.findIndex((line) => line === `${key}:` || line.startsWith(`${key}: `));
  if (start < 0) return [];
  const block: string[] = [];
  for (const line of front.slice(start + 1)) {
    if (/^[A-Za-z_]/.test(line)) break;
    block.push(line);
  }
  return block;
}

/** Reads the fields of a report note that items 3, 4 and 5 check (see `renderReportNote`). */
export function parseReportNote(
  text: string,
  kindLabels: Readonly<Record<string, string>>,
): ParsedReportNote {
  const front = frontmatterOf(text) ?? [];
  const sourceRefs: Record<string, string>[] = [];
  for (const line of blockOf(front, "sourceRefs")) {
    const entry = /^ {2}- ([A-Za-z]+): ?(.*)$/.exec(line);
    if (entry !== null) {
      sourceRefs.push({ [entry[1] as string]: unquote((entry[2] as string).trim()) });
      continue;
    }
    const field = /^ {4}([A-Za-z]+): ?(.*)$/.exec(line);
    if (field !== null && sourceRefs.length > 0) {
      (sourceRefs[sourceRefs.length - 1] as Record<string, string>)[field[1] as string] = unquote(
        (field[2] as string).trim(),
      );
    }
  }
  const itemKinds = blockOf(front, "items")
    .map((line) => /^ {2}- kind: (.+)$/.exec(line)?.[1])
    .filter((kind): kind is string => kind !== undefined);
  const body = bodyOf(text).join("\n");
  const bodyLabels: Record<string, number> = {};
  for (const [kind, label] of Object.entries(kindLabels)) {
    // The legend and each finding write the label in bold; the counts line writes it in words.
    bodyLabels[kind] = body.split(`**${label}**`).length - 1;
  }
  return {
    stage: scalarOf(text, "stage"),
    type: scalarOf(text, "type"),
    jobRunId: scalarOf(text, "jobRunId"),
    partial: scalarOf(text, "partial"),
    sourceTotal: scalarOf(text, "sourceTotal"),
    itemKinds,
    sourceRefs,
    bodyLabels,
    countsLine:
      bodyOf(text).find((line) => / findings?: /.test(line) && /model inferences?\.$/.test(line)) ??
      null,
    snapshotPaths: sourceRefs.map((entry) => entry.snapshotPath ?? ""),
  };
}

/** The `sourceRefs` fields the PRD 10.1 reference carries, in the schema's order. */
export const SOURCE_REF_FIELDS = [
  "sourceType",
  "id",
  "title",
  "canonicalUrl",
  "author",
  "publishedAt",
  "retrievedAt",
  "contentHash",
  "snapshotPath",
  "accessClass",
] as const;

/** The fields of the PRD 10.1 reference a `sourceRefs` entry does not carry. */
export function missingSourceRefFields(entry: Readonly<Record<string, string>>): string[] {
  const missing: string[] = SOURCE_REF_FIELDS.filter(
    (field) => field !== "canonicalUrl" && !(field in entry),
  );
  // Exactly one of the two addresses is carried; a public source has the https one.
  if (!("canonicalUrl" in entry) && !("deepLink" in entry)) missing.push("canonicalUrl");
  return missing;
}

// ---------------------------------------------------------------------------
// The raw snapshot note

export interface ParsedRawNote {
  readonly stage: string | null;
  readonly type: string | null;
  /** The source reference's title: the owner's label for the source. */
  readonly title: string | null;
  readonly snapshotPath: string | null;
  readonly contentHash: string | null;
  /** The counts of the `sanitise` block. */
  readonly sanitise: Readonly<Record<string, number>>;
  /** The first line of the body: the banner. */
  readonly banner: string | null;
  /** The text inside the fence, or null when the body holds no fenced block. */
  readonly fenced: string | null;
  /** The body text outside the fence and the banner. */
  readonly outside: string;
}

/** Reads a `global/raw` note (see `renderRawSourceNote`). */
export function parseRawNote(text: string): ParsedRawNote {
  const front = frontmatterOf(text) ?? [];
  const sanitise: Record<string, number> = {};
  for (const line of blockOf(front, "sanitise")) {
    const match = /^ {2}([A-Za-z]+): (\d+)$/.exec(line);
    if (match !== null) sanitise[match[1] as string] = Number(match[2]);
  }
  const refBlock = blockOf(front, "sourceRef");
  const refValue = (key: string): string | null => {
    const line = refBlock.find((entry) => entry.startsWith(`  ${key}: `));
    return line === undefined ? null : unquote(line.slice(`  ${key}: `.length).trim());
  };
  const body = bodyOf(text);
  const banner = body.find((line) => line.trim() !== "") ?? null;
  const open = body.findIndex((line) => /^~{3,}text$/.test(line));
  let fenced: string | null = null;
  const outside: string[] = [];
  if (open >= 0) {
    const fence = (body[open] as string).replace("text", "");
    const close = body.findIndex((line, index) => index > open && line === fence);
    if (close > open) {
      fenced = body.slice(open + 1, close).join("\n");
      outside.push(...body.slice(0, open), ...body.slice(close + 1));
    }
  }
  if (fenced === null) outside.push(...body);
  return {
    stage: scalarOf(text, "stage"),
    type: scalarOf(text, "type"),
    title: refValue("title"),
    snapshotPath: refValue("snapshotPath"),
    contentHash: refValue("contentHash"),
    sanitise,
    banner,
    fenced,
    outside: outside
      .filter((line) => line !== banner)
      .join("\n")
      .trim(),
  };
}

/** The total of a note's `sanitise` counts. */
export function totalRemoved(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}
