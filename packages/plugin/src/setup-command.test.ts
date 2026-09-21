import { VAULT_SETUP_PATH, VAULT_SETUP_PLAN_PATH, type VaultSetupPlanResponse } from "@ccc/domain";
import type { SocketApiClient, SocketRequestOptions } from "@ccc/service-api-client";
import { SocketUnreachableError } from "@ccc/service-api-client";
import { describe, expect, it } from "vitest";
import {
  NO_LOCAL_VAULT_MESSAGE,
  runVaultSetup,
  SERVICE_UNREACHABLE_MESSAGE,
  type VaultSetupUi,
} from "./setup-command.js";

const VAULT_ROOT = "/Users/someone/Vault";

const PLAN: VaultSetupPlanResponse = {
  vaultRoot: VAULT_ROOT,
  entries: [
    { relativePath: "global", kind: "folder", exists: false },
    { relativePath: "inbox/index.md", kind: "index", exists: true },
    { relativePath: "CLAUDE.md", kind: "claude-md", exists: false },
  ],
};

interface Harness {
  ui: VaultSetupUi;
  client: SocketApiClient;
  notices: string[];
  paths: string[];
  shownPlans: VaultSetupPlanResponse[];
}

function harness(opts: {
  vaultPath?: string | null;
  confirm?: boolean;
  replies?: Record<string, { status: number; body: unknown }>;
  throwOn?: { path: string; error: unknown };
}): Harness {
  const notices: string[] = [];
  const paths: string[] = [];
  const shownPlans: VaultSetupPlanResponse[] = [];
  const replies = opts.replies ?? {
    [VAULT_SETUP_PLAN_PATH]: { status: 200, body: PLAN },
    [VAULT_SETUP_PATH]: { status: 200, body: { created: ["global", "CLAUDE.md"], existing: [] } },
  };

  return {
    notices,
    paths,
    shownPlans,
    ui: {
      resolveVaultPath: () => (opts.vaultPath === undefined ? VAULT_ROOT : opts.vaultPath),
      notify: (message: string) => notices.push(message),
      confirmPlan: (plan: VaultSetupPlanResponse) => {
        shownPlans.push(plan);
        return Promise.resolve(opts.confirm ?? true);
      },
    },
    client: {
      request<T>(request: SocketRequestOptions): Promise<{ status: number; body: T }> {
        paths.push(request.path);
        if (opts.throwOn && opts.throwOn.path === request.path) {
          return Promise.reject(opts.throwOn.error);
        }
        const reply = replies[request.path];
        if (!reply) throw new Error(`unexpected request to ${request.path}`);
        return Promise.resolve({ status: reply.status, body: reply.body as T });
      },
    },
  };
}

describe("runVaultSetup", () => {
  it("shows the service's own plan and, on confirmation, applies it and reports the counts", async () => {
    const h = harness({ confirm: true });

    await runVaultSetup(h.ui, h.client);

    expect(h.shownPlans).toEqual([PLAN]);
    expect(h.paths).toEqual([VAULT_SETUP_PLAN_PATH, VAULT_SETUP_PATH]);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain("2");
  });

  it("writes nothing when the user cancels — the apply call is never made", async () => {
    const h = harness({ confirm: false });

    await runVaultSetup(h.ui, h.client);

    expect(h.shownPlans).toEqual([PLAN]);
    expect(h.paths).toEqual([VAULT_SETUP_PLAN_PATH]);
    expect(h.notices).toEqual([]);
  });

  it("never fetches a plan, and never writes, when the vault is not a local folder", async () => {
    const h = harness({ vaultPath: null });

    await runVaultSetup(h.ui, h.client);

    expect(h.paths).toEqual([]);
    expect(h.shownPlans).toEqual([]);
    expect(h.notices).toEqual([NO_LOCAL_VAULT_MESSAGE]);
  });

  it("shows the disconnected message instead of throwing when the service is unreachable", async () => {
    const h = harness({
      throwOn: {
        path: VAULT_SETUP_PLAN_PATH,
        error: new SocketUnreachableError(
          "/tmp/ccc.sock",
          Object.assign(new Error("no socket"), {
            code: "ENOENT",
          }),
        ),
      },
    });

    await expect(runVaultSetup(h.ui, h.client)).resolves.toBeUndefined();

    expect(h.notices).toEqual([SERVICE_UNREACHABLE_MESSAGE]);
    expect(h.shownPlans).toEqual([]);
  });

  it("surfaces the service's refusal as a notice and shows no modal when the plan call is refused", async () => {
    const h = harness({
      replies: {
        [VAULT_SETUP_PLAN_PATH]: { status: 422, body: { error: "vault root does not exist" } },
      },
    });

    await runVaultSetup(h.ui, h.client);

    expect(h.shownPlans).toEqual([]);
    expect(h.notices).toEqual(["vault root does not exist"]);
  });

  it("surfaces a refusal of the apply call after the plan was confirmed", async () => {
    const h = harness({
      confirm: true,
      replies: {
        [VAULT_SETUP_PLAN_PATH]: { status: 200, body: PLAN },
        [VAULT_SETUP_PATH]: { status: 400, body: { error: "invalid request body" } },
      },
    });

    await runVaultSetup(h.ui, h.client);

    expect(h.paths).toEqual([VAULT_SETUP_PLAN_PATH, VAULT_SETUP_PATH]);
    expect(h.notices).toEqual(["invalid request body"]);
  });
});
