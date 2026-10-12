/** RED skeleton (05.2-06 task 1): the typed shape with empty values; the GREEN commit fills it. */

export interface MirrorEntry {
  readonly key: string;
  readonly source: string;
  readonly text: string;
}

export const APPROVALS_COPY = Object.freeze({
  sectionHeading: "",
  denyLabel: "",
  approveLabel: "",
  statusApproved: "",
  statusDenied: "",
  statusCarriedOut: "",
  statusExpiredClosed: "",
  serviceDown: "",
  noRisks: "",
  filterPending: "",
  filterDecided: "",
  filterExpired: "",
  historyRequested: "",
  historyApproved: "",
  historyDenied: "",
  historyStarted: "",
  historyExecuted: "",
  fingerprintTerm: "",
  requestIdTerm: "",
  decidedThroughPlugin: "",
});

export function mirroredEntries(): readonly MirrorEntry[] {
  return [];
}

export function findDrift(
  _entries: readonly MirrorEntry[],
  _readSource: (source: string) => string,
): MirrorEntry[] {
  return [];
}
