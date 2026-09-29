import { CLAUDE_HOOK_EVENTS_PATH } from "@ccc/domain";
import { type ClaudeHandler, sendClaudeJson, withClaudeAuth } from "./http.js";

// RED stub (05-08 Task 1): the real handler lands in the GREEN commit.
export const hookEventsHandler: ClaudeHandler = (_req, res) => {
  sendClaudeJson(res, 501, { error: "not implemented" });
};

export const ingestRoutes: Record<string, Record<string, ClaudeHandler>> = {
  [CLAUDE_HOOK_EVENTS_PATH]: { POST: withClaudeAuth(hookEventsHandler) },
};
