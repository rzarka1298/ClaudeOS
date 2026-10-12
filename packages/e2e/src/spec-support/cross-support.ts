export function countOccurrences(_text: string, _needle: string): number {
  throw new Error("countOccurrences is not implemented yet (typed skeleton).");
}

export function checkPluginDataKeys(_data: unknown, _options: { socketPath: string }): string[] {
  throw new Error("checkPluginDataKeys is not implemented yet (typed skeleton).");
}

export interface LookPendingRecord {
  item: number;
  labels: string[];
  count: number;
}

export function recordLookPending(_input: {
  runRoot: string;
  item: number;
  labels: readonly string[];
}): LookPendingRecord {
  throw new Error("recordLookPending is not implemented yet (typed skeleton).");
}

export function readLookPending(_runRoot: string): LookPendingRecord[] {
  throw new Error("readLookPending is not implemented yet (typed skeleton).");
}
