import {
  FORMAT_MIN_RATIO,
  FORMAT_MIN_SAMPLE,
  FORMAT_ZERO_SAMPLE,
  UNVERSIONED,
} from "../../transcripts/parse.js";

// RED stub: signatures only (plan 05.1-08 Task 2). The implementation lands in the green commit.

export { FORMAT_MIN_RATIO, FORMAT_MIN_SAMPLE, FORMAT_ZERO_SAMPLE, UNVERSIONED };

export interface CodexVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[] | null;
  readonly raw: string;
}

export function parseCodexVersion(_text: unknown): CodexVersion | null {
  return null;
}

export function compareCodexVersions(_a: string, _b: string): number {
  return 0;
}

export interface CodexVersionRecognition {
  readonly sessions: number;
  readonly recognized: number;
}

export type CodexRecognitionVerdict =
  | { readonly kind: "ok" }
  | { readonly kind: "unavailable"; readonly version: string | null };

export function evaluateCliRecognition(
  _byVersion: Readonly<Record<string, CodexVersionRecognition>>,
): CodexRecognitionVerdict {
  return { kind: "ok" };
}
