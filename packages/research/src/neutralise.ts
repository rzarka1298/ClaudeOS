// Neutralising one span of untrusted model text (plan 07-07, D-06, RSRCH-08).
// SIGNATURE STUB for the red commit: the behaviour arrives in the green commit.

/** What a URL-like substring becomes. The vault writer escapes Markdown later; nothing here links. */
export const ADDRESS_REMOVED_MARKER = "[address removed]";

export interface NeutralisedSpan {
  readonly text: string;
  readonly addressesRemoved: number;
  readonly controlCharsRemoved: number;
  readonly truncated: boolean;
}

export function neutraliseUntrustedSpan(text: string, _maxLength: number): NeutralisedSpan {
  return { text, addressesRemoved: 0, controlCharsRemoved: 0, truncated: false };
}
