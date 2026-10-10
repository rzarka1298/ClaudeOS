import type { Handler } from "../route-kit.js";
import type { DepsGetter } from "./route-support.js";
import type { CodexSessionMirror } from "./session-mirror.js";
import type { TranscriptOpener } from "./transcript-open.js";

/** RED stub (plan 05.1-22 task 3): signatures only. */

export interface SessionRouteDeps {
  readonly mirror: Pick<CodexSessionMirror, "snapshot" | "refreshIfStale" | "pollNow">;
  readonly opener: Pick<TranscriptOpener, "open">;
}

export function sessionRoutes(
  _getDeps: DepsGetter<SessionRouteDeps>,
): Record<string, Record<string, Handler>> {
  return {};
}
