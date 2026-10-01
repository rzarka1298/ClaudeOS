import type { TemplateRefusalReason } from "@ccc/domain";
import type { VNode } from "preact";

/** RED stub. */
export type TemplateEditorKind = "claude-code" | "terminal";

export const TEMPLATE_REFUSAL_COPY: Readonly<Record<TemplateRefusalReason, string>> = {
  "executable-not-absolute": "",
  "executable-not-executable": "",
  "embedded-placeholder": "",
  "missing-script-placeholder": "",
  "forbidden-flag": "",
  "empty-argument": "",
  "line-break": "",
  "too-many-arguments": "",
  "unknown-placeholder": "",
  "bundle-not-found": "",
  "executable-not-found": "",
};

export interface TemplateEditorProps {
  readonly kind: TemplateEditorKind;
  readonly value: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
  readonly errors: ReadonlyMap<number, string>;
  readonly sampleDisplayPath: string;
  readonly terminalLabel: string;
  readonly executableDisplay?: string | null | undefined;
}

export function TemplateEditor(_props: TemplateEditorProps): VNode {
  return <div />;
}
