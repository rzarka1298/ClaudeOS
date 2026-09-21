import type { VaultSetupPlanResponse } from "@ccc/domain";
import type { SocketApiClient } from "@ccc/service-api-client";
import type { HostRegistry } from "./host-registry.js";

/**
 * The palette command that makes the managed vault reachable from
 * Obsidian (VAULT-01, end to end).
 *
 * The display contract this module exists to honour: the user sees EVERY
 * target path, with its current exists state, BEFORE anything is written,
 * and only an explicit confirmation triggers the write. The rows are
 * rendered from the service's own plan response and from nothing else --
 * there is deliberately no path list, no folder-name constant and no
 * tree-shaped literal anywhere in this file, because a second copy of the
 * tree here could drift from the one `computeSetupEntries` actually walks,
 * and the modal would then be showing a plan the service does not follow.
 */

/** Sentence-case, no plugin name, no "command" -- the obsidianmd rules. */
export const VAULT_SETUP_COMMAND_ID = "set-up-managed-vault";
export const VAULT_SETUP_COMMAND_NAME = "Set up managed vault";

export const NO_LOCAL_VAULT_MESSAGE = "Managed vault setup needs a vault stored in a local folder.";
export const SERVICE_UNREACHABLE_MESSAGE =
  "The companion service is not running, so vault setup is unavailable.";
export const UNEXPECTED_FAILURE_MESSAGE = "Vault setup failed. See the service log for details.";

/**
 * Everything `runVaultSetup` needs from the Obsidian side, behind one
 * typed seam -- the same shape `host-registry.ts` uses for registration
 * and `vault-write.ts` uses for `Vault.process`. Production passes
 * `createObsidianVaultSetupUi(app)`; tests pass a plain object, and
 * neither needs a cast.
 */
export interface VaultSetupUi {
  /**
   * The vault's absolute path on disk, or `null` when this vault is not a
   * local folder (Obsidian supports adapters that are not filesystem
   * ones, and the service can only set up a real directory).
   */
  resolveVaultPath(): string | null;
  /** Shows a transient message to the user. */
  notify(message: string): void;
  /**
   * Displays every planned path with its exists state and resolves `true`
   * only on an explicit confirmation. Cancelling -- including dismissing
   * the modal -- must resolve `false`, never leave the promise pending:
   * a pending promise here would silently strand the command.
   */
  confirmPlan(plan: VaultSetupPlanResponse): Promise<boolean>;
}

/**
 * Turns any failure from the api client into a message safe to put in
 * front of a user. Service-side error bodies are constants that never
 * carry a filesystem path (routes.ts), so a `VaultSetupRequestError`'s
 * message may be displayed verbatim; anything else gets a constant.
 */
export function describeSetupFailure(_error: unknown): string {
  throw new Error("describeSetupFailure is not implemented yet");
}

/**
 * Plan, confirm, apply. Every failure path ends in a notice rather than a
 * rejected promise, because this runs from a command callback where a
 * rejection has nowhere to go but the developer console.
 */
export function runVaultSetup(_ui: VaultSetupUi, _client: SocketApiClient): Promise<void> {
  throw new Error("runVaultSetup is not implemented yet");
}

/**
 * Registers the command through the host-registry seam (never
 * `plugin.addCommand` directly), so unload completeness stays provable --
 * see `lifecycle.test.ts`'s twenty-cycle proof, which exercises THIS
 * function rather than a hand-written stand-in for it.
 */
export function registerVaultSetupCommand(
  registry: HostRegistry,
  ui: VaultSetupUi,
  client: SocketApiClient,
): void {
  registry.command({
    id: VAULT_SETUP_COMMAND_ID,
    name: VAULT_SETUP_COMMAND_NAME,
    callback: () => {
      void runVaultSetup(ui, client);
    },
  });
}
