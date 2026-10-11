import { lstatSync } from "node:fs";
import { join } from "node:path";
import { type CodexHookStatus, CodexHookStatusSchema } from "@ccc/domain";
import type { CodexHookPipeline } from "./hook-pipeline.js";

/**
 * The Codex hook status the Settings rows and the card's note read (plan
 * 05.1-32, D-19, D-30, CODEX-06, T-05.1-09).
 *
 * The status is derived from facts the SERVICE can observe on its own: the
 * private copy the owner-run installer leaves under the service's runtime
 * directory, and the events actually received. It never reads the owner's Codex
 * home, hook registration or configuration, and it takes no part in trust: the
 * owner reviews and trusts the hook inside Codex, and the Settings copy says so.
 *
 * - not-installed: the installed copy is absent (either file missing, a
 *   symlink, or not a regular file; `lstat`, never `stat`, so a link cannot
 *   point the check elsewhere).
 * - unknown: the copy could not be examined (a permission or I/O error).
 * - installed-no-events: the copy exists and no event has arrived since the
 *   later of the install time (the marker's modification time; the installer
 *   writes the marker last) and the service start.
 * - installed: an event has arrived since then.
 */

export interface HookStatusFs {
  /** `lstat`: must throw an error carrying a `code` when the path cannot be examined. */
  lstat(path: string): { isFile(): boolean; isSymbolicLink(): boolean; mtimeMs: number };
}

export interface HookStatusProviderDeps {
  /** The service's own runtime directory (where the installer leaves its copy). */
  readonly runtimeDir: string;
  readonly fs?: HookStatusFs;
  /** When this service process started, in epoch milliseconds. */
  readonly serviceStartedAt: number;
  readonly pipeline: Pick<CodexHookPipeline, "lastEventAt">;
  /** Called when a rescan sees the installed copy appear, disappear or become unreadable. */
  readonly onChange?: () => void;
}

export interface HookStatusProvider {
  /** A pure function of two `lstat` calls and the pipeline's last receipt time. Never throws. */
  status(): CodexHookStatus;
  /** Re-examines the installed copy and calls `onChange` when its presence changed. */
  rescan(): void;
}

const defaultFs: HookStatusFs = { lstat: (path) => lstatSync(path) };

type Examined =
  | { readonly kind: "file"; readonly mtimeMs: number }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown" };

type Presence = "present" | "absent" | "unknown";

interface Copy {
  readonly presence: Presence;
  readonly markerMtimeMs: number | null;
}

const UNKNOWN_STATUS: CodexHookStatus = {
  state: "unknown",
  lastEventAt: null,
  installedSince: null,
};

function isoOrNull(ms: number): string | null {
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function createHookStatusProvider(deps: HookStatusProviderDeps): HookStatusProvider {
  const fs = deps.fs ?? defaultFs;
  const entryPath = join(deps.runtimeDir, "codex-hooks", "codex-hook", "entry.js");
  const markerPath = join(deps.runtimeDir, "codex-hooks", "package.json");

  function examine(path: string): Examined {
    try {
      const stat = fs.lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile()) return { kind: "absent" };
      return { kind: "file", mtimeMs: stat.mtimeMs };
    } catch (error: unknown) {
      const code = (error as { code?: unknown } | null)?.code;
      return code === "ENOENT" || code === "ENOTDIR" ? { kind: "absent" } : { kind: "unknown" };
    }
  }

  function scan(): Copy {
    const entry = examine(entryPath);
    const marker = examine(markerPath);
    if (entry.kind === "absent" || marker.kind === "absent") {
      return { presence: "absent", markerMtimeMs: null };
    }
    if (entry.kind === "unknown" || marker.kind === "unknown") {
      return { presence: "unknown", markerMtimeMs: null };
    }
    return { presence: "present", markerMtimeMs: marker.mtimeMs };
  }

  let lastPresence: Presence = scan().presence;

  function status(): CodexHookStatus {
    try {
      const copy = scan();
      if (copy.presence === "unknown") return UNKNOWN_STATUS;
      if (copy.presence === "absent" || copy.markerMtimeMs === null) {
        return { state: "not-installed", lastEventAt: null, installedSince: null };
      }
      const since = Math.max(copy.markerMtimeMs, deps.serviceStartedAt);
      const lastEvent = deps.pipeline.lastEventAt();
      const heard = lastEvent !== null && lastEvent >= since;
      const candidate = {
        state: heard ? "installed" : "installed-no-events",
        lastEventAt: lastEvent === null ? null : isoOrNull(lastEvent),
        installedSince: isoOrNull(since),
      };
      const parsed = CodexHookStatusSchema.safeParse(candidate);
      return parsed.success ? parsed.data : UNKNOWN_STATUS;
    } catch {
      return UNKNOWN_STATUS;
    }
  }

  return {
    status,
    rescan() {
      const now = scan().presence;
      if (now === lastPresence) return;
      lastPresence = now;
      try {
        deps.onChange?.();
      } catch {
        // A failing sink must not break the refresh point that called the rescan.
      }
    },
  };
}
