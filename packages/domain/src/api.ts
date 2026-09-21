import path from "node:path";
import { z } from "zod";

/** The versioned base path every companion-service HTTP route lives under. */
export const API_BASE = "/api/v1";

export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  serviceVersion: z.string(),
  startedAt: z.string(),
  schemaVersion: z.number(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ApiErrorBodySchema = z.object({
  error: z.string(),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

/**
 * `POST /api/v1/vault/setup-plan` — the show-paths-first half of VAULT-01.
 * Pure and read-only: returns every path setup WOULD touch, each flagged
 * with whether it is already there, so the plugin can display the exact
 * consequences before the user agrees to any of them. `POST` rather than
 * `GET` because the vault root travels in the body — a filesystem path in
 * a query string ends up in far more logs than a path in a body does.
 */
export const VAULT_SETUP_PLAN_PATH = `${API_BASE}/vault/setup-plan`;

/** `POST /api/v1/vault/setup` — the apply half: creates the managed tree. */
export const VAULT_SETUP_PATH = `${API_BASE}/vault/setup`;

/**
 * The body both vault-setup routes take.
 *
 * The two refinements are the schema-level half of threat T-02-18 (an
 * arbitrary directory being registered as an approved root): a relative
 * path would be resolved against the SERVICE's cwd rather than anything
 * the caller can see, and a NUL byte is the classic truncation trick for
 * making a validated string and the string the syscall actually receives
 * disagree. Existence is deliberately NOT checked here — that is
 * `initializeVault`'s own `VaultRootMissingError`, which refuses to create
 * a vault root, so a typo cannot silently become a second empty vault.
 */
export const VaultSetupRequestSchema = z.object({
  vaultRoot: z
    .string()
    .min(1)
    .refine((value) => !value.includes("\0"), {
      message: "vaultRoot must not contain a NUL byte",
    })
    .refine((value) => path.isAbsolute(value), {
      message: "vaultRoot must be an absolute path",
    }),
});
export type VaultSetupRequest = z.infer<typeof VaultSetupRequestSchema>;

/** Mirrors `@ccc/vault-repo`'s `VaultSetupEntryKind` across the wire. */
export const VAULT_SETUP_ENTRY_KINDS = ["folder", "index", "claude-md"] as const;
export const VaultSetupEntryKindSchema = z.enum(VAULT_SETUP_ENTRY_KINDS);
export type VaultSetupEntryKind = z.infer<typeof VaultSetupEntryKindSchema>;

/** One path setup would touch, and whether it is already there. */
export const VaultSetupEntrySchema = z.object({
  relativePath: z.string(),
  kind: VaultSetupEntryKindSchema,
  exists: z.boolean(),
});
export type VaultSetupEntry = z.infer<typeof VaultSetupEntrySchema>;

/**
 * The plan response. `entries` arrives in the fixed order
 * `computeSetupEntries` documents, and the client renders THAT list —
 * never a path list of its own — which is what keeps "the modal shows
 * exactly what setup will write" true across both processes.
 */
export const VaultSetupPlanResponseSchema = z.object({
  vaultRoot: z.string(),
  entries: z.array(VaultSetupEntrySchema),
});
export type VaultSetupPlanResponse = z.infer<typeof VaultSetupPlanResponseSchema>;

/** The apply response: the vault as the run found it, split in two. */
export const VaultSetupResponseSchema = z.object({
  created: z.array(z.string()),
  existing: z.array(z.string()),
});
export type VaultSetupResponse = z.infer<typeof VaultSetupResponseSchema>;
