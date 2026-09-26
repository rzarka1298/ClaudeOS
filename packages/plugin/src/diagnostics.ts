import { signal } from "@preact/signals";

/**
 * The plugin's in-memory diagnostics record.
 *
 * Anything the plugin decided NOT to show the owner, and why, lands here
 * rather than on the dashboard: `D-13` writes one record per layout entry it
 * skipped, so the Overview never renders a broken slot while the reason is
 * still recoverable. Phase 8's diagnostics view (DIAG-01..04) is the reader.
 *
 * Bounded at {@link DIAGNOSTICS_CAPACITY} records, oldest dropped first: a
 * layout file saved in a loop, or a flapping source, must not grow memory
 * without limit. Nothing here is persisted — a record describes this plugin
 * instance's run, and the next load starts clean.
 */

export interface DiagnosticRecord {
  /** The subsystem that wrote the record, e.g. `layout`. */
  readonly source: string;
  /** A stable machine code within that source, e.g. `unknown-widget`. */
  readonly code: string;
  /** One sentence for the owner. */
  readonly message: string;
  /** ISO-8601 time the record was written. */
  readonly at: string;
}

export const DIAGNOSTICS_CAPACITY = 100;

export const diagnostics = signal<readonly DiagnosticRecord[]>([]);

/** Appends one record, dropping the oldest once the record is full. */
export function recordDiagnostic(record: DiagnosticRecord): void {
  const next = [...diagnostics.value, record];
  diagnostics.value =
    next.length > DIAGNOSTICS_CAPACITY ? next.slice(next.length - DIAGNOSTICS_CAPACITY) : next;
}

export function clearDiagnostics(): void {
  diagnostics.value = [];
}
