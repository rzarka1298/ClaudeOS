import { appendFileSync } from "node:fs";
import type { UatProfile } from "./profile.js";
import type { RunClass } from "./uat-tags.js";

export type TestState = "passed" | "failed" | "skipped" | "pending";

export interface ResultRecord {
  readonly title: string;
  readonly state: TestState;
  readonly durationMs: number;
  /** Sanitised and truncated; empty when the test passed. */
  readonly message: string;
}

export interface LookVerdict {
  readonly item: number;
  readonly verdict: "pass" | "fail";
  readonly images: number;
}

export type ItemStatus =
  | "pass"
  | "fail"
  | "inconclusive"
  | "inconclusive (look pending)"
  | "skipped-profile";

export type ItemResolution =
  | {
      readonly kind: "status";
      readonly item: number;
      readonly status: ItemStatus;
      readonly reason: string;
      /** The first sanitised message of a non-passing matching test, or empty. */
      readonly message: string;
    }
  | {
      readonly kind: "owner";
      readonly item: number;
      readonly partials: readonly ResultRecord[];
    };

export interface StatusInput {
  readonly number: number;
  readonly runClass: RunClass;
  /** True for an item only the full profile runs (the 10,000-task item, D-13). */
  readonly fullProfileOnly?: boolean;
}

export interface ResolveInput {
  readonly item: StatusInput;
  readonly results: readonly ResultRecord[];
  readonly looks: readonly LookVerdict[];
  readonly profile: UatProfile;
  readonly phasePrefix: string;
}

const RECORD_ERROR = "The results file holds a line that is not a valid test record.";
const TEST_STATES: readonly string[] = ["passed", "failed", "skipped", "pending"];
const MESSAGE_MAX_LENGTH = 300;

export function formatResultLine(record: ResultRecord): string {
  return JSON.stringify({
    title: record.title,
    state: record.state,
    durationMs: record.durationMs,
    message: record.message,
  });
}

function asRecord(value: unknown): ResultRecord {
  if (typeof value !== "object" || value === null) throw new Error(RECORD_ERROR);
  const candidate = value as Record<string, unknown>;
  const { title, state, durationMs, message } = candidate;
  if (
    typeof title !== "string" ||
    typeof state !== "string" ||
    !TEST_STATES.includes(state) ||
    typeof durationMs !== "number" ||
    !Number.isFinite(durationMs) ||
    typeof message !== "string"
  ) {
    throw new Error(RECORD_ERROR);
  }
  return { title, state: state as TestState, durationMs, message };
}

/** Reads the JSON-lines results file; a torn final line (no closing newline) is ignored. */
export function parseResultsFile(text: string): ResultRecord[] {
  const lines = text.split("\n");
  const endsWithNewline = text.endsWith("\n");
  const records: ResultRecord[] = [];
  lines.forEach((line, index) => {
    if (line === "") return;
    const isLast = index === lines.length - 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (isLast && !endsWithNewline) return;
      throw new Error(RECORD_ERROR);
    }
    records.push(asRecord(parsed));
  });
  return records;
}

function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The item number in a title that begins `[<phase>-UAT#NN]`, or null. */
export function itemNumberOf(title: string, phasePrefix: string): number | null {
  const match = new RegExp(`^\\[${escapeForPattern(phasePrefix)}-UAT#(\\d{2})\\]`).exec(title);
  return match === null ? null : Number(match[1]);
}

function resolution(
  item: number,
  status: ItemStatus,
  reason: string,
  message = "",
): ItemResolution {
  return { kind: "status", item, status, reason, message };
}

/** Pure status table (D-11): no test is a fail; a look-tier item never passes without a verdict. */
export function resolveItemStatus(input: ResolveInput): ItemResolution {
  const { item, results, looks, profile, phasePrefix } = input;
  const matching = results.filter(
    (entry) => itemNumberOf(entry.title, phasePrefix) === item.number,
  );
  if (item.runClass === "owner") {
    return { kind: "owner", item: item.number, partials: matching };
  }
  if (item.fullProfileOnly === true && profile === "standard") {
    return resolution(item.number, "skipped-profile", "runs only in the full profile");
  }
  if (matching.length === 0) return resolution(item.number, "fail", "no test ran");

  const failed = matching.filter((entry) => entry.state === "failed");
  if (failed.length > 0) {
    return resolution(item.number, "fail", `${failed.length} test(s) failed`, failed[0]?.message);
  }
  const verdict = looks.filter((entry) => entry.item === item.number).at(-1);
  const isLook = item.runClass === "auto+look";
  if (isLook && verdict?.verdict === "fail") {
    return resolution(item.number, "fail", "the look verdict failed");
  }
  const unfinished = matching.filter((entry) => entry.state !== "passed");
  if (unfinished.length > 0) {
    return resolution(
      item.number,
      "inconclusive",
      `${unfinished.length} test(s) did not finish`,
      unfinished[0]?.message,
    );
  }
  if (!isLook) return resolution(item.number, "pass", "all tests passed");
  if (verdict === undefined) {
    return resolution(
      item.number,
      "inconclusive (look pending)",
      "tests passed; no look verdict yet",
    );
  }
  return resolution(item.number, "pass", "all tests passed and the look verdict passed");
}

export interface MochaTestLike {
  readonly title: string;
  readonly state?: string | undefined;
  readonly pending?: boolean | undefined;
  readonly duration?: number | undefined;
  readonly err?: { readonly message?: string | undefined } | undefined;
}

export interface RecorderOptions {
  /** Mocha's afterEach, passed in so the recorder is testable without Mocha. */
  readonly afterEach: (hook: (this: { currentTest?: MochaTestLike }) => void) => void;
  readonly resultsPath: string;
  readonly append?: (path: string, data: string) => void;
  readonly sanitize?: (text: string, options?: { maxLength?: number }) => string;
}

function tidy(text: string, options?: { maxLength?: number }): string {
  const flat = Array.from(text, (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? " " : char;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const limit = options?.maxLength ?? MESSAGE_MAX_LENGTH;
  return flat.length <= limit ? flat : `${flat.slice(0, Math.max(0, limit - 3))}...`;
}

function stateOf(test: MochaTestLike): TestState {
  if (test.pending === true || test.state === "pending") return "skipped";
  if (test.state === "passed") return "passed";
  if (test.state === "failed") return "failed";
  return "pending";
}

/** Appends one result line per finished test; the message goes through the sanitiser. */
export function installResultRecorder(options: RecorderOptions): void {
  const append = options.append ?? ((path: string, data: string) => appendFileSync(path, data));
  const sanitize = options.sanitize ?? tidy;
  options.afterEach(function recordTest(this: { currentTest?: MochaTestLike }) {
    const test = this.currentTest;
    if (test === undefined) return;
    const raw = test.err?.message ?? "";
    const message = raw === "" ? "" : sanitize(raw, { maxLength: MESSAGE_MAX_LENGTH });
    append(
      options.resultsPath,
      `${formatResultLine({
        title: test.title,
        state: stateOf(test),
        durationMs: Math.max(0, Math.round(test.duration ?? 0)),
        message,
      })}\n`,
    );
  });
}
