import { basename } from "node:path";
import {
  APPROVAL_STATE_DISPLAY,
  type ApprovalLog,
  CLASSIFICATION,
  type ClassificationTable,
  type MirrorPort,
  type RequesterKind,
  type StoredProposal,
} from "@ccc/domain";
import { writeNote } from "@ccc/vault-repo";

/**
 * The read-only vault mirror of an approval request (plan 06-13, D-22, R-24,
 * T-06-16). Each request leaves one small managed note under `system/`, so the
 * inbox is visible in the vault. It is a trace for the owner and never an
 * authority: decisions are made only through the API, and nothing in this
 * package or the engine ever reads a mirror note back.
 *
 * The body is engine-templated text ONLY: the status label, the requester KIND
 * word, the expiry and a link. No requester label, reason, diff, payload,
 * target, run name or project name ever enters the vault, because vault notes
 * are readable by agents and a requester's text must not become prompt-injection
 * material there. The heading comes from the operation's classification row,
 * never from the stored operation string, so an unknown name cannot reach the
 * note. The file name is derived from the proposal's stored mirror note id and
 * from nothing else.
 *
 * Best effort: any failure (no vault yet, a scope refusal, a filesystem error)
 * is swallowed and logged once by error class name; a mirror failure must never
 * fail a decision.
 *
 * Mirror notes are retained: no deletion path exists or is added. The 30-day
 * purge (D-19) clears payload columns in the store, not vault notes. Every write
 * rebuilds the `system/` folder's index synchronously, which costs time as the
 * folder grows (T-06-33, measured in the plan summary).
 */

export interface ApprovalMirrorDeps {
  /** The managed vault root, or null before vault setup has run. */
  readonly getVaultRoot: () => string | null;
  readonly log: ApprovalLog;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** The first letter upper-cased: `dashboard` becomes `Dashboard`. */
function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** An absolute, locale-free date and time in UTC, such as `Oct 4, 2026, 3:20 PM UTC`. */
function expiryText(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const hours = date.getUTCHours();
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const suffix = hours < 12 ? "AM" : "PM";
  const month = MONTHS[date.getUTCMonth()] ?? "";
  return `${month} ${date.getUTCDate()}, ${date.getUTCFullYear()}, ${hour12}:${minutes} ${suffix} UTC`;
}

/** The fixed action phrase of an approval-required operation, or a generic one. */
function actionText(operation: string): string {
  const table: ClassificationTable = CLASSIFICATION;
  const row = Object.hasOwn(table, operation) ? table[operation] : undefined;
  return row?.class === "approval-required" ? capitalise(row.summary) : "Unknown request";
}

/** The kind word of the requester: one of a closed set, never the free-text label. */
function kindText(kind: RequesterKind): string {
  return capitalise(kind);
}

const BANNER =
  "> Mirror — decisions are made in the command center, not in this note. Editing it changes nothing.";

function bodyOf(proposal: StoredProposal, vaultName: string): string {
  const link = `obsidian://ccc-approval?id=${encodeURIComponent(proposal.proposalId)}&vault=${encodeURIComponent(vaultName)}`;
  return [
    BANNER,
    "",
    `# Approval request: ${actionText(proposal.operation)}`,
    "",
    `- Status: ${APPROVAL_STATE_DISPLAY[proposal.state].label}`,
    `- Requested by: ${kindText(proposal.requester.kind)}`,
    `- Expires: ${expiryText(proposal.expiresAt)}`,
    `- [Open in the command center](${link})`,
    "",
  ].join("\n");
}

export function createApprovalMirror(deps: ApprovalMirrorDeps): MirrorPort {
  return {
    async mirror(proposal) {
      // Let the caller's decision path finish first: the write below is
      // synchronous and rebuilds a folder index. Writes still run in call order.
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        const vaultRoot = deps.getVaultRoot();
        if (vaultRoot === null) return;
        writeNote({
          vaultRoot,
          relativePath: `system/${proposal.mirrorNoteId}.md`,
          body: bodyOf(proposal, basename(vaultRoot)),
          scope: "global",
          stage: "capture",
          generatedBy: { automation: "approval-engine" },
          aiGenerated: false,
          confidence: "verified",
          id: proposal.mirrorNoteId,
          created: proposal.createdAt,
        });
      } catch (err: unknown) {
        // Class name only: an fs error message can carry a path.
        deps.log.warn({ errorName: err instanceof Error ? err.name : typeof err }, "mirror failed");
      }
    },
  };
}
