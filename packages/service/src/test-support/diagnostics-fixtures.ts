import { type DiagnosticsHealthResponse, DiagnosticsHealthResponseSchema } from "@ccc/domain";

/**
 * A synthetic fresh-install health response for the diagnostics tests (plan 08-07): vault, hooks,
 * collectors, scheduler and launchers all setup-needed, no path, no fingerprint, counts unknown.
 * Test support only; every value is invented.
 */
export const FIXTURE_INSTANT = "2026-10-22T09:00:00.000Z";

export function freshInstallResponse(): DiagnosticsHealthResponse {
  const part = (partId: string, reasonCode: string, status: "ok" | "setup-needed") => ({
    partId,
    status,
    reasonCode,
  });
  const row = (id: string, reasonCode: string, extra: Record<string, unknown> = {}) => ({
    id,
    status: "setup-needed" as const,
    reasonCode,
    checkedAt: FIXTURE_INSTANT,
    freshness: "live" as const,
    ...extra,
  });
  return DiagnosticsHealthResponseSchema.parse({
    generatedAt: FIXTURE_INSTANT,
    service: { version: "0.1.0", startedAt: FIXTURE_INSTANT, storeSchemaVersion: 12 },
    rows: [
      row("vault", "vault-not-set-up"),
      row("hooks", "hooks-not-installed"),
      row("collectors", "statusline-not-installed", {
        parts: [
          part("telemetry", "telemetry-ok", "ok"),
          part("status-line", "statusline-not-installed", "setup-needed"),
          part("transcript-analysis", "analysis-off", "setup-needed"),
          part("spool", "spool-clean", "ok"),
          part("codex-install", "codex-not-installed", "setup-needed"),
          part("codex-hooks", "codex-hooks-not-installed", "setup-needed"),
          part("codex-bridge", "codex-bridge-not-installed", "setup-needed"),
          part("codex-doctor", "codex-doctor-not-run", "setup-needed"),
        ],
      }),
      row("scheduler", "never-run", {
        parts: [
          part("last-run", "never-run", "setup-needed"),
          part("research-key", "research-key-missing", "setup-needed"),
          part("sources", "sources-configured", "ok"),
        ],
      }),
      row("launchers", "launcher-not-set-up", {
        parts: ["antigravity", "claude-code", "claude-desktop", "codex"].map((partId) =>
          part(partId, "launcher-not-set-up", "setup-needed"),
        ),
      }),
    ],
    keychain: { installSecret: "unknown", researchKey: "unknown" },
    paths: { vault: null, runtimeDir: "~/.example-runtime", socket: "~/.example-runtime/svc.sock" },
    vaultFingerprint: null,
    counts: { projects: null, scanFolders: null, openTasks: null, reports: null },
  });
}
