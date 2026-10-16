import {
  type JobRunOutcome,
  type NoteId,
  RESEARCH_JOB_ID,
  type ResearchStage,
  RUN_ID_PATTERN,
  type RunErrorCode,
  type SourceFailureCode,
} from "@ccc/domain";
import { escapeMarkdownText, inlineCode, writeNote } from "@ccc/vault-repo";

/**
 * The `automation-runs/<run id>.md` note of a research run (D-12, RSRCH-06, SC1): the vault-visible
 * record that lets one run be traced end to end. Every stage transition is listed with its instant
 * and the note ids it produced, then the owner's sources with what became of each.
 *
 * The body is ENGINE-TEMPLATED, in the manner of the approval mirror: it holds only fixed words,
 * stage names, ISO instants, note ids, run ids, the outcome word, closed error and failure codes,
 * and the owner's own source labels (escaped). No fetched title, address, author, model text or
 * remote error string can reach it, because the input type has no field for one (T-07-30).
 */

export interface RunNoteStage {
  readonly stage: ResearchStage;
  readonly at: string;
  readonly noteIds: readonly string[];
}

export interface RunNoteSource {
  /** The owner's own label from the allowlist file. */
  readonly label: string;
  readonly contributed: boolean;
  /** The closed failure code of an unavailable source. */
  readonly code: SourceFailureCode | null;
}

export interface RunNoteInput {
  readonly runId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly outcome: JobRunOutcome | null;
  readonly errorCode: RunErrorCode | null;
  readonly stages: readonly RunNoteStage[];
  readonly sources: readonly RunNoteSource[];
  /** Vault-relative path of the report note, when one was written. */
  readonly reportPath: string | null;
}

const OUTCOME_WORD: Readonly<Record<JobRunOutcome, string>> = {
  success: "Success",
  partial: "Partial",
  failure: "Failure",
};

/** The vault-relative path of a run's note. @throws {RangeError} when the id is not a run id. */
export function runNotePathFor(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) throw new RangeError("a run note path needs a run id");
  return `automation-runs/${runId}.md`;
}

/** The body of the run note. Deterministic: the same input gives the same bytes. */
export function renderRunNote(input: RunNoteInput): string {
  const lines: string[] = [
    "> Run record. Written by the command center; editing it changes nothing.",
    "",
    `# Research run ${inlineCode(input.runId)}`,
    "",
    `- Outcome: ${input.outcome === null ? "Running" : OUTCOME_WORD[input.outcome]}`,
    `- Trigger: Manual`,
    `- Started: ${inlineCode(input.startedAt)}`,
  ];
  if (input.endedAt !== null) lines.push(`- Ended: ${inlineCode(input.endedAt)}`);
  if (input.errorCode !== null) lines.push(`- Error: ${inlineCode(input.errorCode)}`);
  if (input.reportPath !== null) lines.push(`- Report: ${inlineCode(input.reportPath)}`);
  lines.push("", "## Stages", "");
  if (input.stages.length === 0) {
    lines.push("No stage has finished yet.");
  } else {
    input.stages.forEach((entry, index) => {
      const produced =
        entry.noteIds.length === 0
          ? "no notes"
          : `notes ${entry.noteIds.map((id) => inlineCode(id)).join(", ")}`;
      lines.push(
        `${index + 1}. ${inlineCode(entry.stage)} at ${inlineCode(entry.at)}: ${produced}`,
      );
    });
  }
  lines.push("", "## Sources", "");
  if (input.sources.length === 0) {
    lines.push("No sources were configured.");
  } else {
    for (const source of input.sources) {
      const label = escapeMarkdownText(source.label);
      lines.push(
        source.contributed
          ? `- ${label}: contributed`
          : `- ${label}: unavailable ${source.code === null ? "" : inlineCode(source.code)}`.trimEnd(),
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

/** Where a written run note lives, and what a rewrite must keep. */
export interface WrittenRunNote {
  readonly id: NoteId;
  readonly created: string;
  readonly path: string;
}

export interface WriteRunNoteOptions {
  readonly vaultRoot: string;
  readonly input: RunNoteInput;
  /** The first write's result; a rewrite keeps its id and created stamp. */
  readonly prior?: WrittenRunNote;
}

/**
 * Writes (or rewrites in place) the run note through the generic managed writer.
 *
 * @throws {RangeError} when the run id is not a run id, before the disk is touched.
 */
export function writeRunNote(options: WriteRunNoteOptions): WrittenRunNote {
  const path = runNotePathFor(options.input.runId);
  const written = writeNote({
    vaultRoot: options.vaultRoot,
    relativePath: path,
    body: renderRunNote(options.input),
    scope: "global",
    stage: "output",
    generatedBy: { automation: RESEARCH_JOB_ID, runId: options.input.runId },
    aiGenerated: false,
    confidence: "verified",
    ...(options.prior === undefined
      ? {}
      : { id: options.prior.id, created: options.prior.created }),
  });
  return {
    id: written.noteId,
    created: written.frontmatter.created,
    path,
  };
}
