// RED stub: replaced by the implementation in the next commit.
const nope = (): never => {
  throw new Error("not implemented");
};
export type SweepRunInput = { runRoot: string; ageMs: number; entries: unknown[] | null };
export const planSweep = nope;
export const executeSweep = nope;
