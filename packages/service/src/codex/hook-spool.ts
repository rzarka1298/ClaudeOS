import type { Logger } from "pino";
import type { SpoolPoller } from "../claude/spool-poller.js";
import type { CodexHookPipeline } from "./hook-pipeline.js";

/** Signature stub (RED): the implementation lands in the green commit. */
export const CODEX_HOOK_SPOOL_FILE_NAME = "";
export const CODEX_HOOK_DROP_FILE_NAME = "";

export interface CodexHookSpoolOptions {
  readonly runtimeDir: string;
  readonly pipeline: Pick<CodexHookPipeline, "ingest" | "attachDropCount">;
  readonly logger: Logger;
  readonly intervalMs: number;
  readonly settle?: () => Promise<void>;
}

export type CodexHookSpool = SpoolPoller;

export function startCodexHookSpool(_options: CodexHookSpoolOptions): CodexHookSpool {
  throw new Error("not implemented");
}
