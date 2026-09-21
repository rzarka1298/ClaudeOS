import type { IncomingMessage } from "node:http";

/**
 * The maximum number of bytes any JSON request body may occupy (threat
 * T-02-20). Bounded at read time rather than after parsing: an unbounded
 * accumulate-then-check would already have the whole payload in memory by
 * the time it noticed.
 */
export const DEFAULT_BODY_LIMIT_BYTES = 64 * 1024;

/**
 * The validating surface `readJsonBody` needs from a schema, expressed
 * structurally so `@ccc/service` does not take a direct dependency on the
 * validation library. A zod schema satisfies this shape exactly.
 */
export interface BodyParser<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
}

/** Why a body was refused. Every arm maps to the same constant 400 body. */
export type ReadJsonBodyFailure = "too-large" | "invalid-json" | "invalid-shape";

export type ReadJsonBodyResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ReadJsonBodyFailure };

/**
 * Reads a request body with a hard byte cap, parses it as JSON, and
 * validates it against `schema` — the one bounded reader every POST route
 * in this service goes through.
 */
export function readJsonBody<T>(
  _req: IncomingMessage,
  _schema: BodyParser<T>,
  _limitBytes: number = DEFAULT_BODY_LIMIT_BYTES,
): Promise<ReadJsonBodyResult<T>> {
  throw new Error("readJsonBody is not implemented yet");
}
