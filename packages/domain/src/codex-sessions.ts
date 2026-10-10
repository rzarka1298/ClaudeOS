import { z } from "zod";
import type { RunStateDisplay } from "./session.js";

// RED stub (plan 05.1-03 task 2): signatures only, no behaviour yet.
export type CodexSessionState =
  | "running"
  | "limit-paused"
  | "stale"
  | "failed"
  | "completed"
  | "cancelled";
export const CODEX_SESSION_STATES = [] as unknown as readonly CodexSessionState[];
export const CODEX_STATE_DISPLAY_ORDER = [] as unknown as readonly CodexSessionState[];
export const CODEX_STATE_DISPLAY = {} as Readonly<Record<CodexSessionState, RunStateDisplay>>;
export const CodexSessionViewSchema = z.never();
export const CodexSessionsSnapshotSchema = z.never();
export const CodexTokenCountersSchema = z.never();
export const CodexTokenActivitySchema = z.never();
export const CodexTokenSummarySchema = z.never();
export const CodexHookRecordSchema = z.never();
