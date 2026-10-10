import type { ComponentChildren, VNode } from "preact";
import { CONTROL_CHARACTER } from "./approvals-copy.js";

/**
 * The one place requester-supplied text becomes DOM (D-24, ADR-0014,
 * T-06-08). The service has already replaced every hidden, control and
 * bidirectional character with a visible `[U+XXXX]` token and capped the
 * length; this component only renders what it is given, as a Preact text
 * child, and gives each token a monospace look with a hidden
 * `control character` prefix so a screen reader says what it is.
 *
 * It never builds an element from the text: no link, no image, no markup, no
 * id, class or style derived from it. Markdown, HTML and script text arrive as
 * the literal characters they are.
 */

/** The shape the service's neutraliser writes: four to six upper-case hex digits. */
const CONTROL_TOKEN = /\[U\+[0-9A-F]{4,6}\]/g;

export function UntrustedText({ text }: { readonly text: string }): VNode {
  const children: ComponentChildren[] = [];
  let last = 0;
  for (const match of text.matchAll(CONTROL_TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) children.push(text.slice(last, index));
    children.push(
      <span className="ccc-control-token" key={`${index}-${match[0]}`}>
        <span className="ccc-visually-hidden">{`${CONTROL_CHARACTER} `}</span>
        {match[0]}
      </span>,
    );
    last = index + match[0].length;
  }
  if (last < text.length) children.push(text.slice(last));
  return <>{children}</>;
}
