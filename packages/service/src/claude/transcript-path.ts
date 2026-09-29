export class TranscriptPathRefusedError extends Error {
  constructor() {
    super("transcript path refused");
    this.name = "TranscriptPathRefusedError";
  }
}

// RED stub (05-08 Task 2).
export function assertTranscriptPath(candidate: string, _claudeProjectsRoot: string): string {
  return candidate;
}
