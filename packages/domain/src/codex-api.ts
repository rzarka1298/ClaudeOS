import { z } from "zod";

// RED stub (plan 05.1-06 task 1): signatures only, so the project compiles
// while the tests fail on their assertions.
export const CODEX_API_BASE = "";
export const CODEX_HEADROOM_PATH = "";
export const CODEX_ACTION_ERROR_CODES = [] as const;
export type CodexActionErrorCode = (typeof CODEX_ACTION_ERROR_CODES)[number];
export const CodexActionErrorBodySchema = z.never();
export type CodexActionErrorBody = z.infer<typeof CodexActionErrorBodySchema>;
