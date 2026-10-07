/** Skeleton: the implementation follows the RED commit (plan 06-18, Task 3). */
export type CoalescedBatch = { readonly paths: readonly string[] } | { readonly rescan: true };
export interface PathCoalescerDeps {
  schedule(callback: () => void, ms: number): () => void;
  now(): number;
  flush(batch: CoalescedBatch): void;
  readonly trailingMs?: number;
  readonly maxWaitMs?: number;
  readonly maxPaths?: number;
}
export interface PathCoalescer {
  add(path: string): void;
  addRescan(): void;
  cancel(): void;
}
export function createPathCoalescer(_deps: PathCoalescerDeps): PathCoalescer {
  return { add: () => {}, addRescan: () => {}, cancel: () => {} };
}
