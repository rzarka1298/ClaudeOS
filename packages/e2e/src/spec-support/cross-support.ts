import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_DATA_KEYS } from "../plugin-data.js";
import { shotPath } from "../screenshots.js";
import { DESTINATION_IDS } from "./cross-copy.js";

/**
 * Pure helpers and thin file readers for the cross-cutting specs (05.2-08). Nothing here
 * imports wdio, Obsidian or the plugin; the specs pass in what they read from the page.
 */

// --- counting (06-UAT test 25) -------------------------------------------------------------

/** Non-overlapping, case-sensitive count; a zero-length needle is a programming error. */
export function countOccurrences(text: string, needle: string): number {
  if (needle.length === 0) throw new Error("countOccurrences needs a non-empty needle.");
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

// --- the plugin settings file (06-UAT test 25) ----------------------------------------------

/** No value in the settings file other than the socket path may be longer than this. */
const SHORT_VALUE_MAX = 40;
const MOTION_VALUES: readonly string[] = ["auto", "reduced"];

/**
 * Problems with the plugin's persisted settings, as fixed codes (never a value, so request or
 * task text found here cannot be echoed into a report). Empty means: exactly the four settings
 * keys, each with a value of the expected small shape.
 */
export function checkPluginDataKeys(data: unknown, options: { socketPath: string }): string[] {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return ["not-an-object"];
  const record = data as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(record)) {
    if (!PLUGIN_DATA_KEYS.includes(key)) problems.push("extra-key");
  }
  for (const key of PLUGIN_DATA_KEYS) {
    if (!(key in record)) problems.push("missing-key");
  }
  const socket = record.socketPathOverride;
  if (socket !== undefined && socket !== null && socket !== options.socketPath) {
    problems.push("bad-value:socketPathOverride");
  }
  const destination = record.lastOpenedDestination;
  if (
    destination !== undefined &&
    !(
      typeof destination === "string" &&
      (DESTINATION_IDS as readonly string[]).includes(destination)
    )
  ) {
    problems.push("bad-value:lastOpenedDestination");
  }
  const motion = record.reducedMotion;
  if (motion !== undefined && !(typeof motion === "string" && MOTION_VALUES.includes(motion))) {
    problems.push("bad-value:reducedMotion");
  }
  const notify = record.notifyApprovals;
  if (notify !== undefined && typeof notify !== "boolean") {
    problems.push("bad-value:notifyApprovals");
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === "socketPathOverride") continue;
    if (typeof value === "string" && value.length > SHORT_VALUE_MAX) {
      problems.push(`long-string:${PLUGIN_DATA_KEYS.includes(key) ? key : "extra"}`);
    }
  }
  return problems;
}

// --- the pending-look record (D-11, T-05.2-32) -----------------------------------------------

export interface LookPendingRecord {
  item: number;
  labels: string[];
  count: number;
}

const LOOK_PENDING_FILE = "look-pending.jsonl";

function lookPendingPath(runRoot: string): string {
  return join(runRoot, LOOK_PENDING_FILE);
}

/** Reads the records in file order; an absent file is none and a torn last line is ignored. */
export function readLookPending(runRoot: string): LookPendingRecord[] {
  const file = lookPendingPath(runRoot);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n");
  const records: LookPendingRecord[] = [];
  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (index >= lines.length - 2) return;
      throw new Error("The pending-look file holds a malformed line.");
    }
    const entry = parsed as Partial<LookPendingRecord> | null;
    if (
      entry === null ||
      typeof entry !== "object" ||
      !Number.isInteger(entry.item) ||
      !Array.isArray(entry.labels) ||
      !entry.labels.every((label) => typeof label === "string")
    ) {
      throw new Error("The pending-look file holds an invalid record.");
    }
    records.push({
      item: entry.item as number,
      labels: [...entry.labels],
      count: entry.labels.length,
    });
  });
  return records;
}

/**
 * Tells the runner which images await Claude's verdict for an item (D-11). The file lives in the
 * run root and holds the item number, the image labels and their count only: no path, no
 * content. One line per item; recording the same label twice changes nothing and new labels are
 * merged in. Labels follow the shot-label rule of screenshots.ts (lowercase letters, digits and
 * hyphens), which is checked by asking shotPath to build a name from each.
 */
export function recordLookPending(input: {
  runRoot: string;
  item: number;
  labels: readonly string[];
}): LookPendingRecord {
  if (!Number.isInteger(input.item) || input.item < 1 || input.item > 99) {
    throw new Error("The look item number must be an integer from 1 to 99.");
  }
  if (input.labels.length === 0) throw new Error("A pending look needs at least one image label.");
  for (const label of input.labels) shotPath("/shots-check", input.item, label);
  const records = readLookPending(input.runRoot);
  const existing = records.find((record) => record.item === input.item);
  const merged = existing ?? { item: input.item, labels: [], count: 0 };
  for (const label of input.labels) {
    if (!merged.labels.includes(label)) merged.labels.push(label);
  }
  merged.count = merged.labels.length;
  if (existing === undefined) records.push(merged);
  const file = lookPendingPath(input.runRoot);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, records.map((record) => `${JSON.stringify(record)}\n`).join(""), {
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
  return { ...merged, labels: [...merged.labels] };
}
