// RED stub: replaced by the implementation in the next commit.
const nope = (): never => {
  throw new Error("not implemented");
};
export type LedgerEntry = { kind: string };
export type ProcessEntry = { pid: number; start: string; command: string };
export const appendLedger = nope;
export const readLedger = nope;
