import type { IncomingMessage } from "node:http";

/**
 * The maximum number of bytes any JSON request body may occupy (threat
 * T-02-20). Bounded at read time rather than after parsing: an unbounded
 * accumulate-then-check would already have the whole payload in memory by
 * the time it noticed.
 */
export const DEFAULT_BODY_LIMIT_BYTES = 64 * 1024;

/**
 * The validating surface {@link readJsonBody} needs from a schema,
 * expressed structurally so `@ccc/service` does not take a direct
 * dependency on the validation library for one function signature. A zod
 * schema satisfies this shape exactly.
 */
export interface BodyParser<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
}

/**
 * Why a body was refused. Every arm maps to the SAME constant 400 body at
 * the route layer — a caller learning which of the three it tripped would
 * be learning about the service's internals for no legitimate purpose.
 */
export type ReadJsonBodyFailure = "too-large" | "invalid-json" | "invalid-shape";

export type ReadJsonBodyResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ReadJsonBodyFailure };

/**
 * Reads a request body with a hard byte cap, parses it as JSON, and
 * validates it against `schema` — the one bounded reader every POST route
 * in this service goes through, so no future route re-derives (or forgets)
 * the cap.
 *
 * On exceeding `limitBytes` the accumulated chunks are dropped and every
 * further chunk is discarded rather than buffered: memory stays bounded by
 * `limitBytes` no matter how much the caller sends. The stream is drained
 * to its natural end rather than destroyed mid-flight, so the 400 reaches
 * the caller as a response instead of as a connection reset — a reset
 * looks identical to a crashed service, and "the service is broken" is the
 * wrong thing to teach a client that merely sent too much.
 *
 * Never rejects: a transport error resolves as `invalid-json`, so a caller
 * has exactly one failure shape to handle.
 */
export function readJsonBody<T>(
  req: IncomingMessage,
  schema: BodyParser<T>,
  limitBytes: number = DEFAULT_BODY_LIMIT_BYTES,
): Promise<ReadJsonBodyResult<T>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let exceeded = false;
    let settled = false;

    const settle = (result: ReadJsonBodyResult<T>): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (exceeded) return;
      if (received > limitBytes) {
        exceeded = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });

    req.on("error", () => {
      settle({ ok: false, reason: "invalid-json" });
    });

    req.on("end", () => {
      if (exceeded) {
        settle({ ok: false, reason: "too-large" });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        settle({ ok: false, reason: "invalid-json" });
        return;
      }
      const validated = schema.safeParse(parsed);
      settle(
        validated.success
          ? { ok: true, value: validated.data }
          : { ok: false, reason: "invalid-shape" },
      );
    });
  });
}
