// RED STUB (07-05 task 1): signatures only. The green commit implements them.

export type ParsedJobRunKey =
  | { readonly kind: "manual"; readonly jobId: string; readonly runId: string }
  | {
      readonly kind: "scheduled";
      readonly jobId: string;
      readonly cadence: "daily";
      readonly window: string;
      readonly zone: string;
    };

export function manualJobRunKey(_jobId: string, _runId: string): string {
  return "";
}

export function scheduledJobRunKey(
  _jobId: string,
  _cadence: string,
  _window: string,
  _zone: string,
): string {
  return "";
}

export function parseJobRunKey(_key: string): ParsedJobRunKey | null {
  return null;
}
