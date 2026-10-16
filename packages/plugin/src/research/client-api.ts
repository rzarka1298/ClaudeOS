import { RESEARCH_ERROR_CODES, type ResearchErrorCode } from "@ccc/domain/research-routes.js";
import type { ResearchClient } from "@ccc/service-api-client";
import { type ResearchApi, ResearchApiError } from "./api.js";

/**
 * The adapter from the research client to the `ResearchApi` port (plan 07-15, D-23; the
 * `tasks/wiring.ts` `closed()` precedent). The client is received by injection and imported as a
 * TYPE only: the client package's value exports pull in Node HTTP, which the browser-platform
 * bundle cannot resolve.
 *
 * Every failure leaves as a {@link ResearchApiError} carrying one of the closed codes. A failure
 * that names no closed code (a stray `Error`, a hostile `code` value, a thrown string) becomes
 * `unrecognised-response`, so nothing a remote party or the platform said reaches a string the
 * view might render (T-07-32).
 */

export type ResearchClientLike = ResearchClient;

const CLOSED_CODES: ReadonlySet<string> = new Set(RESEARCH_ERROR_CODES);

function toApiError(error: unknown): ResearchApiError {
  const code: unknown =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return new ResearchApiError(
    typeof code === "string" && CLOSED_CODES.has(code)
      ? (code as ResearchErrorCode)
      : "unrecognised-response",
  );
}

async function closed<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toApiError(error);
  }
}

export function createResearchApi(client: ResearchClientLike): ResearchApi {
  return {
    run: () => closed(() => client.run()),
    status: () => closed(() => client.status()),
    list: (cursor) => closed(() => client.list(cursor === undefined ? {} : { cursor })),
    report: (noteId, page, cursor) =>
      closed(() =>
        client.report(cursor === undefined ? { noteId, page } : { noteId, page, cursor }),
      ),
  };
}
