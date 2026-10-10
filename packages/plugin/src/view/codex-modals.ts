import { type App, ButtonComponent, Modal } from "obsidian";
import {
  type ModalButtonView,
  type TranscriptChoice,
  TranscriptWarningModal,
  type TranscriptWarningViewModel,
} from "./session-modals.js";

/**
 * The Codex warnings and the fixed outcome copy behind `Open transcript` and
 * `Follow live log` (05.1 UI-SPEC S3, D-29, CODEX-07; plan 05.1-19).
 *
 * Both warnings show on EVERY open. No view model here has a remember,
 * don't-ask-again or persisted field -- there is nothing for a caller to
 * store (the Phase 5 SESS-15 rule, carried over). The modals are Obsidian
 * chrome: native styling, no design token (UI-SPEC non-negotiable 11).
 */

const TRANSCRIPT_TITLE = "Open this transcript?";
const TRANSCRIPT_BODY_1 =
  "Codex stores this transcript on your Mac as plain text. Anything readable by your user account can read it.";
const TRANSCRIPT_BODY_2 =
  "Codex decides how long it keeps it. This app doesn't manage, copy or protect it.";

/**
 * The Codex transcript warning (S3-a): the same shape the Claude one uses
 * ({@link TranscriptWarningViewModel}), so the existing `TranscriptWarningModal`
 * renders it unchanged. A fresh object on every call.
 */
export function codexTranscriptWarningViewModel(): TranscriptWarningViewModel {
  const buttons: readonly [ModalButtonView, ModalButtonView, ModalButtonView] = [
    { label: "Show in Finder", cta: true, destructive: false },
    { label: "Open with default app", cta: false, destructive: false },
    { label: "Cancel", cta: false, destructive: false },
  ];
  return {
    title: TRANSCRIPT_TITLE,
    bodies: [TRANSCRIPT_BODY_1, TRANSCRIPT_BODY_2],
    buttons,
    initialFocus: "cancel",
  };
}

/**
 * The fixed reason vocabulary (UI-SPEC S3): the ONLY words a Codex action
 * failure ever shows. No path, thread id or process text can appear in one.
 */
export const CODEX_REASONS = [
  "the file wasn't found",
  "it isn't in Codex's sessions folder",
  "the run has ended",
  "the bridge isn't installed",
  "the bridge is out of date",
  "Antigravity is still starting",
  "the service didn't respond",
] as const;
export type CodexReason = (typeof CODEX_REASONS)[number];

const SERVICE_DIDNT_RESPOND: CodexReason = "the service didn't respond";

/**
 * Every Codex action or client error code with its own named reason. Every
 * other code -- `invalid-request`, `unavailable`, `failed`, `timeout`,
 * `service-disconnected`, `unrecognised-response` -- and anything not in the
 * client's vocabulary at all falls to "the service didn't respond".
 */
const REASON_BY_CODE: Readonly<Record<string, CodexReason>> = {
  "not-found": "the file wasn't found",
  "outside-sessions-folder": "it isn't in Codex's sessions folder",
  "run-ended": "the run has ended",
  "bridge-not-installed": "the bridge isn't installed",
  "bridge-outdated": "the bridge is out of date",
  "window-not-ready": "Antigravity is still starting",
};

/** The one mapper from a client error code to a reason; unknown codes never surface raw. */
export function codexReasonFor(code: string): CodexReason {
  return Object.hasOwn(REASON_BY_CODE, code)
    ? (REASON_BY_CODE[code] ?? SERVICE_DIDNT_RESPOND)
    : SERVICE_DIDNT_RESPOND;
}

/** The acknowledgement, success and failure lines of one Codex row action (UI-SPEC S3 "Action feedback"). */
export interface CodexActionCopy {
  readonly pending: string;
  readonly success: string;
  readonly failure: (reason: CodexReason) => string;
}

export const CODEX_TRANSCRIPT_COPY: CodexActionCopy = {
  pending: "Opening transcript…",
  success: "✓ Transcript opened",
  failure: (reason) => `▲ Couldn't open the transcript: ${reason}.`,
};

export const CODEX_FOLLOW_COPY: CodexActionCopy = {
  pending: "Opening live log…",
  success: "✓ Live log opened in Antigravity",
  failure: (reason) => `▲ Couldn't follow the live log: ${reason}.`,
};

const FOLLOW_TITLE = "Follow this live log?";
const FOLLOW_BODY_1 =
  "The live log is plain text on your Mac and can include prompts, replies and file contents. Anything readable by your user account can read it.";
const FOLLOW_BODY_2 =
  "It opens as a tab in this project's Antigravity window and only reads the log. It doesn't send anything to Codex.";

/**
 * The follow-log warning (S3-b, R-16): its own, shorter modal, because the
 * live log can include prompts and file contents and the warning must be true
 * for what is read. Two buttons only; nothing in the shape can be remembered.
 */
export interface CodexFollowWarningViewModel {
  readonly title: string;
  readonly bodies: readonly [string, string];
  readonly buttons: readonly [ModalButtonView, ModalButtonView];
  readonly initialFocus: "cancel";
}

/** What `openCodexFollowWarning` resolves to. */
export type CodexFollowChoice = "follow" | "cancel";

export function codexFollowWarningViewModel(): CodexFollowWarningViewModel {
  return {
    title: FOLLOW_TITLE,
    bodies: [FOLLOW_BODY_1, FOLLOW_BODY_2],
    buttons: [
      { label: "Follow in Antigravity", cta: true, destructive: false },
      { label: "Cancel", cta: false, destructive: false },
    ],
    initialFocus: "cancel",
  };
}

/**
 * A thin renderer over {@link codexFollowWarningViewModel}. Single-settle, like
 * every modal in this plugin: `onClose` (Escape, a click outside) resolves
 * `"cancel"`, and a choice made first wins. It has no extra control, because
 * the view model has nothing to back one with (D-29).
 */
export class CodexFollowWarningModal extends Modal {
  private readonly vm: CodexFollowWarningViewModel;
  private readonly decide: (choice: CodexFollowChoice) => void;
  private settled = false;

  constructor(
    app: App,
    vm: CodexFollowWarningViewModel,
    decide: (choice: CodexFollowChoice) => void,
  ) {
    super(app);
    this.vm = vm;
    this.decide = decide;
  }

  private settle(choice: CodexFollowChoice): void {
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
    const [follow, cancel] = this.vm.buttons;
    new ButtonComponent(buttonRow)
      .setButtonText(follow.label)
      .setCta()
      .onClick(() => {
        this.settle("follow");
        this.close();
      });
    const cancelButton = new ButtonComponent(buttonRow).setButtonText(cancel.label).onClick(() => {
      this.settle("cancel");
      this.close();
    });
    // Initial focus on Cancel, the safest option (UI-SPEC S3-b).
    cancelButton.buttonEl.focus();
  }

  onClose(): void {
    this.settle("cancel");
    this.contentEl.empty();
  }
}

/** The two production openers, both always present (the runner's `ui` members are optional). */
export interface CodexUi {
  readonly openCodexTranscriptWarning: (
    vm: TranscriptWarningViewModel,
  ) => Promise<TranscriptChoice>;
  readonly openCodexFollowWarning: (vm: CodexFollowWarningViewModel) => Promise<CodexFollowChoice>;
}

/**
 * The production Codex openers, merged into the existing session-action `ui`
 * object by the view host. The transcript warning reuses
 * {@link TranscriptWarningModal}, which renders any three-button view model
 * and resolves reveal, open or cancel; only the follow warning needs its own
 * class. This and `session-modals.ts` are the only places the Codex flows
 * touch Obsidian's modal surface.
 */
export function createObsidianCodexUi(app: App): CodexUi {
  return {
    openCodexTranscriptWarning(vm: TranscriptWarningViewModel): Promise<TranscriptChoice> {
      return new Promise<TranscriptChoice>((resolve) => {
        new TranscriptWarningModal(app, vm, resolve).open();
      });
    },
    openCodexFollowWarning(vm: CodexFollowWarningViewModel): Promise<CodexFollowChoice> {
      return new Promise<CodexFollowChoice>((resolve) => {
        new CodexFollowWarningModal(app, vm, resolve).open();
      });
    },
  };
}
