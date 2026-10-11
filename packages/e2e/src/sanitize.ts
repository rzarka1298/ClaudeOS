export interface SanitizeOptions {
  /** The running user's home directory; replaced with the /Users/USERNAME placeholder. */
  readonly homeDir?: string | undefined;
  readonly maxLength?: number | undefined;
}

export function sanitizeText(_text: string, _options?: SanitizeOptions): string {
  throw new Error("sanitizeText is not implemented yet (typed skeleton)");
}
