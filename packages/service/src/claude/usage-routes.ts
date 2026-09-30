import { type ApiErrorBody, CLAUDE_STATUSLINE_PATH } from "@ccc/domain";
import { type ClaudeHandler, sendClaudeJson, withClaudeAuth } from "./http.js";

/** RED scaffold (05-12 Task 1): the real handler lands in the GREEN commit. */
const UNAVAILABLE_BODY: ApiErrorBody = { error: "claude usage unavailable" };

const statusLineHandler: ClaudeHandler = (req, res) => {
  req.resume();
  sendClaudeJson(res, 503, UNAVAILABLE_BODY);
};

export const usageRoutes: Record<string, Record<string, ClaudeHandler>> = {
  [CLAUDE_STATUSLINE_PATH]: { POST: withClaudeAuth(statusLineHandler) },
};
