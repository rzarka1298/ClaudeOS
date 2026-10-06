import { z } from "zod";
import { API_BASE, ApiErrorBodySchema } from "./api.js";
import { TTL_CEILING_MS } from "./classification.js";
import type { Brand } from "./ids.js";
import { RunIdSchema } from "./session.js";

/**
 * The approval vocabulary (D-12, D-14, D-16, D-28): proposal identity, the
 * state machine, the hash contract, the route and event contracts, and the
 * summary the inbox lists. Browser-safe: no `node:` import, and `ids.ts` is
 * imported as a type only, so this file stays a leaf the plugin bundle can
 * reach. The service-built item view lives in `approval-view.ts`; the engine
 * and store contracts in `approval-operations.ts` and `approval-ports.ts`.
 *
 * Nothing here can express a persistent or remembered decision: a decision
 * covers one request and the schemas that carry one are strict, so an extra
 * key of any kind fails at the boundary (APPR-05, T-06-13).
 */

// ---------------------------------------------------------------------------
// Identity

/** The service-minted identifier of one approval request (D-12, D-15). */
export type ProposalId = Brand<string, "ProposalId">;

/**
 * The shape of a minted {@link ProposalId}: 25 lowercase alphanumerics (a
 * base-36 millisecond prefix and a hex suffix, the `newRunId` scheme). Looser
 * than the minted shape on purpose: the check at a boundary asks "could this
 * be an id", never "was this minted here".
 */
export const PROPOSAL_ID_PATTERN = /^[0-9a-z]{25}$/;

/** A ProposalId crossing the wire: validated against the minted shape, never minted here. */
export const ProposalIdSchema = z.custom<ProposalId>(
  (value) => typeof value === "string" && PROPOSAL_ID_PATTERN.test(value),
  { message: "must be a ProposalId" },
);

// ---------------------------------------------------------------------------
// States and transitions (A-1, D-14)

/**
 * Every state a request can be in. `lapsed` is an approval that was never
 * carried out in time (D-17): it is its own state, never folded into `failed`.
 */
export const PROPOSAL_STATES = [
  "pending",
  "approved",
  "executing",
  "executed",
  "failed",
  "unknown",
  "denied",
  "expired",
  "withdrawn",
  "lapsed",
] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];
export const ProposalStateSchema = z.enum(PROPOSAL_STATES);

/**
 * The one definition of which transitions are legal. The store applies each as
 * a compare-and-set on the source state, so a request can never skip a step or
 * go back: `approved -> executing` is the single-use claim, and `unknown` is
 * terminal because nothing is ever retried after an outcome could not be
 * confirmed.
 */
export const PROPOSAL_TRANSITIONS: Readonly<Record<ProposalState, readonly ProposalState[]>> = {
  pending: ["approved", "denied", "expired", "withdrawn"],
  approved: ["executing", "lapsed"],
  executing: ["executed", "failed", "unknown"],
  executed: [],
  failed: [],
  unknown: [],
  denied: [],
  expired: [],
  withdrawn: [],
  lapsed: [],
};

/** States a request never leaves. */
export const TERMINAL_PROPOSAL_STATES = [
  "executed",
  "failed",
  "unknown",
  "denied",
  "expired",
  "withdrawn",
  "lapsed",
] as const satisfies readonly ProposalState[];

/** States a request can sit in awaiting a decision, a claim or an outcome. */
export const RESTING_PROPOSAL_STATES = [
  "pending",
  "approved",
  "executing",
] as const satisfies readonly ProposalState[];

export function canTransition(from: ProposalState, to: ProposalState): boolean {
  return PROPOSAL_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Requester

/** Who asked. The kind is engine-assigned; only the label is requester text. */
export const REQUESTER_KINDS = ["dashboard", "skill", "automation", "connector"] as const;
export type RequesterKind = (typeof REQUESTER_KINDS)[number];

/** The longest requester label the engine stores or shows (UI-SPEC "Untrusted content rules"). */
export const REQUESTER_LABEL_MAX = 64;

/**
 * True when `value` contains a Unicode control (Cc) or format (Cf) character:
 * C0, DEL, C1, bidi overrides and isolates, zero-width characters, the BOM and
 * the soft hyphen. Requester-authored text must not carry an invisible
 * character that could reorder or hide what the owner reads (review MINOR-4).
 */
function hasControl(value: string): boolean {
  return /[\p{Cc}\p{Cf}]/u.test(value);
}

const INVISIBLE_MESSAGE = "text must not contain a control or invisible format character";
const visibleText = (schema: z.ZodString) =>
  schema.refine((v) => !hasControl(v), { message: INVISIBLE_MESSAGE });

export const RequesterSchema = z.strictObject({
  kind: z.enum(REQUESTER_KINDS),
  label: z
    .string()
    .min(1)
    .max(REQUESTER_LABEL_MAX)
    .refine((label) => !hasControl(label), {
      message: "label must not contain a control or invisible format character",
    }),
});
export type Requester = z.infer<typeof RequesterSchema>;

// ---------------------------------------------------------------------------
// Canonical JSON and the hash contract (D-16, research Pattern 6)

/** The payload hash: 64 lowercase hex characters (SHA-256, computed in the service). */
export const PAYLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/;

const MAX_CANONICAL_DEPTH = 64;

/** True when `value` has no unpaired UTF-16 surrogate. */
function isWellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
      return false;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

/**
 * RFC 8785 (JSON Canonicalization Scheme) serialisation. The same value always
 * produces the same string, whatever the insertion order of its members, so
 * `sha256(canonicalJson(envelope))` is a stable fingerprint of exactly what
 * the owner was shown and what will run.
 *
 * It refuses, with a `TypeError` naming the cause, everything that has no
 * single canonical form: `undefined` members, non-finite numbers, cycles,
 * unpaired surrogates (in a value or a key), non-plain objects (Date, Map,
 * class instances), functions, symbols, bigints and over-deep structures.
 * Text is never Unicode-normalised, so an NFC and an NFD spelling hash
 * differently, which errs on the safe side: a lookalike cannot share a hash.
 */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const walk = (v: unknown, depth: number): string => {
    if (v === null) return "null";
    switch (typeof v) {
      case "string":
        if (!isWellFormed(v)) throw new TypeError("canonicalJson: lone surrogate");
        return JSON.stringify(v);
      case "boolean":
        return v ? "true" : "false";
      case "number":
        if (!Number.isFinite(v)) throw new TypeError("canonicalJson: non-finite number");
        return Object.is(v, -0) ? "0" : JSON.stringify(v);
      case "object": {
        if (depth >= MAX_CANONICAL_DEPTH) throw new TypeError("canonicalJson: too deep");
        if (seen.has(v)) throw new TypeError("canonicalJson: cycle");
        seen.add(v);
        try {
          if (Array.isArray(v)) {
            const items: string[] = [];
            for (let i = 0; i < v.length; i += 1) {
              items.push(walk(v[i] as unknown, depth + 1));
            }
            return `[${items.join(",")}]`;
          }
          const proto = Object.getPrototypeOf(v) as unknown;
          if (proto !== Object.prototype && proto !== null) {
            throw new TypeError("canonicalJson: non-plain object");
          }
          const record = v as Record<string, unknown>;
          const members = Object.keys(record)
            .sort()
            .map((key) => {
              const member = record[key];
              if (member === undefined)
                throw new TypeError(`canonicalJson: undefined member ${key}`);
              if (!isWellFormed(key)) throw new TypeError("canonicalJson: lone surrogate key");
              return `${JSON.stringify(key)}:${walk(member, depth + 1)}`;
            });
          return `{${members.join(",")}}`;
        } finally {
          seen.delete(v);
        }
      }
      default:
        throw new TypeError(`canonicalJson: unsupported ${typeof v}`);
    }
  };
  return walk(value, 0);
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * Everything the owner sees and everything the executor will use. The payload
 * hash covers all of it, so changing any member after display changes the
 * hash and the decision is refused (D-16, T-06-03).
 */
export interface ApprovalEnvelope {
  readonly operation: string;
  readonly subject: string;
  readonly requester: Requester;
  readonly projectId: string | null;
  readonly runId: string | null;
  readonly reason: string;
  readonly payload: JsonValue;
}

export type EnvelopeInput = ApprovalEnvelope;

/**
 * Builds the envelope the hash covers. The payload is deep-copied through its
 * canonical form, so a later mutation of the caller's object cannot change
 * what was hashed, and a payload with no canonical form throws here.
 */
export function buildEnvelope(input: EnvelopeInput): ApprovalEnvelope {
  return {
    operation: input.operation,
    subject: input.subject,
    requester: { kind: input.requester.kind, label: input.requester.label },
    projectId: input.projectId,
    runId: input.runId,
    reason: input.reason,
    payload: JSON.parse(canonicalJson(input.payload)) as JsonValue,
  };
}

/** The first twelve characters of the payload hash, shown in the Record block (UI-SPEC S2). */
export function payloadFingerprint(payloadHash: string): string {
  if (!PAYLOAD_HASH_PATTERN.test(payloadHash)) {
    throw new Error("payloadFingerprint: expected a 64-character lowercase hex hash");
  }
  return payloadHash.slice(0, 12);
}

/**
 * Identical pending requests collapse onto one key (D-15). The pair is
 * serialised as a JSON array, so no operation and subject can be confused with
 * another split of the same characters.
 */
export function dedupeKeyOf(operation: string, subject: string): string {
  return canonicalJson([operation, subject]);
}

// ---------------------------------------------------------------------------
// Audit vocabulary (APPR-08)

/** The fixed set of audit events. History renders only these, never free text. */
export const APPROVAL_AUDIT_EVENTS = [
  "requested",
  "approved",
  "denied",
  "expired",
  "withdrawn",
  "claimed",
  "executed",
  "failed",
  "outcome-unknown",
  "retried-after-restart",
  "reconciled-executed",
  "lapsed",
] as const;
export type ApprovalAuditEvent = (typeof APPROVAL_AUDIT_EVENTS)[number];

// ---------------------------------------------------------------------------
// Decided-through channel (D-47)

/** Which client made a decision: the plugin's own UI, or anything else on this machine. */
export const DECIDED_VIA = ["plugin", "other"] as const;
export type DecidedVia = (typeof DECIDED_VIA)[number];
/** The request header the plugin sets on a decision. A hint for the audit trail, never an authority. */
export const DECIDED_VIA_HEADER = "X-Ccc-Decided-Via";
export const DECIDED_VIA_PLUGIN: DecidedVia = "plugin";

/** Anything other than the exact plugin value is `other`, so a decision from outside is visible. */
export function normaliseDecidedVia(value: string | undefined): DecidedVia {
  return value === DECIDED_VIA_PLUGIN ? "plugin" : "other";
}

// ---------------------------------------------------------------------------
// Routes (D-28). Fixed paths, never a ':param' segment: the proposal id travels
// in the body. There is deliberately NO generic submit route (research Pattern
// 5): milestone 1 requesters are in-process, and a route that accepted an
// operation name from a client would be a forged-requester surface.

/** `GET` — the inbox summaries (pending, recent decided, recent expired). */
export const APPROVAL_LIST_PATH = `${API_BASE}/approvals`;
/** `POST` — one request's full, service-built item view. */
export const APPROVAL_GET_PATH = `${API_BASE}/approvals/get`;
/** `POST` — approve once or deny one request. */
export const APPROVAL_DECIDE_PATH = `${API_BASE}/approvals/decide`;
/** `POST` — raise a test approval that does nothing (Settings, D-20). */
export const APPROVAL_TEST_PATH = `${API_BASE}/approvals/test`;

export const ApprovalGetRequestSchema = z.strictObject({ proposalId: ProposalIdSchema });
export type ApprovalGetRequest = z.infer<typeof ApprovalGetRequestSchema>;

/** The decision the owner makes. `approve` means approve once. */
export const APPROVAL_DECISIONS = ["approve", "deny"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/**
 * Strict on purpose: the body names one request, one decision and the full
 * hash of the content the owner saw. Any extra key, including anything shaped
 * like a standing or remembered choice, fails parsing (APPR-05, D-25).
 */
export const DecideRequestSchema = z.strictObject({
  proposalId: ProposalIdSchema,
  decision: z.enum(APPROVAL_DECISIONS),
  payloadHash: z.string().regex(PAYLOAD_HASH_PATTERN, { message: "must be a 64-character hash" }),
});
export type DecideRequest = z.infer<typeof DecideRequestSchema>;

/** The body of the test-approval route. A requester may shorten the lifetime, never lengthen it. */
export const ApprovalTestRequestSchema = z.strictObject({
  ttlMs: z.number().int().min(1).max(TTL_CEILING_MS).optional(),
});
export type ApprovalTestRequest = z.infer<typeof ApprovalTestRequestSchema>;

export const ApprovalTestResponseSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("proposed"), proposalId: ProposalIdSchema }),
  z.strictObject({ outcome: z.literal("already-pending"), proposalId: ProposalIdSchema }),
]);
export type ApprovalTestResponse = z.infer<typeof ApprovalTestResponseSchema>;

// ---------------------------------------------------------------------------
// Summary and snapshot (what the list carries; the full view is fetched per request)

/** Per-chip list bound: at most this many decided and this many expired summaries (UI-SPEC S1). */
export const APPROVAL_CHIP_BOUND = 50;
/** At most this many pending requests per operation, so one requester cannot flood the inbox. */
export const APPROVAL_PENDING_CAP_PER_OPERATION = 25;
/** At most this many pending requests in total. */
export const APPROVAL_PENDING_CAP_TOTAL = 50;
/**
 * The most bytes the approvals part of a response may take. The service's
 * socket client rejects a response larger than 64 KiB, which would drop the
 * whole body silently, so the service trims to this budget first and sets
 * `truncated` (T-06-30). The bound is deliberately below that client cap.
 */
export const APPROVAL_RESPONSE_BUDGET_BYTES = 56 * 1024;

const OUTCOME_CODE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const IsoSchema = z.iso.datetime({ offset: true });

/**
 * One row of the inbox. Every text field is already neutralised and capped by
 * the service; a summary carries no payload, no path and no reason text.
 */
export const ApprovalSummarySchema = z.object({
  proposalId: ProposalIdSchema,
  state: ProposalStateSchema,
  revision: z.number().int().nonnegative(),
  title: visibleText(z.string().min(1).max(120)),
  operationLabel: visibleText(z.string().min(1).max(80)),
  requesterKind: z.enum(REQUESTER_KINDS),
  requesterLabel: visibleText(z.string().max(REQUESTER_LABEL_MAX)),
  projectName: visibleText(z.string().max(120)).nullable(),
  runId: RunIdSchema.nullable(),
  createdAt: IsoSchema,
  expiresAt: IsoSchema,
  decidedAt: IsoSchema.nullable(),
  outcomeCode: z.string().regex(OUTCOME_CODE_PATTERN).nullable(),
});
export type ApprovalSummary = z.infer<typeof ApprovalSummarySchema>;

/**
 * The inbox as the snapshot and the list route carry it. `counts` are true
 * totals; the lists are bounded, and `truncated` says a list was cut short.
 * Unknown keys are stripped rather than rejected, so a newer service still
 * parses in an older plugin (Pitfall 17).
 */
export const ApprovalsSnapshotSchema = z.object({
  ready: z.boolean(),
  pending: z.array(ApprovalSummarySchema).max(APPROVAL_PENDING_CAP_TOTAL),
  decided: z.array(ApprovalSummarySchema).max(APPROVAL_CHIP_BOUND),
  expired: z.array(ApprovalSummarySchema).max(APPROVAL_CHIP_BOUND),
  counts: z.object({
    pending: z.number().int().nonnegative(),
    decided: z.number().int().nonnegative(),
    expired: z.number().int().nonnegative(),
  }),
  truncated: z.boolean(),
});
export type ApprovalsSnapshot = z.infer<typeof ApprovalsSnapshotSchema>;

/** The `approval.upserted` event payload: the summary only, never a payload (D-28). */
export const ApprovalUpsertedPayloadSchema = z.strictObject({
  approval: ApprovalSummarySchema,
});
export type ApprovalUpsertedPayload = z.infer<typeof ApprovalUpsertedPayloadSchema>;

function encodedLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * Trims a snapshot to the response budget: expired summaries go first, then
 * decided, then (only if nothing else is left to drop) pending ones from the
 * tail. Counts stay true and `truncated` becomes true. A snapshot already
 * within budget is returned as it is. Never mutates its input.
 */
export function fitApprovalsSnapshotToBudget(
  snapshot: ApprovalsSnapshot,
  budgetBytes: number = APPROVAL_RESPONSE_BUDGET_BYTES,
): ApprovalsSnapshot {
  if (encodedLength(snapshot) <= budgetBytes) return snapshot;
  const pending = [...snapshot.pending];
  const decided = [...snapshot.decided];
  const expired = [...snapshot.expired];
  const build = (): ApprovalsSnapshot => ({
    ...snapshot,
    pending,
    decided,
    expired,
    truncated: true,
  });
  while (encodedLength(build()) > budgetBytes) {
    if (expired.length > 0) expired.pop();
    else if (decided.length > 0) decided.pop();
    else if (pending.length > 0) pending.pop();
    else break;
  }
  return build();
}

// ---------------------------------------------------------------------------
// Decide response and errors

/** Every way a decision can end, as the service reports it. */
export const APPROVAL_DECIDE_OUTCOMES = [
  "decided",
  "hash-mismatch",
  "expired",
  "already-decided",
  "not-found",
  "operation-reserved",
] as const;
export type ApprovalDecideOutcome = (typeof APPROVAL_DECIDE_OUTCOMES)[number];

export const DecideResponseSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("decided"), approval: ApprovalSummarySchema }),
  z.strictObject({ outcome: z.literal("hash-mismatch") }),
  z.strictObject({ outcome: z.literal("expired") }),
  z.strictObject({ outcome: z.literal("already-decided"), state: ProposalStateSchema }),
  z.strictObject({ outcome: z.literal("not-found") }),
  z.strictObject({ outcome: z.literal("operation-reserved") }),
]);
export type DecideResponse = z.infer<typeof DecideResponseSchema>;

/** Why an approval route failed. The plugin owns the copy, so no body carries a message or a path. */
export const APPROVAL_ERROR_CODES = [
  "approval-unavailable",
  "operation-reserved",
  "too-many-pending",
  "not-found",
  "action-failed",
] as const;
export type ApprovalErrorCode = (typeof APPROVAL_ERROR_CODES)[number];
export const ApprovalErrorCodeSchema = z.enum(APPROVAL_ERROR_CODES);

/** A closed code, or the service's existing generic error body (a 400, 401 or 500 constant). */
export const ApprovalErrorBodySchema = z.union([
  z.strictObject({ error: ApprovalErrorCodeSchema }),
  ApiErrorBodySchema,
]);
export type ApprovalErrorBody = z.infer<typeof ApprovalErrorBodySchema>;
