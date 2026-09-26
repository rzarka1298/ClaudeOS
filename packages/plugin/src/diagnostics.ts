import { signal } from "@preact/signals";

/** RED skeleton (plan 03-07 Task 2): the shape is final, the behaviour is not written yet. */

export interface DiagnosticRecord {
  readonly source: string;
  readonly code: string;
  readonly message: string;
  readonly at: string;
}

export const DIAGNOSTICS_CAPACITY = 100;

export const diagnostics = signal<readonly DiagnosticRecord[]>([]);

export function recordDiagnostic(_record: DiagnosticRecord): void {
  // Not written yet: records are dropped.
}

export function clearDiagnostics(): void {
  diagnostics.value = [];
}
