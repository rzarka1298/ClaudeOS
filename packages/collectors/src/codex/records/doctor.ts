import {
  CODEX_DOCTOR_MAX_CHECKS,
  CODEX_VERSION_PATTERN,
  type CodexDoctorSummary,
} from "@ccc/domain";

/**
 * The `codex doctor --json` allowlist parse (CODEX-03, D-17, RESEARCH R4).
 *
 * Doctor output is redacted by Codex but its `details`, `summary`,
 * `remediation` and `notes` can still carry local paths and account facts, so
 * this keeps ONLY the schema version gate (1), the overall status, a
 * dotted-digits Codex version and, per check, an id, a category and a status.
 * Everything else is dropped before anything reaches a log or a wire type.
 * The result has the domain doctor-summary shape (the check time is added by
 * the caller). Never throws.
 */

/** Doctor reports are small; refuse anything larger than this before parsing. */
const MAX_DOCTOR_JSON_CHARS = 2 * 1024 * 1024;

const ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const CATEGORY_PATTERN = /^[A-Za-z0-9_.-]{1,32}$/;
const STATUSES = ["ok", "warning", "fail"] as const;
type Status = (typeof STATUSES)[number];

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statusOf(value: unknown): Status | null {
  return STATUSES.find((status) => status === value) ?? null;
}

function versionOf(value: unknown): string | null {
  return typeof value === "string" && value.length <= 64 && CODEX_VERSION_PATTERN.test(value)
    ? value
    : null;
}

const UNRECOGNISED: CodexDoctorSummary = {
  overall: "unrecognised",
  codexVersion: null,
  checks: [],
};

/** `{ id, category, status }` of one check, or null when any of the three is off-shape. */
function checkOf(
  entry: unknown,
  fallbackId: string | null,
): { id: string; category: string; status: Status } | null {
  if (!isObject(entry)) return null;
  const id = typeof entry.id === "string" ? entry.id : fallbackId;
  const category = entry.category;
  const status = statusOf(entry.status);
  if (id === null || !ID_PATTERN.test(id)) return null;
  if (typeof category !== "string" || !CATEGORY_PATTERN.test(category)) return null;
  if (status === null) return null;
  return { id, category, status };
}

export function parseDoctorJson(input: unknown): CodexDoctorSummary | null {
  try {
    let value: unknown = input;
    if (typeof input === "string") {
      if (input.length > MAX_DOCTOR_JSON_CHARS) return null;
      value = JSON.parse(input);
    }
    if (!isObject(value)) return null;
    if (value.schemaVersion !== 1) return UNRECOGNISED;
    const overall = statusOf(value.overallStatus);
    if (overall === null) return UNRECOGNISED;

    const rawChecks = value.checks;
    const candidates: [unknown, string | null][] = Array.isArray(rawChecks)
      ? rawChecks.map((entry): [unknown, string | null] => [entry, null])
      : isObject(rawChecks)
        ? Object.entries(rawChecks).map(([key, entry]): [unknown, string | null] => [entry, key])
        : [];

    const checks: { id: string; category: string; status: Status }[] = [];
    for (const [entry, key] of candidates) {
      if (checks.length >= CODEX_DOCTOR_MAX_CHECKS) break;
      const check = checkOf(entry, key);
      if (check !== null) checks.push(check);
    }
    return { overall, codexVersion: versionOf(value.codexVersion), checks };
  } catch {
    return null;
  }
}
