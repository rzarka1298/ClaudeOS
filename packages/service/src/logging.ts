import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import pino, { type Logger } from "pino";
import { resolveRuntimeDir } from "./paths.js";

/** What every redacted field's value is replaced with. */
export const REDACTION_MARKER = "[redacted]";

const MAX_FIELD_LENGTH = 512;

/**
 * Every path a credential could reach this logger through, at the top
 * level and one level of nesting (SVC-10 / ADR-0017). `req.headers.
 * authorization` is named explicitly because pino's own HTTP request
 * serializer shape nests it three levels deep, past the generic
 * `*.authorization` wildcard's one-level reach.
 */
const REDACT_PATHS = [
  "token",
  "*.token",
  "secret",
  "*.secret",
  "installSecret",
  "*.installSecret",
  "authorization",
  "*.authorization",
  "req.headers.authorization",
  "password",
  "*.password",
  "refreshToken",
  "*.refreshToken",
];

/**
 * Truncates `body`/`content` fields beyond {@link MAX_FIELD_LENGTH}
 * characters — SVC-10 requires metadata and errors in logs, never
 * complete message bodies.
 */
function truncateLongFields(object: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...object };
  for (const key of ["body", "content"]) {
    const value = next[key];
    if (typeof value === "string" && value.length > MAX_FIELD_LENGTH) {
      next[key] =
        `${value.slice(0, MAX_FIELD_LENGTH)}… (truncated from ${value.length} chars total)`;
    }
  }
  return next;
}

/**
 * Builds a redacting pino logger writing synchronously to
 * `destinationPath` (its parent directory is created if needed). A
 * factory rather than only a singleton so `logging.test.ts` can point it
 * at a temp file and read back real written lines directly, instead of
 * exercising pino's async worker-thread transport in a test.
 */
export function createLogger(destinationPath: string, level = "info"): Logger {
  mkdirSync(dirname(destinationPath), { recursive: true });
  return pino(
    {
      level,
      redact: { paths: REDACT_PATHS, censor: REDACTION_MARKER },
      formatters: { log: truncateLongFields },
    },
    pino.destination({ dest: destinationPath, sync: true }),
  );
}

// Importing this module resolves `CCC_RUNTIME_DIR` (or its real-Keychain-
// installation default, $HOME/.claude-command-center) and opens the log
// file immediately — the same eager-resolution pattern `paths.ts` and
// `main.ts` already use for the socket/db paths. Only `main.ts` and the
// service's own routes import this module; any future in-process unit
// test that imports `routes.ts` or `main.ts` directly must set
// `CCC_RUNTIME_DIR` first, the same discipline every socket-path-bearing
// test in this repo already follows (`withTempSocketDir`).
const DEFAULT_LOG_PATH = join(resolveRuntimeDir(), "logs", "service.log");

/**
 * The service's single redacting logger, writing to
 * `<runtimeDir>/logs/service.log`. No module should construct its own
 * unredacted pino instance — use this or {@link childLogger}.
 */
export const logger: Logger = createLogger(DEFAULT_LOG_PATH, process.env.CCC_LOG_LEVEL ?? "info");

/** A child logger carrying `bindings` on every line. */
export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
