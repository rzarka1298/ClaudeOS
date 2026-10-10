import type { ApprovalSummary, ProposalState } from "@ccc/domain";

/**
 * The approval notification (APPR-09, D-26): a pure decision, generic content
 * and a notifier whose every side effect is injected.
 *
 * Nothing here can act on a request. The notification has no action buttons,
 * and its click only brings Obsidian forward and selects the request; the
 * module imports no service client at all (asserted by a source scan in the
 * test), so a banner on a lock screen can inform but never settle anything.
 */

/** The notification title. Fixed: never built from a request. */
export const NOTIFY_TITLE = "Approval needed";

/** The Obsidian Notice used when a native notification is not the right or possible channel. */
export const NOTIFY_NOTICE_TEXT =
  'Approval needed. Run "Open approval inbox" from the command palette to review it.';

/**
 * A request created this long before the plugin loaded still counts as new,
 * so one raised in the instant around a reload is not lost. Anything older is
 * a snapshot replay and stays quiet (Pitfall 10).
 */
export const NOTIFY_GRACE_MS = 5_000;

/** The requester part of the body is cut to this many characters (UI-SPEC). */
const REQUESTER_BODY_MAX = 40;

/** Remembered proposal ids per load; the oldest is forgotten past this many. */
const SEEN_CAP = 500;

export type NotificationChoice = "native" | "notice" | "none";

/** Everything {@link decideNotification} reads, so it stays a pure function. */
export interface NotifyFacts {
  readonly enabled: boolean;
  /** Whether Obsidian (any window) has focus. */
  readonly focused: boolean;
  /** Whether the Approvals section is on screen. */
  readonly sectionVisible: boolean;
  readonly state: ProposalState;
  /** The request's creation time in epoch milliseconds, `NaN` when unparseable. */
  readonly createdAtMs: number;
  readonly loadedAtMs: number;
  readonly graceMs: number;
  /** Whether this proposal id was already seen during this load. */
  readonly alreadySeen: boolean;
}

/**
 * Decides how a request is announced. A request is only announced when it is
 * new: pending, never seen in this load, and created at or after the load time
 * minus the grace window. Then: Obsidian unfocused gives a native notification
 * (when switched on); focused with the section on screen gives nothing; focused
 * with it off screen gives an Obsidian Notice, which the setting does not gate.
 */
export function decideNotification(facts: NotifyFacts): NotificationChoice {
  if (facts.state !== "pending") return "none";
  if (facts.alreadySeen) return "none";
  // A time that cannot be read fails closed: no announcement.
  if (!(facts.createdAtMs >= facts.loadedAtMs - facts.graceMs)) return "none";
  if (!facts.focused) return facts.enabled ? "native" : "none";
  return facts.sectionVisible ? "none" : "notice";
}

/** The part of a web notification the notifier touches. */
export interface NotificationHandle {
  onclick: (() => void) | null;
}

/** The only options a notification is ever created with: no actions, no icon, no data. */
export interface NotificationShape {
  readonly body: string;
  readonly tag: string;
  readonly silent: boolean;
}

export interface NotificationContent extends NotificationShape {
  readonly title: string;
}

const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

const KIND_FALLBACK: Readonly<Record<string, string>> = {
  skill: "A skill",
  automation: "An automation",
  connector: "A connector",
};

function requesterText(summary: ApprovalSummary): string {
  if (summary.requesterKind === "dashboard") return "The dashboard";
  const stripped = summary.requesterLabel
    .replace(CONTROL_OR_FORMAT, "")
    .replace(/\s+/gu, " ")
    .trim();
  const cut = [...stripped].slice(0, REQUESTER_BODY_MAX).join("").trim();
  return cut === "" ? (KIND_FALLBACK[summary.requesterKind] ?? "A request") : cut;
}

function actionText(summary: ApprovalSummary): string {
  const label = summary.operationLabel;
  // The service's fallback for an operation the table does not know: it is not a verb phrase.
  if (label === "Unknown request" || label === "") return "make a request";
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/**
 * The notification's whole content. It reads the requester and the templated
 * operation label and nothing else: never the title (which can name a target),
 * the project, the run, the outcome or the expiry.
 */
export function notificationContent(summary: ApprovalSummary): NotificationContent {
  return {
    title: NOTIFY_TITLE,
    body: `${requesterText(summary)} asks to ${actionText(summary)}.`,
    tag: summary.proposalId,
    silent: false,
  };
}

/**
 * Creates a web notification, or `null` when none can be shown: the
 * constructor is unavailable, the permission is denied, or it throws. Never
 * throws itself (spike S7).
 */
export function createWebNotification(
  title: string,
  options: NotificationShape,
): NotificationHandle | null {
  try {
    if (typeof Notification === "undefined") return null;
    if (Notification.permission === "denied") return null;
    const notification = new Notification(title, {
      body: options.body,
      tag: options.tag,
      silent: options.silent,
    });
    let current: (() => void) | null = null;
    return {
      get onclick() {
        return current;
      },
      set onclick(callback: (() => void) | null) {
        current = callback;
        notification.onclick =
          callback === null
            ? null
            : () => {
                callback();
              };
      },
    };
  } catch {
    return null;
  }
}

export interface NotifyDeps {
  /** `settings.notifyApprovals`. */
  readonly enabled: () => boolean;
  /** Whether Obsidian has focus; in production `activeDocument.hasFocus()` so popout windows count. */
  readonly appFocused: () => boolean;
  /** Whether the Approvals section is on screen. */
  readonly approvalsVisible: () => boolean;
  /** An Obsidian Notice. */
  readonly notice: (message: string) => void;
  /** Builds the notification, or `null` when none can be shown. Must not throw. */
  readonly create: (title: string, options: NotificationShape) => NotificationHandle | null;
  /** Brings Obsidian forward. The one place the focus mechanism lives. */
  readonly focusWindow: () => void;
  /** Selects the request, by the same navigation the deep link uses. */
  readonly select: (proposalId: string) => void;
  readonly now: () => number;
  /** When the plugin loaded, in epoch milliseconds; defaults to `now()` at construction. */
  readonly loadedAt?: number;
  readonly graceMs?: number;
}

/**
 * Builds the `onUpsert` function the approval upsert hook calls. It never
 * throws: a missing, denied or failing notification falls back to a Notice.
 */
export function createApprovalNotifier(deps: NotifyDeps): (summary: ApprovalSummary) => void {
  const loadedAtMs = deps.loadedAt ?? deps.now();
  const graceMs = deps.graceMs ?? NOTIFY_GRACE_MS;
  const seen = new Set<string>();

  function remember(proposalId: string): void {
    seen.add(proposalId);
    if (seen.size > SEEN_CAP) {
      const oldest = seen.values().next();
      if (oldest.done !== true) seen.delete(oldest.value);
    }
  }

  function showNotice(): void {
    try {
      deps.notice(NOTIFY_NOTICE_TEXT);
    } catch {
      // A failing notice must never reach the event pipeline that called us.
    }
  }

  function showNative(summary: ApprovalSummary): void {
    let handle: NotificationHandle | null = null;
    try {
      const { title, ...options } = notificationContent(summary);
      handle = deps.create(title, options);
    } catch {
      handle = null;
    }
    if (handle === null) {
      showNotice();
      return;
    }
    const proposalId = summary.proposalId;
    handle.onclick = () => {
      deps.focusWindow();
      deps.select(proposalId);
    };
  }

  return (summary) => {
    try {
      const choice = decideNotification({
        enabled: deps.enabled(),
        focused: deps.appFocused(),
        sectionVisible: deps.approvalsVisible(),
        state: summary.state,
        createdAtMs: Date.parse(summary.createdAt),
        loadedAtMs,
        graceMs,
        alreadySeen: seen.has(summary.proposalId),
      });
      if (summary.state === "pending") remember(summary.proposalId);
      if (choice === "native") showNative(summary);
      else if (choice === "notice") showNotice();
    } catch {
      // Same rule: nothing here may throw into the caller.
    }
  };
}
