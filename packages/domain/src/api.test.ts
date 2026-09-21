import { describe, expect, it } from "vitest";
import {
  API_BASE,
  HealthResponseSchema,
  VAULT_SETUP_PATH,
  VAULT_SETUP_PLAN_PATH,
  VaultSetupPlanResponseSchema,
  VaultSetupRequestSchema,
  VaultSetupResponseSchema,
} from "./api.js";

/**
 * Built rather than written as an inline escape on purpose: the
 * formatter rewrites that escape into a RAW NUL byte in the source file,
 * which is invisible in review and in most diffs. Constructing it keeps the
 * file pure ASCII while the value under test is still a real NUL.
 */
const NUL_BYTE = String.fromCharCode(0);

describe("HealthResponseSchema", () => {
  it("accepts a well-formed health response", () => {
    const result = HealthResponseSchema.safeParse({
      status: "ok",
      serviceVersion: "0.1.0",
      startedAt: new Date().toISOString(),
      schemaVersion: 1,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a body missing startedAt", () => {
    const result = HealthResponseSchema.safeParse({
      status: "ok",
      serviceVersion: "0.1.0",
      schemaVersion: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe("vault-setup route paths", () => {
  it("places both vault-setup routes under the versioned API base", () => {
    expect(VAULT_SETUP_PLAN_PATH).toBe(`${API_BASE}/vault/setup-plan`);
    expect(VAULT_SETUP_PATH).toBe(`${API_BASE}/vault/setup`);
  });
});

describe("VaultSetupRequestSchema", () => {
  it("accepts an absolute vault root", () => {
    expect(VaultSetupRequestSchema.safeParse({ vaultRoot: "/Users/someone/Vault" }).success).toBe(
      true,
    );
  });

  it("rejects a relative vault root, which would resolve against the service's own cwd", () => {
    expect(VaultSetupRequestSchema.safeParse({ vaultRoot: "relative/Vault" }).success).toBe(false);
    expect(VaultSetupRequestSchema.safeParse({ vaultRoot: "./Vault" }).success).toBe(false);
  });

  it("rejects a vault root containing a NUL byte", () => {
    expect(
      VaultSetupRequestSchema.safeParse({ vaultRoot: `/tmp/vault${NUL_BYTE}.txt` }).success,
    ).toBe(false);
  });

  it("rejects an empty vault root, a missing field, and a non-string field", () => {
    expect(VaultSetupRequestSchema.safeParse({ vaultRoot: "" }).success).toBe(false);
    expect(VaultSetupRequestSchema.safeParse({}).success).toBe(false);
    expect(VaultSetupRequestSchema.safeParse({ vaultRoot: 17 }).success).toBe(false);
  });
});

describe("VaultSetupPlanResponseSchema", () => {
  it("accepts a plan whose entries carry relativePath, kind and exists", () => {
    const result = VaultSetupPlanResponseSchema.safeParse({
      vaultRoot: "/Users/someone/Vault",
      entries: [
        { relativePath: "global", kind: "folder", exists: false },
        { relativePath: "global/index.md", kind: "index", exists: true },
        { relativePath: "CLAUDE.md", kind: "claude-md", exists: false },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an entry whose kind is not one of the three managed kinds", () => {
    const result = VaultSetupPlanResponseSchema.safeParse({
      vaultRoot: "/Users/someone/Vault",
      entries: [{ relativePath: "global", kind: "symlink", exists: false }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an entry missing its exists flag — the display contract needs it on every row", () => {
    const result = VaultSetupPlanResponseSchema.safeParse({
      vaultRoot: "/Users/someone/Vault",
      entries: [{ relativePath: "global", kind: "folder" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("VaultSetupResponseSchema", () => {
  it("accepts a created/existing split, including the all-existing re-run case", () => {
    expect(VaultSetupResponseSchema.safeParse({ created: [], existing: ["global"] }).success).toBe(
      true,
    );
  });

  it("rejects a body missing the existing list", () => {
    expect(VaultSetupResponseSchema.safeParse({ created: [] }).success).toBe(false);
  });
});
