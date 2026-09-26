import type { TemplateRefusalReason, TerminalPresetId } from "@ccc/domain";
import { MAX_TEMPLATE_ARGUMENTS } from "@ccc/domain";

export const PLACEHOLDERS = ["{projectPath}", "{script}"] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];
export const FORBIDDEN_CLAUDE_FLAGS = ["--dangerously-skip-permissions"] as const;
export const MAX_TEMPLATE_ARGS = MAX_TEMPLATE_ARGUMENTS;
export type TemplateKind = "terminal" | "claude-code";
export type TemplateRefusal = Exclude<
  TemplateRefusalReason,
  "bundle-not-found" | "executable-not-found"
>;

export interface ValidateTemplateOptions {
  readonly kind: TemplateKind;
  readonly isExecutable: (path: string) => boolean;
}

export type TemplateValidation =
  | { readonly ok: true; readonly argv: readonly string[] }
  | { readonly ok: false; readonly reason: TemplateRefusal; readonly index: number | null };

export interface TemplateValues {
  readonly script?: string;
  readonly projectPath?: string;
}

export interface TerminalPreset {
  readonly id: TerminalPresetId;
  readonly label: string;
  readonly argv: readonly string[];
  readonly verified: false;
  readonly note: string;
}

/** RED skeleton (plan 04-02 task 2): refuses everything. */
export function validateCommandTemplate(
  _argv: readonly string[],
  _options: ValidateTemplateOptions,
): TemplateValidation {
  return { ok: false, reason: "empty-argument", index: null };
}

/** RED skeleton. */
export function renderCommandTemplate(
  _argv: readonly string[],
  _values: TemplateValues,
): readonly string[] {
  return [];
}

/** RED skeleton. */
export const TERMINAL_PRESETS: readonly TerminalPreset[] = [];
