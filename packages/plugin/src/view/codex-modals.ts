import type { TranscriptWarningViewModel } from "./session-modals.js";

/** RED stub (plan 05.1-19 task 1): signatures only. */
export const CODEX_REASONS = [] as readonly string[];

export function codexReasonFor(_code: string): string {
  return "";
}

export function codexTranscriptWarningViewModel(): TranscriptWarningViewModel {
  return {
    title: "",
    bodies: ["", ""],
    buttons: [
      { label: "", cta: false, destructive: false },
      { label: "", cta: false, destructive: false },
      { label: "", cta: false, destructive: false },
    ],
    initialFocus: "cancel",
  };
}

export interface CodexFollowWarningViewModel {
  readonly title: string;
}

export type CodexFollowChoice = "follow" | "cancel";
