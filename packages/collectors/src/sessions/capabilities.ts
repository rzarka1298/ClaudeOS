/** Signature stubs (RED). */
export const MIN_SUPPORTED_CLAUDE_VERSION = "";
export type ClaudeCapability =
  | "fork-source"
  | "claude-pid"
  | "cross-project-resume"
  | "post-model-switch"
  | "sessionend-per-hook-timeout";
export interface CapabilityRow {
  readonly since: string;
  readonly capability: ClaudeCapability;
}
export const CAPABILITY_TABLE: readonly CapabilityRow[] = [];
export type SupportStatus = "supported" | "unsupported" | "unknown";
export function compareVersions(_a: string, _b: string): number {
  return 0;
}
export function parseClaudeVersionOutput(_output: string): string | null {
  return null;
}
export function capabilitiesFor(_version: string): readonly ClaudeCapability[] {
  return [];
}
export function supportStatus(_version: string | null): SupportStatus {
  return "supported";
}
