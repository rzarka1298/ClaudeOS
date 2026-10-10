import type { CodexHookStatus } from "@ccc/domain";
import type { CodexHookPipeline } from "./hook-pipeline.js";

/** Signature stub (RED): the implementation lands in the green commit. */
export interface HookStatusFs {
  lstat(path: string): { isFile(): boolean; isSymbolicLink(): boolean; mtimeMs: number };
}

export interface HookStatusProviderDeps {
  readonly runtimeDir: string;
  readonly fs?: HookStatusFs;
  readonly serviceStartedAt: number;
  readonly pipeline: Pick<CodexHookPipeline, "lastEventAt">;
  readonly onChange?: () => void;
}

export interface HookStatusProvider {
  status(): CodexHookStatus;
  rescan(): void;
}

export function createHookStatusProvider(_deps: HookStatusProviderDeps): HookStatusProvider {
  throw new Error("not implemented");
}
