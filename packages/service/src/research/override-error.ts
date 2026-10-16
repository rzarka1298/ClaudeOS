/**
 * Why a research test override was refused at startup. The code is fixed and the message is a
 * constant: it never quotes an environment value, a path or a manifest entry (plan 07-14).
 */
export type ResearchOverrideCode =
  | "unknown-summariser"
  | "invalid-key-account"
  | "invalid-fixture-dir"
  | "invalid-fixture-manifest"
  | "fixture-path-outside";

export class ResearchOverrideError extends Error {
  readonly code: ResearchOverrideCode;

  constructor(code: ResearchOverrideCode) {
    super(`research test override refused: ${code}`);
    this.name = "ResearchOverrideError";
    this.code = code;
  }
}
