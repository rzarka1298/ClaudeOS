import type { VaultSetupPlanResponse } from "@ccc/domain";
import type { SocketApiClient } from "@ccc/service-api-client";
import {
  requestVaultSetup,
  requestVaultSetupPlan,
  SocketUnreachableError,
  VaultSetupRequestError,
} from "@ccc/service-api-client";
import { type App, FileSystemAdapter, Modal, Notice } from "obsidian";
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
export function describeSetupFailure(error: unknown): string {
  if (error instanceof SocketUnreachableError) return SERVICE_UNREACHABLE_MESSAGE;
  if (error instanceof VaultSetupRequestError) return error.message;
  return UNEXPECTED_FAILURE_MESSAGE;
}

/**
 * Plan, confirm, apply. Every failure path ends in a notice rather than a
 * rejected promise, because this runs from a command callback where a
 * rejection has nowhere to go but the developer console.
 *
 * The ordering is the requirement, not an implementation detail: the plan
 * is fetched and displayed, and `requestVaultSetup` is reached ONLY
 * through an affirmative `confirmPlan`. A cancel returns without a second
 * call, so nothing is written and nothing needs undoing.
 */
export async function runVaultSetup(ui: VaultSetupUi, client: SocketApiClient): Promise<void> {
  const vaultRoot = ui.resolveVaultPath();
  if (vaultRoot === null) {
    ui.notify(NO_LOCAL_VAULT_MESSAGE);
    return;
  }

  let plan: VaultSetupPlanResponse;
  try {
    plan = await requestVaultSetupPlan(client, vaultRoot);
  } catch (error: unknown) {
    ui.notify(describeSetupFailure(error));
    return;
  }

  if (!(await ui.confirmPlan(plan))) return;

  try {
    const result = await requestVaultSetup(client, vaultRoot);
    ui.notify(
      `Managed vault ready: ${result.created.length} created, ${result.existing.length} already present.`,
    );
  } catch (error: unknown) {
    ui.notify(describeSetupFailure(error));
  }
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

/** The two words each row ends in, so the state is read rather than inferred. */
const WILL_CREATE_LABEL = "will create";
const ALREADY_EXISTS_LABEL = "already exists";

/**
 * The confirmation modal. Structural markup and Obsidian's own defaults
 * only -- Phase 3 owns the visual identity (UI-01/UI-02) and this must not
 * pre-empt that gate, so there is no styling here beyond what Obsidian
 * gives a modal for free.
 *
 * Every row comes from `plan.entries`. There is no fallback list and no
 * "and others" elision: a plan the modal cannot fully display is a plan
 * the user cannot fully consent to.
 */
class VaultSetupConfirmModal extends Modal {
  private readonly plan: VaultSetupPlanResponse;
  private readonly decide: (confirmed: boolean) => void;
  private settled = false;

  constructor(app: App, plan: VaultSetupPlanResponse, decide: (confirmed: boolean) => void) {
    super(app);
    this.plan = plan;
    this.decide = decide;
  }

  /**
   * Resolves the caller's promise exactly once. `onClose` also calls this,
   * so dismissing the modal with Escape or a click outside resolves
   * `false` rather than leaving `runVaultSetup` awaiting forever.
   */
  private settle(confirmed: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.decide(confirmed);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: VAULT_SETUP_COMMAND_NAME });
    contentEl.createEl("p", {
      text: "These are the exact paths setup will touch in this vault:",
    });

    const list = contentEl.createEl("ul");
    for (const entry of this.plan.entries) {
      list.createEl("li", {
        text: `${entry.relativePath} — ${entry.exists ? ALREADY_EXISTS_LABEL : WILL_CREATE_LABEL}`,
      });
    }

    contentEl.createEl("p", {
      text: "Existing folders and notes are left as they are.",
    });

    // Listeners live on elements this modal creates and `onClose` empties,
    // so they are released with the nodes themselves rather than
    // outliving the modal -- nothing here escapes into Obsidian's own
    // long-lived surfaces, which is what the host-registry seam exists to
    // track.
    const buttons = contentEl.createDiv();
    const confirm = buttons.createEl("button", { text: "Confirm" });
    confirm.addEventListener("click", () => {
      this.settle(true);
      this.close();
    });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => {
      this.settle(false);
      this.close();
    });
  }

  onClose(): void {
    // Dismissal is a refusal: anything other than the confirm button
    // means the user did not agree, so setup must not run.
    this.settle(false);
    this.contentEl.empty();
  }
}

/**
 * The production {@link VaultSetupUi}. The only place in this plugin that
 * touches Obsidian's modal and notice surfaces for vault setup, so
 * `runVaultSetup`'s logic stays testable without any of them.
 */
export function createObsidianVaultSetupUi(app: App): VaultSetupUi {
  return {
    resolveVaultPath(): string | null {
      // `instanceof` rather than a cast: a vault backed by a non-filesystem
      // adapter genuinely has no path for the service to set up, and
      // pretending otherwise would send the service a fabricated path.
      const { adapter } = app.vault;
      return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
    },
    notify(message: string): void {
      new Notice(message);
    },
    confirmPlan(plan: VaultSetupPlanResponse): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        new VaultSetupConfirmModal(app, plan, resolve).open();
      });
    },
  };
}
