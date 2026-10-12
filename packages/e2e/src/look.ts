import { chmodSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseReport, updateReportOutcome } from "./report-io.js";
import { resolveItemStatus } from "./results.js";
import type { LookHandoff, LookPendingItem } from "./run-uat.js";
import { assertShotInside, deleteShotsDir, SHOTS_PREFIX, shotPath } from "./screenshots.js";
import { UAT_PHASE_PREFIX } from "./spec-map.js";

/**
 * The look flow (05.2-09, D-11, D-12, E2E-05, T-05.2-41). The run leaves a small state file in the
 * shots folder because the run root is gone by the time Claude has looked. A verdict is accepted
 * only for an item that is pending, only when the stated image count equals the count the spec
 * recorded (and is at least one), and only when every recorded image still exists; then the
 * report row is updated, the images are deleted and the folder goes when nothing is left.
 */

/** The state file the run leaves in the shots folder for the look command. */
export const LOOK_PENDING_FILE = "look-pending.json";

const RUN_ID = /^[A-Za-z0-9-]{1,40}$/;
const LABEL = /^[a-z0-9-]{1,60}$/;
const LOOK_PENDING_STATUS = "inconclusive (look pending)";

const MSG = {
  folder: "The path is not a screenshots folder.",
  none: "No looks are pending in this folder.",
  state: "The look-pending file is not valid.",
  notPending: "That item has no look pending.",
  noImages: "That item recorded no images, so it cannot be passed by a look.",
  count: "The stated image count does not match the count the run recorded.",
  missing: "A recorded image is missing, so no verdict can be recorded.",
  report: "The report cannot take this verdict.",
} as const;

export interface LookState {
  runId: string;
  reportPath: string | null;
  items: LookPendingItem[];
}

export interface VerdictInput {
  shotsDir: string;
  item: number;
  verdict: "pass" | "fail";
  /** The number of images the caller says it looked at. */
  images: number;
}

export interface VerdictResult {
  item: number;
  status: "pass" | "fail";
  remaining: number;
}

function assertShotsFolder(dir: string): void {
  const name = basename(dir);
  if (!name.startsWith(SHOTS_PREFIX) || name.length === SHOTS_PREFIX.length) {
    throw new Error(MSG.folder);
  }
}

function statePath(dir: string): string {
  return join(dir, LOOK_PENDING_FILE);
}

function writeAtomic(path: string, text: string, mode = 0o600): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, text, { mode });
  renameSync(temporary, path);
}

function writeState(dir: string, state: LookState): void {
  const path = statePath(dir);
  writeAtomic(path, `${JSON.stringify(state)}\n`);
  chmodSync(path, 0o600);
}

/** Writes the state file the look command reads, or deletes the folder when no look is pending. */
export function writeLookHandoff(input: LookHandoff): void {
  assertShotsFolder(input.shotsDir);
  if (input.items.length === 0) {
    deleteShotsDir(input.shotsDir);
    return;
  }
  if (!lstatSync(input.shotsDir).isDirectory()) throw new Error(MSG.folder);
  writeState(input.shotsDir, {
    runId: input.runId,
    reportPath: input.reportPath,
    items: input.items,
  });
}

function parseState(text: string): LookState {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(MSG.state);
  }
  const record = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const { runId, reportPath, items } = record;
  if (
    typeof runId !== "string" ||
    !RUN_ID.test(runId) ||
    !(reportPath === null || typeof reportPath === "string") ||
    !Array.isArray(items)
  ) {
    throw new Error(MSG.state);
  }
  const parsed = items.map((entry): LookPendingItem => {
    const candidate = (typeof entry === "object" && entry !== null ? entry : {}) as Record<
      string,
      unknown
    >;
    const { item, labels, count } = candidate;
    if (
      typeof item !== "number" ||
      !Number.isInteger(item) ||
      item < 1 ||
      item > 99 ||
      !Array.isArray(labels) ||
      !labels.every((label) => typeof label === "string" && LABEL.test(label)) ||
      count !== labels.length
    ) {
      throw new Error(MSG.state);
    }
    return { item, labels: labels as string[], count };
  });
  return { runId, reportPath: reportPath as string | null, items: parsed };
}

/** The pending items of a shots folder; throws when the folder holds no look state. */
export function listPending(shotsDir: string): LookState {
  assertShotsFolder(shotsDir);
  const path = statePath(shotsDir);
  let isFile: boolean;
  try {
    isFile = lstatSync(path).isFile();
  } catch {
    throw new Error(MSG.none);
  }
  if (!isFile) throw new Error(MSG.none);
  return parseState(readFileSync(path, "utf8"));
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

export function recordVerdict(input: VerdictInput): VerdictResult {
  const state = listPending(input.shotsDir);
  const entry = state.items.find((candidate) => candidate.item === input.item);
  if (entry === undefined) throw new Error(MSG.notPending);
  if (entry.count < 1) throw new Error(MSG.noImages);
  if (input.images !== entry.count) throw new Error(MSG.count);

  const files = entry.labels.map((label) => shotPath(input.shotsDir, input.item, label));
  for (const file of files) {
    assertShotInside(input.shotsDir, file);
    if (!isRegularFile(file)) throw new Error(MSG.missing);
  }

  // The status comes from the same table the run used, with the verdict as the only new fact.
  let reportText: string | null = null;
  let phasePrefix = UAT_PHASE_PREFIX;
  if (state.reportPath !== null) {
    try {
      reportText = readFileSync(state.reportPath, "utf8");
      const parsed = parseReport(reportText);
      const row = parsed.rows.find((candidate) => candidate.number === input.item);
      if (
        parsed.frontMatter["run-id"] !== state.runId ||
        row === undefined ||
        row.status !== LOOK_PENDING_STATUS
      ) {
        throw new Error(MSG.report);
      }
      phasePrefix = parsed.frontMatter.phase ?? UAT_PHASE_PREFIX;
    } catch {
      throw new Error(MSG.report);
    }
  }
  const resolution = resolveItemStatus({
    item: { number: input.item, runClass: "auto+look" },
    results: [
      {
        title: `[${phasePrefix}-UAT#${String(input.item).padStart(2, "0")}] look`,
        state: "passed",
        durationMs: 0,
        message: "",
      },
    ],
    looks: [{ item: input.item, verdict: input.verdict, images: input.images }],
    profile: "standard",
    phasePrefix,
  });
  if (
    resolution.kind !== "status" ||
    (resolution.status !== "pass" && resolution.status !== "fail")
  ) {
    throw new Error(MSG.report);
  }
  const status = resolution.status;

  if (state.reportPath !== null && reportText !== null) {
    const note = status === "pass" ? "the look verdict passed" : "the look verdict failed";
    writeAtomic(state.reportPath, updateReportOutcome(reportText, input.item, status, note), 0o644);
  }
  for (const file of files) unlinkSync(file);

  const remaining = state.items.filter((candidate) => candidate.item !== input.item);
  if (remaining.length === 0) deleteShotsDir(input.shotsDir);
  else writeState(input.shotsDir, { ...state, items: remaining });
  return { item: input.item, status, remaining: remaining.length };
}
