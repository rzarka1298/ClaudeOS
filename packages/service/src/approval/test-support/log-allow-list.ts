// The logging allow-list recorder (06-12 Task 3, A-6, research C-4, T-06-09).
// Folder-private: never exported from the approval public entry. The engine,
// the sweeper and recovery may log only these keys, and only short fixed
// values: redaction paths are a net, this is the structural rule that keeps a
// payload, a reason or a requester label out of the service log. A test runs
// the whole scenario matrix against a recording log and asks for the
// violations; the recorder is itself proved to fail on a violating call.
import type { LoggedLine } from "./harness.js";

/** The only keys an approval log call may carry. */
export const ALLOWED_LOG_KEYS: ReadonlySet<string> = new Set([
  "proposalId",
  "operation",
  "state",
  "payloadHash",
  "attempt",
  "reason",
  "code",
  "count",
  "counts",
]);

/** No logged string is longer than this: a payload, a reason or a label does not fit by accident. */
export const MAX_LOG_STRING_CHARS = 120;

function scalarViolation(key: string, value: unknown): string | null {
  if (typeof value === "string") {
    return value.length > MAX_LOG_STRING_CHARS
      ? `key "${key}" holds a string longer than ${MAX_LOG_STRING_CHARS} characters`
      : null;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return null;
  return `key "${key}" holds a ${value instanceof Error ? "error object" : typeof value}`;
}

/**
 * Every way `lines` break the rule, described by key and kind only (never by
 * value, so a violation report cannot itself leak). Empty means the log is clean.
 */
export function logViolations(lines: readonly LoggedLine[]): string[] {
  const found: string[] = [];
  lines.forEach((line, index) => {
    const at = `line ${index + 1} (${line.level})`;
    if (line.message !== undefined) found.push(`${at}: a message string was passed`);
    for (const [key, value] of Object.entries(line.fields)) {
      if (!ALLOWED_LOG_KEYS.has(key)) {
        found.push(`${at}: key "${key}" is not allowed`);
        continue;
      }
      if (key === "counts") {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          found.push(`${at}: key "counts" must be an object of numbers`);
          continue;
        }
        for (const [name, count] of Object.entries(value)) {
          if (typeof count !== "number") found.push(`${at}: counts.${name} is not a number`);
        }
        continue;
      }
      const problem = scalarViolation(key, value);
      if (problem !== null) found.push(`${at}: ${problem}`);
    }
  });
  return found;
}

/** The distinct `code` values a set of lines carries, so a test can prove its matrix really logged. */
export function codesOf(lines: readonly LoggedLine[]): Set<string> {
  return new Set(
    lines.flatMap((line) => (typeof line.fields.code === "string" ? [line.fields.code] : [])),
  );
}
