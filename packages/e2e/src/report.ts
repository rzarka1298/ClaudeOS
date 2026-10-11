import { join } from "node:path";
import type { UatProfile } from "./profile.js";
import type { ItemResolution } from "./results.js";
import type { RunClass } from "./uat-tags.js";

export interface ReportRow {
  readonly number: number;
  readonly title: string;
  readonly runClass: RunClass;
  readonly resolution: ItemResolution;
}

export interface ReportInput {
  readonly runId: string;
  readonly profile: UatProfile;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly appVersion: string;
  readonly installerVersion: string;
  readonly gitHead: string;
  readonly gitClean: boolean;
  /** Exactly twelve hex characters. */
  readonly buildHash: string;
  readonly phasePrefix: string;
  readonly rows: readonly ReportRow[];
}

const CELL_MAX_LENGTH = 200;
const BUILD_HASH_ERROR = "The report needs a twelve-character hexadecimal build hash.";
const RUN_ID_ERROR = "The report needs an eight-character hexadecimal run id.";

type SanitizeFn = (text: string, options?: { homeDir?: string; maxLength?: number }) => string;

/** Replaced by the real sanitiser in the next task; until then it only collapses and truncates. */
const sanitizeText: SanitizeFn = (text, options) => {
  const flat = text.replace(/\s+/g, " ").trim();
  const limit = options?.maxLength ?? CELL_MAX_LENGTH;
  return flat.length <= limit ? flat : `${flat.slice(0, Math.max(0, limit - 3))}...`;
};

/** Text only (PRIV-04): no markdown image, no data URL, and nothing that breaks a table cell. */
function plain(text: string, maxLength: number = CELL_MAX_LENGTH): string {
  return sanitizeText(text, { maxLength })
    .replace(/data:[a-z]+\/[a-z0-9.+-]+[^\s)]*/gi, "[data-url]")
    .replace(/!\[/g, "[")
    .replace(/</g, "(")
    .replace(/\|/g, "\\|");
}

function noteFor(row: ReportRow): string {
  if (row.resolution.kind === "owner") {
    const count = row.resolution.partials.length;
    return count === 0
      ? "owner run; no automated partial"
      : `owner run; ${count} automated partial(s) listed below`;
  }
  const { reason, message } = row.resolution;
  return plain(message === "" ? reason : `${reason}: ${message}`);
}

function statusFor(row: ReportRow): string {
  return row.resolution.kind === "owner" ? "owner" : row.resolution.status;
}

/** Deterministic text-only report: no clock reads, no image reference (D-10, E2E-07, PRIV-04). */
export function renderReport(input: ReportInput): string {
  if (!/^[0-9a-f]{12}$/.test(input.buildHash)) throw new Error(BUILD_HASH_ERROR);
  if (!/^[0-9a-f]{8}$/.test(input.runId)) throw new Error(RUN_ID_ERROR);
  const rows = [...input.rows].sort((a, b) => a.number - b.number);
  const autoRows = rows.filter((row) => row.runClass !== "owner");
  const count = (status: string) =>
    autoRows.filter((row) => row.resolution.kind === "status" && row.resolution.status === status)
      .length;
  const ownerRows = rows.filter((row) => row.runClass === "owner");

  const out: string[] = [
    "---",
    `run-id: ${input.runId}`,
    `phase: ${input.phasePrefix}`,
    `profile: ${input.profile}`,
    `started: ${input.startedAt}`,
    `finished: ${input.finishedAt}`,
    `app-version: ${input.appVersion}`,
    `installer-version: ${input.installerVersion}`,
    `git-head: ${input.gitHead}`,
    `git-clean: ${input.gitClean ? "true" : "false"}`,
    `build-hash: ${input.buildHash}`,
    "ratified: pending",
    "---",
    "",
    `# Automated UAT report, phase ${input.phasePrefix}`,
    "",
    "## Counts",
    "",
    `- auto-passed: ${count("pass")}`,
    `- auto-failed: ${count("fail")}`,
    `- owner-pending: ${ownerRows.length}`,
    "",
    "## Items",
    "",
    "| # | Title | Class | Status | Note |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map(
      (row) =>
        `| ${row.number} | ${plain(row.title, 80)} | ${row.runClass} | ${statusFor(row)} | ${noteFor(row)} |`,
    ),
    "",
    "## Owner partials",
    "",
  ];
  let listed = false;
  for (const row of ownerRows) {
    if (row.resolution.kind !== "owner" || row.resolution.partials.length === 0) continue;
    listed = true;
    out.push(`### Item ${row.number}: ${plain(row.title, 80)}`, "");
    for (const partial of row.resolution.partials) {
      const detail = partial.message === "" ? "" : `: ${plain(partial.message)}`;
      out.push(
        `- ${partial.state}: ${plain(partial.title, 120)} (${partial.durationMs} ms)${detail}`,
      );
    }
    out.push("");
  }
  if (!listed) out.push("None.", "");
  return out.join("\n");
}

export interface ReportPathInput {
  readonly phaseDir?: string | undefined;
  readonly phasePrefix: string;
  readonly out?: string | undefined;
}

/** The report file, an explicit --out path, or null (stdout) when no planning folder exists. */
export function resolveReportPath(input: ReportPathInput): string | null {
  if (input.out !== undefined && input.out !== "") return input.out;
  if (input.phaseDir !== undefined && input.phaseDir !== "") {
    return join(input.phaseDir, `${input.phasePrefix}-UAT-AUTO-REPORT.md`);
  }
  return null;
}
