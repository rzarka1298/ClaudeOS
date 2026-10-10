/**
 * The static capability classification (D-04, D-05, D-10, APPR-01, APPR-02,
 * APPR-05). Every operation the product can perform has exactly one row here,
 * in one of three classes:
 *
 * - `approval-required`: waits in the approval inbox for an explicit decision.
 *   `enabled` rows have an executor; `reserved` rows are classified now so
 *   they fail closed, and have none until a later phase enables them.
 * - `no-approval`: allowed without a decision, with the reason stated.
 * - `direct-gesture`: the owner's own click is the decision, with the reason
 *   stated.
 *
 * The table is code, not data. There is no storage, setting, column or field
 * through which a row could be changed at run time, so there is nothing that
 * could express a standing or remembered choice: a decision covers one
 * request and never carries forward. A capability string this table does not
 * know classifies to nothing, and every caller treats nothing as "refuse".
 *
 * This file is browser-safe: no `node:` import, no I/O.
 */

export const CAPABILITY_CLASSES = ["approval-required", "no-approval", "direct-gesture"] as const;
export type CapabilityClass = (typeof CAPABILITY_CLASSES)[number];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** The longest any request may stay open: seven days (D-10). No row may exceed it. */
export const TTL_CEILING_MS = 7 * 24 * HOUR_MS;
/** The lifetime of a request whose operation does not set its own: 24 hours (D-10). */
export const DEFAULT_TTL_MS = 24 * HOUR_MS;
/** How long after approval an unclaimed approval may still be carried out (D-17, D-18). */
const DEFAULT_MAX_APPROVAL_AGE_MS = 5 * MINUTE_MS;

export interface ApprovalRow {
  readonly class: "approval-required";
  /** `enabled` has a registered executor; `reserved` has none and is refused at submit and execute. */
  readonly status: "enabled" | "reserved";
  /** How long a request stays open before it is denied automatically. Requesters may shorten, never lengthen. */
  readonly ttlMs: number;
  /** How long after approval the action may still begin; later, the approval lapses. */
  readonly maxApprovalAgeMs: number;
  /** Whether a claim interrupted by a restart may run again with the same key. */
  readonly retry: "idempotent" | "never";
  /** A decision is approve or deny only. The payload is never editable by the approver. */
  readonly modifiable: false;
  /** A fixed phrase naming the action, used in templated sentences. */
  readonly summary: string;
}

export interface OtherRow {
  readonly class: "no-approval" | "direct-gesture";
  /** Why this operation needs no approval. */
  readonly reason: string;
}

export type ClassificationRow = ApprovalRow | OtherRow;

/** The shape of any classification table, so a registry can be checked against an injected one (D-43). */
export type ClassificationTable = Readonly<Record<string, ClassificationRow>>;

/** Shared by the reserved rows: classified, never executable until a later phase enables them. */
const RESERVED_POLICY = {
  class: "approval-required",
  status: "reserved",
  ttlMs: DEFAULT_TTL_MS,
  maxApprovalAgeMs: DEFAULT_MAX_APPROVAL_AGE_MS,
  retry: "never",
  modifiable: false,
} as const;

export const CLASSIFICATION = {
  // --- approval-required, enabled ------------------------------------------
  "session.force-terminate": {
    class: "approval-required",
    status: "enabled",
    ttlMs: 15 * MINUTE_MS,
    maxApprovalAgeMs: DEFAULT_MAX_APPROVAL_AGE_MS,
    retry: "idempotent",
    modifiable: false,
    summary: "force-terminate a Claude session",
  },
  "diagnostic.test": {
    class: "approval-required",
    status: "enabled",
    ttlMs: DEFAULT_TTL_MS,
    maxApprovalAgeMs: DEFAULT_MAX_APPROVAL_AGE_MS,
    retry: "idempotent",
    modifiable: false,
    summary: "run a test that does nothing",
  },

  // --- approval-required, reserved (D-05, Codex finding 2) -----------------
  "vault.delete": { ...RESERVED_POLICY, summary: "delete a note from the vault" },
  "vault.cross-scope-move": {
    ...RESERVED_POLICY,
    summary: "move a note between knowledge scopes",
  },
  "hooks.install": { ...RESERVED_POLICY, summary: "install a Claude Code hook" },
  "automation.git-write": { ...RESERVED_POLICY, summary: "write to a Git repository" },
  publish: { ...RESERVED_POLICY, summary: "publish content outside this machine" },
  // A skill can do anything, so it fails closed until the skills phase classifies it.
  "skill.run": { ...RESERVED_POLICY, summary: "run a skill" },

  // --- direct gestures: the owner's own click is the decision --------------
  "launch.antigravity": {
    class: "direct-gesture",
    reason:
      "The owner clicks the launch control for a registered project; the click is the decision (D-05).",
  },
  "launch.claude-code": {
    class: "direct-gesture",
    reason:
      "The owner clicks the launch control for a registered project; the click is the decision (D-05).",
  },
  "launch.finder": {
    class: "direct-gesture",
    reason:
      "The owner clicks the launch control for a registered project; the click is the decision (D-05).",
  },
  "launch.github": {
    class: "direct-gesture",
    reason:
      "The owner clicks the launch control for a registered project; the click is the decision (D-05).",
  },
  "launch.claude-desktop": {
    class: "direct-gesture",
    reason: "The owner clicks the control to bring Claude Desktop forward (D-05).",
  },
  "project.registry": {
    class: "direct-gesture",
    reason:
      "Registering, editing and removing projects and scan folders are the owner's own settings clicks (D-05).",
  },
  "switcher.open": {
    class: "direct-gesture",
    reason: "Opening the quick switcher is a navigation the owner asks for (D-05).",
  },
  "session.focus": {
    class: "direct-gesture",
    reason: "The owner asks to bring a session's own terminal forward; nothing is changed (D-05).",
  },
  "session.resume": {
    class: "direct-gesture",
    reason:
      "The owner asks to resume a session in a new terminal; the click is the decision (D-05).",
  },
  "session.branch": {
    class: "direct-gesture",
    reason: "The owner asks to branch a session into a new one; the click is the decision (D-05).",
  },
  "session.open-transcript": {
    class: "direct-gesture",
    reason: "The owner asks to reveal or open a transcript; nothing is changed (D-05).",
  },
  "session.associate": {
    class: "direct-gesture",
    reason:
      "The owner attaches a session to a registered project; only the service's own record changes (D-05).",
  },
  "session.interrupt": {
    class: "direct-gesture",
    reason:
      "The control only focuses the session's terminal so the owner can interrupt it there; no signal is sent (PR-01, D-05).",
  },
  "usage.transcript-analysis-toggle": {
    class: "direct-gesture",
    reason: "The owner turns transcript analysis on or off in their own settings (D-05).",
  },
  "usage.delete-analytics": {
    class: "direct-gesture",
    reason:
      "The owner deletes the service's own cached usage analytics, which is regenerable and holds no vault content (D-05).",
  },
  "connect.navigate": {
    class: "direct-gesture",
    reason:
      "A connect control only navigates to the owner's own settings; it changes nothing by itself (D-05).",
  },

  // --- no-approval: allowed without a decision, with the reason ------------
  "vault.write-note": {
    class: "no-approval",
    reason:
      "A managed write inside the owner's own vault scope, written atomically and reversible by the owner (D-05).",
  },
  "vault.initialize": {
    class: "no-approval",
    reason: "Setup shows every path first and creates only the managed folder tree (D-05).",
  },
  "vault.repair-index": {
    class: "no-approval",
    reason:
      "A generated index is rebuilt from the notes it describes and never holds new content (D-05).",
  },
  "task.write": {
    class: "no-approval",
    reason:
      "A task is the owner's own note inside the managed vault; it is not a consequential external action (D-05).",
  },
  "approval.mirror-note": {
    class: "no-approval",
    reason:
      "The mirror note is a read-only, regenerable copy of a request; the decision is never made there (D-22).",
  },
  "store.write": {
    class: "no-approval",
    reason:
      "The service's own private operational store is internal state, not an external effect (D-05).",
  },
  "notify.local": {
    class: "no-approval",
    reason:
      "A local notification carries no content that can act and changes no state (D-05, D-26).",
  },
  "data.refresh": {
    class: "no-approval",
    reason: "Refreshing a read-only view re-reads data the owner already has access to (D-05).",
  },
  "note.capture": {
    class: "no-approval",
    reason:
      "Capturing a note writes to the owner's own inbox folder and overwrites nothing (D-05).",
  },
} as const satisfies ClassificationTable;

export type OperationName = keyof typeof CLASSIFICATION;

/** The operations whose row is approval-required: the only ones a {@link CapabilityToken} can name. */
export type ApprovalRequiredOperation = {
  [K in OperationName]: (typeof CLASSIFICATION)[K]["class"] extends "approval-required" ? K : never;
}[OperationName];

type ApprovalStatusOperation<S extends "enabled" | "reserved"> = {
  [K in ApprovalRequiredOperation]: (typeof CLASSIFICATION)[K] extends { readonly status: S }
    ? K
    : never;
}[ApprovalRequiredOperation];

/** Approval-required operations that have an executor today. */
export type EnabledOperation = ApprovalStatusOperation<"enabled">;
/** Approval-required operations classified now and refused until a later phase enables them. */
export type ReservedOperation = ApprovalStatusOperation<"reserved">;

/**
 * Every descriptor capability string the plugin carries, mapped to its
 * operation (06-RECONCILE.md R-CAPS). Descriptor strings use a colon
 * (`session:terminate`); operations use a dot (`session.force-terminate`).
 * Strings are matched exactly and case-sensitively; anything absent is
 * unknown and the caller refuses.
 */
export const CAPABILITY_OPERATION: Readonly<Record<string, OperationName>> = {
  "launch:antigravity": "launch.antigravity",
  "launch:claude-code": "launch.claude-code",
  "launch:finder": "launch.finder",
  "launch:github": "launch.github",
  "launch:claude-desktop": "launch.claude-desktop",
  "switcher:claude-code": "switcher.open",
  "session:focus": "session.focus",
  "session:resume": "session.resume",
  "session:branch": "session.branch",
  "session:open-transcript": "session.open-transcript",
  "session:interrupt": "session.interrupt",
  "session:associate": "session.associate",
  "session:terminate": "session.force-terminate",
  "usage:enable-transcript-analysis": "usage.transcript-analysis-toggle",
  "skill:run": "skill.run",
  "task:create": "task.write",
  "note:capture": "note.capture",
  "data:refresh": "data.refresh",
};

/** Prefix families: `connect:<anything>` is a navigation to the owner's own settings. */
export const CAPABILITY_FAMILY_OPERATION: Readonly<Record<string, OperationName>> = {
  "connect:": "connect.navigate",
};

export interface Classified {
  readonly operation: OperationName;
  readonly row: ClassificationRow;
}

function isOperationName(name: string): name is OperationName {
  return Object.hasOwn(CLASSIFICATION, name);
}

/** The row for an operation name, or undefined for a name the table does not know. */
export function classifyOperation(name: string): Classified | undefined {
  if (!isOperationName(name)) return undefined;
  return { operation: name, row: CLASSIFICATION[name] };
}

/**
 * The row for a descriptor capability string, or undefined when the string is
 * unknown. A caller that gets undefined must refuse: an unclassified
 * capability is never treated as allowed (D-04, D-06).
 */
export function classifyCapability(capability: string): Classified | undefined {
  if (Object.hasOwn(CAPABILITY_OPERATION, capability)) {
    const operation = CAPABILITY_OPERATION[capability];
    return operation === undefined ? undefined : classifyOperation(operation);
  }
  for (const [prefix, operation] of Object.entries(CAPABILITY_FAMILY_OPERATION)) {
    if (capability.startsWith(prefix) && capability.length > prefix.length) {
      return classifyOperation(operation);
    }
  }
  return undefined;
}

/**
 * The lifetime a new request gets: the row's default (never above the
 * ceiling) unless the requester asks for shorter. A request to lengthen is
 * clamped to the default, and a zero, negative or non-finite request falls
 * back to the default rather than producing an instantly dead or unbounded
 * request (D-10). The requester may only shorten.
 */
export function resolveTtlMs(
  requested: number | undefined,
  row: { readonly ttlMs: number },
): number {
  const rowDefault = Math.min(row.ttlMs, TTL_CEILING_MS);
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return rowDefault;
  }
  return Math.min(Math.max(1, Math.floor(requested)), rowDefault);
}
