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

const NOT_IMPLEMENTED = "is not implemented yet (typed skeleton)";

export function formatResultLine(_record: ResultRecord): string {
  throw new Error(`formatResultLine ${NOT_IMPLEMENTED}`);
}

export function parseResultsFile(_text: string): ResultRecord[] {
  throw new Error(`parseResultsFile ${NOT_IMPLEMENTED}`);
}

export function itemNumberOf(_title: string, _phasePrefix: string): number | null {
  throw new Error(`itemNumberOf ${NOT_IMPLEMENTED}`);
}

export function resolveItemStatus(_input: ResolveInput): ItemResolution {
  throw new Error(`resolveItemStatus ${NOT_IMPLEMENTED}`);
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

export function installResultRecorder(_options: RecorderOptions): void {
  throw new Error(`installResultRecorder ${NOT_IMPLEMENTED}`);
}
