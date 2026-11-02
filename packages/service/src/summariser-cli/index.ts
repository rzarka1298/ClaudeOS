/**
 * The subscription summariser's pure core (plan 10-02): the exact `claude` argv, the from-scratch
 * child environment and the fail-closed stream parser. Exported as `@ccc/service/summariser-cli`.
 */
export {
  buildClaudeArgv,
  buildClaudeChildEnv,
  CLAUDE_AUTH_STATUS_ARGV,
  CLAUDE_CHILD_ENV_KEYS,
} from "./argv.js";
export {
  type ClaudeStreamOutcome,
  type ClaudeStreamSummary,
  parseClaudeStream,
} from "./stream.js";
