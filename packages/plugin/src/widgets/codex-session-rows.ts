import type { CodexSessionsSnapshot, CodexSessionView } from "@ccc/domain/codex-sessions.js";
import { CODEX_STATE_DISPLAY, CODEX_STATE_DISPLAY_ORDER } from "@ccc/domain/codex-sessions.js";
import { CODEX_ROW_COPY, formatResetAt } from "./codex-format.js";
import type { QuickActionDescriptor, SizeHint } from "./contract.js";
import { formatDuration } from "./duration.js";
import type { MetaSegment } from "./list-body.js";
import { ACTION_ROW_BUDGET } from "./list-body.js";
import { formatRelativeTime } from "./relative-time.js";

export interface CodexSessionRow {
  readonly key: string;
  readonly threadId: string;
  readonly primary: string;
  readonly segments: readonly MetaSegment[];
  readonly state: CodexSessionView["state"];
  readonly hasTranscript: boolean;
  readonly liveLogRunId: string | null;
  readonly openTranscript: QuickActionDescriptor;
  readonly followLog: QuickActionDescriptor | null;
}
export interface CodexRowsOptions {
  readonly nowMs: number;
  readonly analysisOn: boolean;
  readonly hookInstalled: boolean | null;
  readonly size: SizeHint;
}
export type CodexSessionRows =
  | Extract<CodexSessionsSnapshot, { kind: "unavailable" }>
  | {
      readonly kind: "available";
      readonly current: CodexSessionRow | null;
      readonly recent: readonly CodexSessionRow[];
      readonly overflow: number;
      readonly observedAt: string;
      readonly freshness: "live" | "cached" | "stale";
      readonly count: number;
      readonly unknownNote: boolean;
      readonly analysisNote: boolean;
      readonly hookNote: boolean;
    };
export function buildCodexSessionRows(
  snapshot: CodexSessionsSnapshot,
  options: CodexRowsOptions,
): CodexSessionRows {
  if (snapshot.kind === "unavailable") return snapshot;
  const ordered = [...snapshot.sessions].sort(
    (a, b) =>
      CODEX_STATE_DISPLAY_ORDER.indexOf(a.state) - CODEX_STATE_DISPLAY_ORDER.indexOf(b.state) ||
      Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt),
  );
  const currentSession = ordered.find((row) => row.state === "running") ?? null;
  function build(session: CodexSessionView, current = false): CodexSessionRow {
    const name =
      options.analysisOn && session.title
        ? session.title
        : CODEX_ROW_COPY.sessionFallback.replace("{id}", session.threadId.slice(0, 8));
    const display = CODEX_STATE_DISPLAY[session.state];
    const segments: MetaSegment[] = [{ glyph: display.glyph, text: display.label }];
    if (session.model !== null && /^[A-Za-z0-9 ._-]{1,64}$/.test(session.model))
      segments.push({ text: session.model });
    if (session.effort !== null && /^[A-Za-z0-9 ._-]{1,24}$/.test(session.effort))
      segments.push({ text: CODEX_ROW_COPY.effort.replace("{effort}", session.effort) });
    segments.push({
      text: current
        ? CODEX_ROW_COPY.elapsed.replace(
            "{duration}",
            formatDuration(Math.max(0, options.nowMs - Date.parse(session.startedAt))),
          )
        : CODEX_ROW_COPY.started.replace(
            "{relative}",
            formatRelativeTime(session.startedAt, options.nowMs),
          ),
    });
    segments.push({
      text: CODEX_ROW_COPY.active.replace(
        "{relative}",
        formatRelativeTime(session.lastActivityAt, options.nowMs),
      ),
    });
    if (session.state === "stale")
      segments.push({
        text: CODEX_ROW_COPY.staleElapsed.replace(
          "{duration}",
          formatDuration(
            Math.max(0, Date.parse(session.lastActivityAt) - Date.parse(session.startedAt)),
          ),
        ),
      });
    if (session.state === "limit-paused")
      segments.push({
        text:
          session.resumesAfter === null
            ? CODEX_ROW_COPY.resetUnreported
            : CODEX_ROW_COPY.resumesAfter.replace(
                "{time}",
                formatResetAt(session.resumesAfter, options.nowMs),
              ),
      });
    const liveLogRunId =
      session.state === "running" && session.origin !== "interactive" ? session.liveLogRunId : null;
    return {
      key: session.threadId,
      threadId: session.threadId,
      primary: `${session.projectName ?? CODEX_ROW_COPY.unclassified} · ${name}`,
      segments,
      state: session.state,
      hasTranscript: session.hasTranscript,
      liveLogRunId,
      openTranscript: {
        id: `codex-open-transcript-${session.threadId}`,
        label: CODEX_ROW_COPY.openTranscript,
        capability: "codex:open-transcript",
        target: { threadId: session.threadId },
      },
      followLog:
        liveLogRunId === null
          ? null
          : {
              id: `codex-follow-log-${liveLogRunId}`,
              label: CODEX_ROW_COPY.followLog,
              capability: "codex:follow-log",
              target: { wrapperRunId: liveLogRunId },
            },
    };
  }
  const recentSessions = ordered.filter(
    (row) =>
      row !== currentSession && Date.parse(row.lastActivityAt) >= options.nowMs - 7 * 86400000,
  );
  const recent = recentSessions.slice(0, ACTION_ROW_BUDGET[options.size]).map((row) => build(row));
  return {
    kind: "available",
    current: currentSession === null ? null : build(currentSession, true),
    recent,
    overflow: recentSessions.length - recent.length + snapshot.hiddenCount,
    observedAt: snapshot.observedAt,
    freshness: snapshot.freshness,
    count: snapshot.sessions.length + snapshot.hiddenCount,
    unknownNote: recent.some((row) => row.state === "stale"),
    analysisNote: !options.analysisOn,
    hookNote: options.hookInstalled === false && (recent.length > 0 || currentSession !== null),
  };
}
