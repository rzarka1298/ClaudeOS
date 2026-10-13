import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { isStrictlyInside, PLUGIN_DATA_KEYS } from "../plugin-data.js";
import { shotPath } from "../screenshots.js";
import { ALWAYS_ALLOW_PHRASES, APPROVE_LABEL, DENY_LABEL, DESTINATION_IDS } from "./cross-copy.js";

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

// --- the no-always-allow walk (06-UAT test 12) ------------------------------------------------

export interface AlwaysAllowHit {
  phrase: string;
  source: string;
}

function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-word, case-insensitive scan for wording that would offer to remember, always allow,
 * allow all, trust or skip approvals. A word that merely contains a phrase (untrusted, skipper,
 * remembered) is not a hit. Only the listed phrases are caught, which is why the look tier also
 * has Claude read screenshots of the same places.
 */
export function scanForAlwaysAllow(
  texts: ReadonlyArray<{ label: string; text: string }>,
): AlwaysAllowHit[] {
  const hits: AlwaysAllowHit[] = [];
  for (const { label, text } of texts) {
    for (const phrase of ALWAYS_ALLOW_PHRASES) {
      const pattern = new RegExp(
        `(?<![\\p{L}\\p{N}_])${escapePattern(phrase)}(?![\\p{L}\\p{N}_])`,
        "iu",
      );
      if (pattern.test(text)) hits.push({ phrase, source: label });
    }
  }
  return hits;
}

// --- reduced motion (06-UAT test 23) ------------------------------------------------------------

export interface MotionSample {
  transitionDuration: string;
  animationDuration: string;
  animationName: string;
}

/** Seconds in a computed duration list like "0s, 120ms"; anything unreadable counts as positive. */
function durationsOf(list: string): number[] {
  return list.split(",").map((part) => {
    const match = /^\s*(\d*\.?\d+)(ms|s)\s*$/.exec(part);
    if (match === null) return Number.POSITIVE_INFINITY;
    const value = Number(match[1]);
    return match[2] === "ms" ? value / 1000 : value;
  });
}

function sampleIsOff(sample: MotionSample): boolean {
  if (!durationsOf(sample.transitionDuration).every((seconds) => seconds === 0)) return false;
  const named = sample.animationName.split(",").some((name) => name.trim() !== "none");
  if (!named) return true;
  return durationsOf(sample.animationDuration).every((seconds) => seconds === 0);
}

/** True only when at least one element was sampled and every one computes to no motion. */
export function allMotionOff(styles: readonly MotionSample[]): boolean {
  return styles.length > 0 && styles.every(sampleIsOff);
}

/** True when any sampled element still moves; it proves the sampling can see motion at all. */
export function anyMotionOn(styles: readonly MotionSample[]): boolean {
  return styles.some((sample) => !sampleIsOff(sample));
}

/** A state change must still be announced: the polite live region is non-empty. */
export function motionAnnouncementPresent(liveText: string): boolean {
  return liveText.trim().length > 0;
}

// --- keyboard focus (06-UAT test 22) --------------------------------------------------------------

export interface FocusRingStyle {
  outlineStyle: string;
  outlineWidth: string;
  boxShadow: string;
}

/** A drawn outline (a style other than none or hidden and a positive width) or a box shadow. */
export function focusRingVisible(style: FocusRingStyle): boolean {
  const width = Number.parseFloat(style.outlineWidth);
  const outline =
    style.outlineStyle !== "none" &&
    style.outlineStyle !== "hidden" &&
    Number.isFinite(width) &&
    width > 0;
  const shadow = style.boxShadow.trim() !== "" && style.boxShadow.trim() !== "none";
  return outline || shadow;
}

/** A recorded accessible name matches a token when it is the token or starts `token:` or `token,`. */
function nameMatches(entry: string, token: string): boolean {
  return entry === token || entry.startsWith(`${token}:`) || entry.startsWith(`${token},`);
}

/** The expected names must occur in order (not necessarily adjacent) in the recorded sequence. */
export function checkFocusOrder(
  recorded: readonly string[],
  expected: readonly string[],
): { ok: boolean; reason: string } {
  let from = 0;
  for (const token of expected) {
    const at = recorded.findIndex((entry, index) => index >= from && nameMatches(entry, token));
    if (at === -1) {
      return { ok: false, reason: `Focus never reached "${token}" in the expected order.` };
    }
    from = at + 1;
  }
  return { ok: true, reason: "" };
}

/** Inside an opened request the first decision control focused must be Deny, never Approve once. */
export function firstFocusInRequestIsDeny(recorded: readonly string[]): boolean {
  const first = recorded.find(
    (entry) => nameMatches(entry, DENY_LABEL) || nameMatches(entry, APPROVE_LABEL),
  );
  return first !== undefined && nameMatches(first, DENY_LABEL);
}

// --- completing a task changes nothing outside the note (06-UAT test 20) ------------------------

export interface FileDiff {
  changed: string[];
  added: string[];
  removed: string[];
}

const IGNORED_VAULT_PREFIX = ".obsidian/";

/** Changed, added and removed vault paths between two path-to-hash maps, ignoring .obsidian. */
export function diffFileHashes(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): FileDiff {
  const kept = (path: string): boolean => !path.startsWith(IGNORED_VAULT_PREFIX);
  const beforePaths = Object.keys(before).filter(kept);
  const afterPaths = Object.keys(after).filter(kept);
  return {
    changed: beforePaths.filter((path) => path in after && after[path] !== before[path]).sort(),
    added: afterPaths.filter((path) => !(path in before)).sort(),
    removed: beforePaths.filter((path) => !(path in after)).sort(),
  };
}

/** sha-256 per file of a vault copy, `/`-separated relative paths; .obsidian and links are skipped. */
export function hashVaultFiles(root: string, runRoot: string): Record<string, string> {
  if (!isStrictlyInside(runRoot, root)) {
    throw new Error("Refusing to hash a vault that is not inside the run root.");
  }
  const hashes: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const relative = prefix === "" ? entry : `${prefix}/${entry}`;
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (relative !== ".obsidian") walk(full, relative);
      } else if (stat.isFile()) {
        hashes[relative] = createHash("sha256").update(readFileSync(full)).digest("hex");
      }
    }
  };
  walk(root, "");
  return hashes;
}

export interface ProcessNode {
  pid: number;
  ppid: number;
  command: string;
}

/** Parses `ps -axo pid=,ppid=,command=`; blank and malformed lines are ignored. */
export function parseTreeListing(output: string): ProcessNode[] {
  const nodes: ProcessNode[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S.*)$/.exec(line);
    if (match === null) continue;
    nodes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: (match[3] ?? "").trimEnd(),
    });
  }
  return nodes;
}

/** The current process tree, read through an argv array (no shell). */
export async function readProcessTree(): Promise<ProcessNode[]> {
  const run = promisify(execFile);
  const { stdout } = await run("ps", ["-axo", "pid=,ppid=,command="], {
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseTreeListing(stdout);
}

/** Chromium and Electron child processes of the sandbox Obsidian are expected and ignored. */
const HELPER_PROCESS = /\bHelper\b|--type=/;

/**
 * Processes present in `after` and not in `before` (by pid and command) that sit below one of the
 * ancestor pids, excluding the ancestors themselves and Electron helper processes.
 */
export function diffNewDescendants(
  before: readonly ProcessNode[],
  after: readonly ProcessNode[],
  ancestors: readonly number[],
): ProcessNode[] {
  const known = new Set(before.map((node) => `${node.pid}:${node.command}`));
  const byPid = new Map(after.map((node) => [node.pid, node]));
  const roots = new Set(ancestors);
  const below = (node: ProcessNode): boolean => {
    let current: ProcessNode | undefined = byPid.get(node.ppid);
    for (let depth = 0; current !== undefined && depth < 64; depth += 1) {
      if (roots.has(current.pid)) return true;
      current = byPid.get(current.ppid);
    }
    return roots.has(node.ppid);
  };
  return after
    .filter((node) => !roots.has(node.pid))
    .filter((node) => !known.has(`${node.pid}:${node.command}`))
    .filter((node) => !HELPER_PROCESS.test(node.command))
    .filter(below)
    .sort((a, b) => a.pid - b.pid);
}

// --- renderer functions (run in the page through browser.execute) ----------------------------------
// Each one is SELF-CONTAINED, as in renderer-spies.ts: wdio serialises the body with toString(),
// so no outer variable, helper or named inner function may be used (a transpiler's name helper
// would be undefined in the page). Callbacks are inline arguments only.

interface RNode {
  textContent: string | null;
  innerText?: string;
  tagName: string;
  getAttribute(name: string): string | null;
  matches(selector: string): boolean;
  closest(selector: string): RNode | null;
  querySelector(selector: string): RNode | null;
  querySelectorAll(selector: string): ArrayLike<RNode>;
  parentElement: RNode | null;
  nextElementSibling: RNode | null;
}
interface RDocument {
  activeElement: RNode | null;
  body: RNode;
  querySelector(selector: string): RNode | null;
  querySelectorAll(selector: string): ArrayLike<RNode>;
}
declare const document: RDocument;
declare function getComputedStyle(node: RNode): {
  transitionDuration: string;
  animationDuration: string;
  animationName: string;
  outlineStyle: string;
  outlineWidth: string;
  boxShadow: string;
};

/** Up to three computed motion samples per selector, and the root's data-motion attribute. */
export function sampleMotionInRenderer(selectors: string[]): {
  rootMotion: string | null;
  samples: MotionSample[];
} {
  const root = document.querySelector(".ccc-command-center");
  const samples: MotionSample[] = [];
  for (const selector of selectors) {
    const nodes = document.querySelectorAll(selector);
    for (let index = 0; index < nodes.length && index < 3; index += 1) {
      const style = getComputedStyle(nodes[index] as RNode);
      samples.push({
        transitionDuration: style.transitionDuration,
        animationDuration: style.animationDuration,
        animationName: style.animationName,
      });
    }
  }
  return { rootMotion: root === null ? null : root.getAttribute("data-motion"), samples };
}

/** The text of every polite live region on the page. */
export function readLiveRegionsInRenderer(): string[] {
  const texts: string[] = [];
  const nodes = document.querySelectorAll('[role="status"], [aria-live="polite"]');
  for (let index = 0; index < nodes.length; index += 1) {
    texts.push(((nodes[index] as RNode).textContent ?? "").trim());
  }
  return texts;
}

/** The rendered text of the first element matching the selector, or an empty string. */
export function readTextInRenderer(selector: string): string {
  const node = document.querySelector(selector);
  return node === null ? "" : (node.innerText ?? node.textContent ?? "");
}

/**
 * The text of each named settings group: the nearest group container of the row whose name is the
 * heading, or, without one, the heading row and the rows that follow it up to the next heading.
 * Throws when a heading is not found, so a changed settings layout fails loudly.
 */
export function readSettingsGroupsInRenderer(headings: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const names = document.querySelectorAll(".setting-item-name");
  for (const heading of headings) {
    let found: RNode | null = null;
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index] as RNode;
      if ((name.textContent ?? "").trim() === heading) found = name;
    }
    if (found === null) throw new Error("A settings group heading was not found.");
    const group = found.closest(".setting-group");
    if (group !== null) {
      result[heading] = group.innerText ?? group.textContent ?? "";
      continue;
    }
    let row: RNode | null = found.closest(".setting-item");
    let text = "";
    while (row !== null) {
      text += `${row.innerText ?? row.textContent ?? ""}\n`;
      row = row.nextElementSibling;
      if (row?.matches(".setting-item-heading")) break;
    }
    result[heading] = text;
  }
  return result;
}

export interface FocusRecord {
  name: string;
  tag: string;
  focusVisible: boolean;
  /** The element's class attribute, so a spec can tell a request row from a chip. */
  classes: string;
  ring: FocusRingStyle;
}

/** The focused element's accessible name (aria-label, else text) and its computed focus style. */
export function recordFocusInRenderer(): FocusRecord | null {
  const element = document.activeElement;
  if (element === null || element === document.body) return null;
  const label = element.getAttribute("aria-label");
  const text = (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
  const style = getComputedStyle(element);
  return {
    name:
      label !== null && label !== "" ? label : text !== "" ? text : element.tagName.toLowerCase(),
    tag: element.tagName.toLowerCase(),
    focusVisible: element.matches(":focus-visible"),
    classes: element.getAttribute("class") ?? "",
    ring: {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      boxShadow: style.boxShadow,
    },
  };
}
