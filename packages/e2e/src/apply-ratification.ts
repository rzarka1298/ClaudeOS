export interface RatificationWrite {
  text: string;
  /** The item numbers whose result line was written. */
  items: number[];
}

export function applyRatification(_script: string, _runId: string): RatificationWrite {
  throw new Error("applyRatification is not implemented yet (typed skeleton)");
}
