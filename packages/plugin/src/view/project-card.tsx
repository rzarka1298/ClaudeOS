import type { Ref, VNode } from "preact";
import { projectMetaSegments, type ProjectRow } from "../widgets/panels.js";

/**
 * The S3 project card (Task 1 scope: name, display path and git meta only —
 * Task 3 completes the full anatomy: remote row, recent commits, the
 * later-phase fields line, the manage toolbar and the per-project footer).
 *
 * Takes the same {@link ProjectRow} shape `projectShortcutsState` already
 * builds via `projectRowsFrom` (S1 and S3 read identical per-project data —
 * S3 additionally needs the home-abbreviated `displayPath`, which
 * `ProjectRow` omits because S1 never shows a path, PROJ-14). `panels.tsx`
 * and `projects-state.ts` are therefore reused unmodified: the display path
 * travels beside the row as its own prop rather than growing the S1 type.
 */
export interface ProjectCardProps {
  readonly row: ProjectRow;
  /** Home-abbreviated (`~/…`); never the raw absolute path (D-43). */
  readonly displayPath: string;
  /** Reserved for Task 3's per-project footer (`WidgetFooter`'s relative time). */
  readonly now: number;
  /**
   * Attached to the card's name heading (`tabindex="-1"`) so a caller can
   * move focus there after a register, pin, unpin or removal — the ref map
   * `projects-view.tsx` keys by `{projectId}:{control}` reads this out.
   */
  readonly headingRef?: Ref<HTMLHeadingElement> | undefined;
}

/** A pinned card's visible `★` plus a visually hidden `Pinned: ` prefix (UI-SPEC S3, Glyph Vocabulary). */
function PinnedMarker(): VNode {
  return (
    <p className="ccc-list-meta ccc-mono-label">
      <span className="ccc-meta-glyph" aria-hidden="true">
        ★
      </span>{" "}
      Pinned
    </p>
  );
}

function noHeadingRef(): void {}

export function ProjectCard({ row, displayPath, headingRef = noHeadingRef }: ProjectCardProps): VNode {
  const headingId = `ccc-project-card-${row.id}`;
  const segments = projectMetaSegments(row);

  return (
    <article className="ccc-card ccc-project-card" aria-labelledby={headingId}>
      {row.pinned && <PinnedMarker />}
      <h4
        id={headingId}
        ref={headingRef}
        // Focusable so registration, pin/unpin and removal can move focus to
        // this card's own name (UI-SPEC S4 step 4, S3 "Pin project", RR-10) —
        // it gains no other role or interaction.
        tabIndex={-1}
        className="ccc-project-card-name ccc-clamp-2"
        title={row.name}
      >
        {row.name}
      </h4>
      <p className="ccc-display-path ccc-mono-label">{displayPath}</p>
      <p className="ccc-list-meta ccc-meta-segments">
        {segments.map((segment, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are a fixed-order render output for one card, never reordered independently.
          <span key={index}>
            {index > 0 ? " · " : ""}
            {segment.glyph === undefined ? null : (
              <span className="ccc-meta-glyph" aria-hidden="true">
                {segment.glyph}
              </span>
            )}
            {segment.glyph === undefined ? "" : " "}
            {segment.text}
          </span>
        ))}
      </p>
    </article>
  );
}
