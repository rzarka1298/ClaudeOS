/** RED skeleton (05.2-06 task 1): the pure helpers answer wrongly until the GREEN commit. */

export interface AuditRowLike {
  readonly seq: number;
  readonly event: string;
  readonly decided_via: string | null;
  readonly detail: string | null;
}

export function checkDeniedAudit(_rows: readonly AuditRowLike[], _effectCount: number): string[] {
  return ["not implemented"];
}

export function containsInOrder(
  _history: readonly string[],
  _expected: readonly string[],
): boolean {
  return false;
}
