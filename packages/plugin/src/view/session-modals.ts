import type { GuardConflict } from "@ccc/domain/ports.js";
import { NOT_REPORTED, RUN_STATE_DISPLAY } from "@ccc/domain/session.js";
import { WORKTREE_NAME_PATTERN, type WorktreeListResponse } from "@ccc/domain/session-actions.js";
import {
  type App,
  ButtonComponent,
  type FuzzyMatch,
  FuzzySuggestModal,
  type Instruction,
  Modal,
  Notice,
} from "obsidian";
import { formatRelativeTime } from "../widgets/relative-time.js";
import type { SessionActionUi } from "./session-action-runner.js";

/**
 * The five Phase 5 modals as pure view models plus thin Obsidian `Modal` or
 * `FuzzySuggestModal` renderers (UI-SPEC "S4 — Modals", S4 shared rules): the
 * concurrent-session choice with its worktree step (S4-a), the transcript
 * warning (S4-b, Task 3), the force-terminate request (S4-c, Task 3), and the
 * associate-with-project picker (S4-e). The delete-usage modal (S4-d) already
 * exists (05-07, `delete-usage-modal.ts`) and is not touched here.
 *
 * Every string is a module constant, verbatim from UI-SPEC and sentence
 * case. No `--ccc-*` token and no `ccc-` class: this module renders in
 * Obsidian's own chrome only (Non-Negotiable 8), proven by a source scan in
 * `session-modals.test.ts`.
 */

// ---------------------------------------------------------------------------
// S4-a: concurrent-session choice (SESS-10, SESS-11, D-27, D-28)
// ---------------------------------------------------------------------------

const CONCURRENT_CHOICE_TITLE = "This working tree already has a Claude session";

export type ConcurrentChoiceButtonId = "continue" | "worktree" | "plan" | "cancel";

export interface ConcurrentChoiceButtonView {
  readonly id: ConcurrentChoiceButtonId;
  readonly label: string;
  readonly consequence: string;
  readonly cta: boolean;
}

/** Fixed, in this order (UI-SPEC "Choices" table). */
const CONCURRENT_CHOICE_BUTTONS: readonly ConcurrentChoiceButtonView[] = [
  {
    id: "continue",
    label: "Continue in this working tree",
    consequence: "Both sessions can edit the same files, and their changes may collide.",
    cta: false,
  },
  {
    id: "worktree",
    label: "Use an isolated worktree",
    consequence:
      "Pick an existing worktree or let Claude Code create one. The dashboard doesn't change Git itself.",
    cta: true,
  },
  {
    id: "plan",
    label: "Read-only investigation (plan mode)",
    consequence:
      "Claude plans without editing files. If auto mode is available, it can still run commands its classifier approves.",
    cta: false,
  },
  {
    id: "cancel",
    label: "Cancel",
    consequence: "Don't launch anything.",
    cta: false,
  },
];

export interface ConcurrentChoiceItemView {
  readonly runId: string;
  readonly text: string;
}

export interface ConcurrentChoiceViewModel {
  readonly title: string;
  readonly lead: string;
  readonly items: readonly ConcurrentChoiceItemView[];
  readonly choices: readonly ConcurrentChoiceButtonView[];
  readonly initialFocus: "cancel";
}

function concurrentConflictItemText(conflict: GuardConflict, nowMs: number): string {
  const active =
    conflict.lastActivityAt === null
      ? NOT_REPORTED
      : formatRelativeTime(conflict.lastActivityAt, nowMs);
  const staleSuffix = conflict.state === "stale" ? " — it may still be running" : "";
  return `${conflict.sessionName} — ${RUN_STATE_DISPLAY[conflict.state].label}, active ${active}${staleSuffix}`;
}

/**
 * The whole DECISION for S4-a's first step: title, lead (singular/plural),
 * every conflict's item text, the four fixed choices, and initial focus.
 * `sessionName` on each conflict already carries the "Session {id8}"
 * fallback (`sessionDisplayName`, computed service-side — `launch-guard.ts`).
 */
export function concurrentChoiceViewModel(
  conflicts: readonly GuardConflict[],
  projectName: string,
  nowMs: number,
): ConcurrentChoiceViewModel {
  const lead =
    conflicts.length === 1
      ? `Another Claude session can write to ${projectName}'s working tree:`
      : `${conflicts.length} other Claude sessions can write to ${projectName}'s working tree:`;
  return {
    title: CONCURRENT_CHOICE_TITLE,
    lead,
    items: conflicts.map((conflict) => ({
      runId: conflict.runId,
      text: concurrentConflictItemText(conflict, nowMs),
    })),
    choices: CONCURRENT_CHOICE_BUTTONS,
    initialFocus: "cancel",
  };
}

// ---------------------------------------------------------------------------
// S4-a worktree step (SESS-11, D-28, D-30)
// ---------------------------------------------------------------------------

export type WorktreeOption = WorktreeListResponse["worktrees"][number];
/** What `loadWorktrees()` (injected into `openConcurrentChoice`) resolves to. */
export type WorktreeListResult = readonly WorktreeOption[] | "failed";
/** What the pure view model accepts -- the Modal also renders a transient `"loading"` state while `loadWorktrees()` is pending. */
export type WorktreeListState = WorktreeListResult | "loading";

export interface WorktreeRadioOption {
  readonly id: string;
  readonly label: string;
}

export interface WorktreeStepViewModel {
  readonly title: string;
  readonly legend: string;
  readonly listState: "ready" | "loading" | "failed";
  readonly options: readonly WorktreeRadioOption[];
  readonly newWorktreeOptionLabel: string;
  readonly namePlaceholder: string;
  readonly loadingMessage: string | null;
  readonly listFailureMessage: string | null;
  readonly launchLabel: string;
  readonly backLabel: string;
}

const WORKTREE_STEP_TITLE = "Choose a worktree";
const WORKTREE_LEGEND = "Worktree";
export const NEW_WORKTREE_OPTION_LABEL = "New worktree created by Claude Code";
const WORKTREE_NAME_PLACEHOLDER = "fix-parser";
export const WORKTREE_LOADING_MESSAGE = "Checking worktrees…";
export const WORKTREE_LIST_FAILURE_MESSAGE =
  "Couldn't list existing worktrees. You can still name a new one.";
const WORKTREE_LAUNCH_LABEL = "Launch in worktree";
const WORKTREE_BACK_LABEL = "Back";

/**
 * The whole DECISION for the worktree step's list rendering: existing
 * worktrees as `{branch} — {folder basename}` radios, the fixed new-worktree
 * option, and the three list states (Test 2, UI Considerations E9 loading/
 * error/partial rows).
 */
export function worktreeStepViewModel(list: WorktreeListState): WorktreeStepViewModel {
  const listState = list === "loading" ? "loading" : list === "failed" ? "failed" : "ready";
  const options = Array.isArray(list)
    ? list.map((entry: WorktreeOption) => ({
        id: entry.worktreeId,
        label: `${entry.branch} — ${entry.folderBasename}`,
      }))
    : [];
  return {
    title: WORKTREE_STEP_TITLE,
    legend: WORKTREE_LEGEND,
    listState,
    options,
    newWorktreeOptionLabel: NEW_WORKTREE_OPTION_LABEL,
    namePlaceholder: WORKTREE_NAME_PLACEHOLDER,
    loadingMessage: listState === "loading" ? WORKTREE_LOADING_MESSAGE : null,
    listFailureMessage: listState === "failed" ? WORKTREE_LIST_FAILURE_MESSAGE : null,
    launchLabel: WORKTREE_LAUNCH_LABEL,
    backLabel: WORKTREE_BACK_LABEL,
  };
}

export const WORKTREE_NAME_INVALID_MESSAGE =
  "Use letters, numbers, dots, dashes or underscores, up to 64 characters.";
export const WORKTREE_NAME_DUPLICATE_MESSAGE =
  "A worktree with that name already exists. Pick another.";

/** `null` means valid. Mirrors the domain's own `WORKTREE_NAME_PATTERN` plus the `.`/`..` refusal (`session-actions.ts`) and the service's leading-`-` refusal (`session-action-routes.ts`, a name must never read as a flag), so a name the service would reject never even reaches the request. */
export function validateWorktreeName(
  name: string,
  existingNames: readonly string[] = [],
): string | null {
  if (!WORKTREE_NAME_PATTERN.test(name) || name === "." || name === ".." || name.startsWith("-")) {
    return WORKTREE_NAME_INVALID_MESSAGE;
  }
  if (existingNames.includes(name)) return WORKTREE_NAME_DUPLICATE_MESSAGE;
  return null;
}

export type WorktreeSelection =
  | { readonly kind: "existing"; readonly worktreeId: string }
  | { readonly kind: "new"; readonly name: string }
  | null;

/** `true` until a radio is picked (existing) or a valid new name is entered (UI-SPEC "the launch button is disabled until valid"). */
export function worktreeLaunchDisabled(
  selection: WorktreeSelection,
  existingNames: readonly string[] = [],
): boolean {
  if (selection === null) return true;
  if (selection.kind === "existing") return false;
  return validateWorktreeName(selection.name, existingNames) !== null;
}

// ---------------------------------------------------------------------------
// S4-a Modal (ConcurrentChoiceModal: both steps, one instance, one settle)
// ---------------------------------------------------------------------------

/** What `openConcurrentChoice` resolves to -- the four launch choices, or cancel. */
export type ConcurrentChoiceResolution =
  | { readonly kind: "continue" }
  | { readonly kind: "plan" }
  | { readonly kind: "existing-worktree"; readonly worktreeId: string }
  | { readonly kind: "new-worktree"; readonly name: string }
  | { readonly kind: "cancel" };

/**
 * Renders the four full-width choices, and -- without resolving -- swaps its
 * OWN content to the worktree step when "Use an isolated worktree" is
 * clicked, per UI-SPEC's "same modal, content replaced" instruction. `Back`
 * swaps back to the four choices. The one promise settles once, whichever
 * step it settles from.
 */
export class ConcurrentChoiceModal extends Modal {
  private readonly vm: ConcurrentChoiceViewModel;
  private readonly loadWorktrees: () => Promise<WorktreeListResult>;
  private readonly decide: (resolution: ConcurrentChoiceResolution) => void;
  private settled = false;
  private worktreeSelection: WorktreeSelection = null;
  private worktreeName = "";

  constructor(
    app: App,
    vm: ConcurrentChoiceViewModel,
    loadWorktrees: () => Promise<WorktreeListResult>,
    decide: (resolution: ConcurrentChoiceResolution) => void,
  ) {
    super(app);
    this.vm = vm;
    this.loadWorktrees = loadWorktrees;
    this.decide = decide;
  }

  private settle(resolution: ConcurrentChoiceResolution): void {
    if (this.settled) return;
    this.settled = true;
    this.decide(resolution);
  }

  onOpen(): void {
    this.renderChoices();
  }

  private renderChoices(): void {
    const { titleEl, contentEl } = this;
    contentEl.empty();
    titleEl.setText(this.vm.title);
    contentEl.createEl("p", { text: this.vm.lead });
    const list = contentEl.createEl("ul");
    for (const item of this.vm.items) {
      list.createEl("li", { text: item.text });
    }
    for (const choice of this.vm.choices) {
      const row = contentEl.createDiv();
      const button = new ButtonComponent(row).setButtonText(choice.label);
      if (choice.cta) button.setCta();
      button.onClick(() => this.handleChoice(choice.id));
      row.createEl("p", { text: choice.consequence });
    }
  }

  private handleChoice(id: ConcurrentChoiceButtonId): void {
    if (id === "cancel") {
      this.settle({ kind: "cancel" });
      this.close();
      return;
    }
    if (id === "worktree") {
      void this.showWorktreeStep();
      return;
    }
    this.settle({ kind: id });
    this.close();
  }

  private async showWorktreeStep(): Promise<void> {
    this.renderWorktreeStep(worktreeStepViewModel("loading"));
    const list = await this.loadWorktrees();
    this.renderWorktreeStep(worktreeStepViewModel(list));
  }

  private renderWorktreeStep(stepVm: WorktreeStepViewModel): void {
    const { titleEl, contentEl } = this;
    contentEl.empty();
    titleEl.setText(stepVm.title);
    if (stepVm.loadingMessage !== null) contentEl.createEl("p", { text: stepVm.loadingMessage });
    if (stepVm.listFailureMessage !== null)
      contentEl.createEl("p", { text: stepVm.listFailureMessage });

    const fieldset = contentEl.createEl("fieldset");
    fieldset.createEl("legend", { text: stepVm.legend });
    for (const option of stepVm.options) {
      const row = fieldset.createDiv();
      row.addEventListener("click", () => {
        this.worktreeSelection = { kind: "existing", worktreeId: option.id };
      });
      row.createEl("p", { text: option.label });
    }
    const newRow = fieldset.createDiv();
    newRow.addEventListener("click", () => {
      this.worktreeSelection = { kind: "new", name: this.worktreeName };
    });
    newRow.createEl("p", { text: stepVm.newWorktreeOptionLabel });
    fieldset.createEl("input", { type: "text", placeholder: stepVm.namePlaceholder }, (input) => {
      input.addEventListener("input", () => {
        this.worktreeName = input.value;
        if (this.worktreeSelection?.kind === "new") {
          this.worktreeSelection = { kind: "new", name: input.value };
        }
      });
    });

    const buttonRow = contentEl.createDiv();
    new ButtonComponent(buttonRow)
      .setButtonText(stepVm.launchLabel)
      .setCta()
      .setDisabled(worktreeLaunchDisabled(this.worktreeSelection))
      .onClick(() => this.launchWorktree());
    new ButtonComponent(buttonRow)
      .setButtonText(stepVm.backLabel)
      .onClick(() => this.renderChoices());
  }

  private launchWorktree(): void {
    const selection = this.worktreeSelection;
    if (selection === null || worktreeLaunchDisabled(selection)) return;
    const resolution: ConcurrentChoiceResolution =
      selection.kind === "existing"
        ? { kind: "existing-worktree", worktreeId: selection.worktreeId }
        : { kind: "new-worktree", name: selection.name };
    this.settle(resolution);
    this.close();
  }

  onClose(): void {
    this.settle({ kind: "cancel" });
    this.contentEl.empty();
  }
}

// ---------------------------------------------------------------------------
// S4-e: associate with project (SESS-17, D-24)
// ---------------------------------------------------------------------------

export interface ProjectOption {
  readonly id: string;
  readonly name: string;
  /** Pinned projects come first when the query is empty (UI-SPEC S4-e, matching the Phase 4 palette). */
  readonly pinned?: boolean;
}

export interface AssociateInstructionView {
  readonly command: string;
  readonly purpose: string;
}

export interface AssociatePickerViewModel {
  readonly placeholder: string;
  readonly instructions: readonly AssociateInstructionView[];
  readonly emptyMessage: string;
}

const ASSOCIATE_INSTRUCTIONS: readonly AssociateInstructionView[] = [
  { command: "↑↓", purpose: "to navigate" },
  { command: "↵", purpose: "to associate" },
  { command: "esc", purpose: "to cancel" },
];

export const ASSOCIATE_EMPTY_MESSAGE =
  "No registered projects yet. Register one in Projects first.";

/** The whole DECISION for the picker's chrome: placeholder, instructions, and the fixed empty-list line. */
export function associatePickerViewModel(sessionName: string): AssociatePickerViewModel {
  return {
    placeholder: `Choose a project for ${sessionName}`,
    instructions: ASSOCIATE_INSTRUCTIONS,
    emptyMessage: ASSOCIATE_EMPTY_MESSAGE,
  };
}

/**
 * Registered projects only, over `FuzzySuggestModal<ProjectOption>`. There is
 * no confirmation step: choosing an item IS the gesture (UI-SPEC S4-e).
 * `onClose` (Escape, a click outside) resolves `null` -- a refusal, never a
 * pending promise -- one microtask later, so a pick always wins.
 */
export class AssociateProjectModal extends FuzzySuggestModal<ProjectOption> {
  /**
   * The whole decision, kept on OUR OWN instance rather than read back from
   * `SuggestModal`'s base fields: Obsidian's real `SuggestModal` exposes only
   * `setPlaceholder`/`setInstructions` SETTERS (no public getter for either),
   * so a test proving Test 6's "placeholder reads … with the three
   * instructions" reads it from here, not from the base class.
   */
  readonly viewModel: AssociatePickerViewModel;
  private readonly projects: readonly ProjectOption[];
  private readonly decide: (choice: ProjectOption | null) => void;
  private settled = false;

  constructor(
    app: App,
    sessionName: string,
    projects: readonly ProjectOption[],
    decide: (choice: ProjectOption | null) => void,
  ) {
    super(app);
    this.projects = projects;
    this.decide = decide;
    this.viewModel = associatePickerViewModel(sessionName);
    this.setPlaceholder(this.viewModel.placeholder);
    this.setInstructions(this.viewModel.instructions as unknown as Instruction[]);
    this.emptyStateText = projects.length === 0 ? this.viewModel.emptyMessage : "";
  }

  private settle(choice: ProjectOption | null): void {
    if (this.settled) return;
    this.settled = true;
    this.decide(choice);
  }

  getItems(): ProjectOption[] {
    return [...this.projects].sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false));
  }

  getItemText(item: ProjectOption): string {
    return item.name;
  }

  onChooseItem(item: ProjectOption, _evt: MouseEvent | KeyboardEvent): void {
    this.settle(item);
  }

  /**
   * Obsidian's `SuggestModal.selectSuggestion` calls `close()` BEFORE
   * `onChooseSuggestion` (wave 5 review), so `onClose` runs first on every
   * pick. Settling the pick here, before handing on to the base class, makes
   * the choice win whatever `onClose` then does.
   */
  selectSuggestion(value: FuzzyMatch<ProjectOption>, evt: MouseEvent | KeyboardEvent): void {
    this.settle(value.item);
    super.selectSuggestion(value, evt);
  }

  /**
   * Dismissal (Escape, a click outside) is a refusal -- but the `null` is
   * settled a microtask later, so any path that closes and then chooses in
   * the same tick still lets the choice win (settle-once keeps the first).
   */
  onClose(): void {
    this.contentEl.empty();
    queueMicrotask(() => this.settle(null));
  }
}

// ---------------------------------------------------------------------------
// S4-b: transcript plaintext warning (SESS-15, D-34) -- shown on EVERY open
// ---------------------------------------------------------------------------

export interface ModalButtonView {
  readonly label: string;
  readonly cta: boolean;
  readonly destructive: boolean;
}

export interface TranscriptWarningViewModel {
  readonly title: string;
  readonly bodies: readonly [string, string];
  readonly buttons: readonly [ModalButtonView, ModalButtonView, ModalButtonView];
  readonly initialFocus: "cancel";
}

const TRANSCRIPT_WARNING_TITLE = "Open this transcript?";
const TRANSCRIPT_WARNING_BODY_1 =
  "Claude Code stores this transcript on your Mac as plain text. Anything readable by your user account can read it.";
const SHOW_IN_FINDER_LABEL = "Show in Finder";
const OPEN_WITH_DEFAULT_APP_LABEL = "Open with default app";
const CANCEL_LABEL = "Cancel";

/**
 * The whole DECISION for S4-b: title, both body paragraphs (the second
 * naming the actual retention period), and the three fixed buttons. There is
 * NO "don't show again" or remember field anywhere in this shape -- by
 * requirement (SESS-15), the warning is never cached or skipped, so the
 * decision this function returns has nothing for a caller to persist.
 */
export function transcriptWarningViewModel(cleanupPeriodDays: number): TranscriptWarningViewModel {
  return {
    title: TRANSCRIPT_WARNING_TITLE,
    bodies: [
      TRANSCRIPT_WARNING_BODY_1,
      `Claude Code deletes it after ${cleanupPeriodDays} days (its cleanupPeriodDays setting). This app doesn't manage, copy or protect it.`,
    ],
    buttons: [
      { label: SHOW_IN_FINDER_LABEL, cta: true, destructive: false },
      { label: OPEN_WITH_DEFAULT_APP_LABEL, cta: false, destructive: false },
      { label: CANCEL_LABEL, cta: false, destructive: false },
    ],
    initialFocus: "cancel",
  };
}

/** What `openTranscriptWarning` resolves to. */
export type TranscriptChoice = "reveal" | "open" | "cancel";

/**
 * A thin renderer over {@link transcriptWarningViewModel}. Single-settle,
 * like every other modal here: `onClose` (Escape, a click outside) resolves
 * `"cancel"`. Renders no checkbox -- there is nothing in the view model to
 * back one with (SESS-15, D-34).
 */
export class TranscriptWarningModal extends Modal {
  private readonly vm: TranscriptWarningViewModel;
  private readonly decide: (choice: TranscriptChoice) => void;
  private settled = false;

  constructor(
    app: App,
    vm: TranscriptWarningViewModel,
    decide: (choice: TranscriptChoice) => void,
  ) {
    super(app);
    this.vm = vm;
    this.decide = decide;
  }

  private settle(choice: TranscriptChoice): void {
    if (this.settled) return;
    this.settled = true;
    this.decide(choice);
  }

  onOpen(): void {
    const { titleEl, contentEl } = this;
    titleEl.setText(this.vm.title);
    for (const body of this.vm.bodies) {
      contentEl.createEl("p", { text: body });
    }
    const buttonRow = contentEl.createDiv();
    const [reveal, open, cancel] = this.vm.buttons;
    new ButtonComponent(buttonRow)
      .setButtonText(reveal.label)
      .setCta()
      .onClick(() => {
        this.settle("reveal");
        this.close();
      });
    new ButtonComponent(buttonRow).setButtonText(open.label).onClick(() => {
      this.settle("open");
      this.close();
    });
    new ButtonComponent(buttonRow).setButtonText(cancel.label).onClick(() => {
      this.settle("cancel");
      this.close();
    });
  }

  onClose(): void {
    this.settle("cancel");
    this.contentEl.empty();
  }
}

// ---------------------------------------------------------------------------
// S4-c: force-terminate request (SESS-16, D-01) -- live after Phase 6 (PR-26)
// ---------------------------------------------------------------------------

export interface TerminateRequestViewModel {
  readonly title: string;
  readonly bodies: readonly [string, string, string];
  readonly buttons: readonly [ModalButtonView, ModalButtonView];
  readonly initialFocus: "cancel";
}

const TERMINATE_REQUEST_TITLE = "Request force-terminate?";
const SEND_TO_APPROVAL_INBOX_LABEL = "Send to approval inbox";

/**
 * The whole DECISION for S4-c: title, the three body paragraphs, and the two
 * buttons. There is NO typed-confirmation field anywhere in this shape (D-01)
 * -- the destructive primary button IS the whole confirmation, same as
 * `delete-usage-modal.ts`'s.
 */
export function terminateRequestViewModel(
  sessionName: string,
  projectName: string,
  graceSeconds: number,
): TerminateRequestViewModel {
  return {
    title: TERMINATE_REQUEST_TITLE,
    bodies: [
      `This sends a request to the approval inbox to stop ${sessionName} in ${projectName}.`,
      `Once you approve it there, the process gets a terminate signal, then a kill signal if it's still running after ${graceSeconds} seconds. Work in progress in that session is lost.`,
      "Nothing happens until you approve it.",
    ],
    buttons: [
      { label: SEND_TO_APPROVAL_INBOX_LABEL, cta: true, destructive: true },
      { label: CANCEL_LABEL, cta: false, destructive: false },
    ],
    initialFocus: "cancel",
  };
}

/** What `openTerminateRequest` resolves to. */
export type TerminateChoice = "send" | "cancel";

/** A thin renderer over {@link terminateRequestViewModel}. Single-settle; `onClose` resolves `"cancel"`. */
export class TerminateRequestModal extends Modal {
  private readonly vm: TerminateRequestViewModel;
  private readonly decide: (choice: TerminateChoice) => void;
  private settled = false;

  constructor(app: App, vm: TerminateRequestViewModel, decide: (choice: TerminateChoice) => void) {
    super(app);
    this.vm = vm;
    this.decide = decide;
  }

  private settle(choice: TerminateChoice): void {
    if (this.settled) return;
    this.settled = true;
    this.decide(choice);
  }

  onOpen(): void {
    const { titleEl, contentEl } = this;
    titleEl.setText(this.vm.title);
    for (const body of this.vm.bodies) {
      contentEl.createEl("p", { text: body });
    }
    const buttonRow = contentEl.createDiv();
    const [send, cancel] = this.vm.buttons;
    new ButtonComponent(buttonRow)
      .setButtonText(send.label)
      .setDestructive()
      .setCta()
      .onClick(() => {
        this.settle("send");
        this.close();
      });
    new ButtonComponent(buttonRow).setButtonText(cancel.label).onClick(() => {
      this.settle("cancel");
      this.close();
    });
  }

  onClose(): void {
    this.settle("cancel");
    this.contentEl.empty();
  }
}

// ---------------------------------------------------------------------------
// Production UI seam (Tasks 2-3 build it up; Task 3 adds the remaining openers)
// ---------------------------------------------------------------------------

/**
 * The production {@link SessionActionUi}, built like
 * `createObsidianVaultSetupUi` (setup-command.ts): the only place this
 * plugin's session-action flow touches Obsidian's modal and notice surfaces,
 * so `runSessionAction`'s logic stays testable without any of them.
 */
export function createObsidianSessionActionUi(app: App): SessionActionUi {
  return {
    notify(message: string): void {
      new Notice(message);
    },
    openConcurrentChoice(
      vm: ConcurrentChoiceViewModel,
      loadWorktrees: () => Promise<WorktreeListResult>,
    ): Promise<ConcurrentChoiceResolution> {
      return new Promise<ConcurrentChoiceResolution>((resolve) => {
        new ConcurrentChoiceModal(app, vm, loadWorktrees, resolve).open();
      });
    },
    openAssociatePicker(
      sessionName: string,
      projects: readonly ProjectOption[],
    ): Promise<ProjectOption | null> {
      return new Promise<ProjectOption | null>((resolve) => {
        new AssociateProjectModal(app, sessionName, projects, resolve).open();
      });
    },
    openTranscriptWarning(vm: TranscriptWarningViewModel): Promise<TranscriptChoice> {
      return new Promise<TranscriptChoice>((resolve) => {
        new TranscriptWarningModal(app, vm, resolve).open();
      });
    },
    openTerminateRequest(vm: TerminateRequestViewModel): Promise<TerminateChoice> {
      return new Promise<TerminateChoice>((resolve) => {
        new TerminateRequestModal(app, vm, resolve).open();
      });
    },
  };
}
