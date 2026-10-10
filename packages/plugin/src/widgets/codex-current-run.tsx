import type { VNode } from "preact";
import { CODEX_COPY } from "./codex-format.js";
import { CodexRowList, type CodexSessionsProps } from "./codex-sessions.js";
export function CodexCurrentRunSection({
  rows,
  size,
  onQuickAction,
}: CodexSessionsProps): VNode | null {
  if (rows.kind !== "available") return null;
  return (
    <section className="ccc-usage-section ccc-codex-current" data-codex-section="current-run">
      <h4>{CODEX_COPY.currentRunHeading}</h4>
      {rows.current === null ? (
        <p className="ccc-state-body">{CODEX_COPY.noCurrentRun}</p>
      ) : (
        <CodexRowList rows={[rows.current]} size={size} onQuickAction={onQuickAction} />
      )}
    </section>
  );
}
