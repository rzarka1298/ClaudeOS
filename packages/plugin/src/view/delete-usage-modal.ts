import { type App, ButtonComponent, Modal } from "obsidian";

/**
 * The delete-usage confirmation modal (UI-SPEC S4-d, D-46, USAGE-08) -- a
 * direct gesture, not a Proposal (T-05-41: no approval routing, confirmation
 * modal with initial focus on Cancel and destructive styling is the whole
 * mitigation).
 *
 * `deleteUsageViewModel` is the whole DECISION, pure and testable without
 * Obsidian's DOM (the `applyReducedMotionChange` pattern, UI-SPEC S4 shared
 * rules: "Each modal's decision logic is a pure view-model function"). The
 * `Modal` subclass stays a thin renderer over it.
 */

export const DELETE_USAGE_MODAL_TITLE = "Delete cached usage analytics?";
export const DELETE_USAGE_MODAL_BODY_1 =
  "This deletes the token counts, cost estimates, plan usage history and transcript coverage records the companion service has stored.";
export const DELETE_USAGE_CONFIRM_LABEL = "Delete usage analytics";
export const DELETE_USAGE_CANCEL_LABEL = "Cancel";

/**
 * Month-name date, no `/` (R-17, PRIV-04's no-slash rule). Fixed to UTC: the
 * horizon is a CALENDAR date derived from `cleanupPeriodDays`, and formatting
 * it in the local zone would make the same instant render as a different day
 * depending on the machine's offset (an instant near local midnight would be
 * off by one day around half the world) -- deterministic beats "technically
 * local" for a single date this coarse.
 */
const HORIZON_DATE_FORMAT = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * The body-2 clause naming how far back deleted totals could be rebuilt
 * from. A `null` horizon (the service hasn't reported `cleanupPeriodDays`
 * yet, or is down) never invents a date -- it drops the clause entirely
 * rather than guessing (data-integrity constraint: unavailable is never a
 * fabricated value).
 */
function horizonClause(horizonDate: string | null): string {
  if (horizonDate === null) return "";
  return ` Totals can only be rebuilt from transcripts Claude Code still keeps, back to ${HORIZON_DATE_FORMAT.format(new Date(horizonDate))}.`;
}

export interface DeleteUsageViewModelButton {
  readonly label: string;
  readonly destructive: boolean;
}

export interface DeleteUsageViewModel {
  readonly title: string;
  readonly bodies: readonly [string, string];
  readonly buttons: readonly [DeleteUsageViewModelButton, DeleteUsageViewModelButton];
  readonly initialFocus: "cancel";
}

/**
 * The whole decision: title, both body paragraphs (the second one carrying
 * the retention horizon when known) and button order/styling. `horizonDate`
 * is an ISO instant, typically `now - cleanupPeriodDays days` -- computed by
 * the settings tab from the already-fetched `ClaudeIntegrationStatus`, never
 * by this module.
 */
export function deleteUsageViewModel(horizonDate: string | null): DeleteUsageViewModel {
  return {
    title: DELETE_USAGE_MODAL_TITLE,
    bodies: [
      DELETE_USAGE_MODAL_BODY_1,
      `Your session history and Claude Code's own transcripts aren't touched.${horizonClause(horizonDate)}`,
    ],
    buttons: [
      { label: DELETE_USAGE_CONFIRM_LABEL, destructive: true },
      { label: DELETE_USAGE_CANCEL_LABEL, destructive: false },
    ],
    initialFocus: "cancel",
  };
}

/**
 * A thin renderer over {@link deleteUsageViewModel}. Single-settle, like
 * `setup-command.ts`'s `VaultSetupConfirmModal`: `onClose` (Escape, a click
 * outside, or a plain `close()`) resolves `false`, so dismissing the modal
 * is a refusal and never strands the caller's promise.
 *
 * `confirm()` is public rather than a private closure inside the destructive
 * button's `onClick`, so it is reachable both from that button and directly
 * under test -- the shared `ButtonComponent` stub is deliberately inert (it
 * does not wire a real DOM click), matching every other modal in this
 * codebase; what a unit test proves is this method's own settle-once
 * contract, not a simulated click.
 */
export class DeleteUsageModal extends Modal {
  private readonly viewModel: DeleteUsageViewModel;
  private readonly decide: (confirmed: boolean) => void;
  private settled = false;

  constructor(app: App, horizonDate: string | null, decide: (confirmed: boolean) => void) {
    super(app);
    this.viewModel = deleteUsageViewModel(horizonDate);
    this.decide = decide;
  }

  /** Confirms the deletion and closes. */
  confirm(): void {
    this.settle(true);
    this.close();
  }

  private settle(confirmed: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.decide(confirmed);
  }

  onOpen(): void {
    const { titleEl, contentEl } = this;
    titleEl.setText(this.viewModel.title);
    for (const body of this.viewModel.bodies) {
      contentEl.createEl("p", { text: body });
    }

    const buttonRow = contentEl.createDiv();
    // Destructive primary action first (UI-SPEC S4-d button order), Cancel
    // second -- but INITIAL FOCUS still goes to Cancel (the safest option,
    // S4 shared rule), regardless of DOM order.
    new ButtonComponent(buttonRow)
      .setButtonText(DELETE_USAGE_CONFIRM_LABEL)
      .setDestructive()
      .setCta()
      .onClick(() => this.confirm());
    const cancelButton = new ButtonComponent(buttonRow)
      .setButtonText(DELETE_USAGE_CANCEL_LABEL)
      .onClick(() => {
        this.settle(false);
        this.close();
      });
    cancelButton.buttonEl.focus();
  }

  onClose(): void {
    // Dismissal is a refusal: anything other than the confirm button means
    // the deletion did not happen.
    this.settle(false);
    this.contentEl.empty();
  }
}

/** The production factory: opens the modal, resolving once the user decides. */
export function openDeleteUsageModal(app: App, horizonDate: string | null): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    new DeleteUsageModal(app, horizonDate, resolve).open();
  });
}
