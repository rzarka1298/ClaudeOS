/** `standard` skips the 10,000-task scale item; `full` includes it (D-07, D-13). */
export type UatProfile = "standard" | "full";

const PROFILE_ERROR = "Unknown --profile value; expected standard or full.";

/** Parses the --profile argument. Absent means standard; the rejected value is never echoed. */
export function parseProfile(value: string | undefined): UatProfile {
  if (value === undefined || value === "standard") return "standard";
  if (value === "full") return "full";
  throw new Error(PROFILE_ERROR);
}
