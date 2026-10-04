/**
 * Roving-tabindex arithmetic shared by every WAI-ARIA `role="toolbar"` this
 * phase builds (RR-01): the S3 manage toolbar (plan 04-08) and the S2 launch
 * toolbar (plan 04-10) both drive their focused index through this one pure
 * function, so the two toolbars can never quietly diverge on wrap-around or
 * Home/End behavior.
 */

/** The keys {@link nextToolbarIndex} recognises; every other key returns `current` unchanged. */
export const TOOLBAR_KEYS = ["ArrowLeft", "ArrowRight", "Home", "End"] as const;
export type ToolbarKey = (typeof TOOLBAR_KEYS)[number];

function isToolbarKey(key: string): key is ToolbarKey {
  return (TOOLBAR_KEYS as readonly string[]).includes(key);
}

/**
 * The next roving-tabindex index for a toolbar of `count` buttons, given the
 * `current` focused index and a keyboard `key`. `ArrowRight`/`ArrowLeft` wrap
 * at both ends; `Home`/`End` jump to the first/last button; any other key
 * (including `Enter`/`Space`, which activate rather than move) returns
 * `current` unchanged. `count <= 0` is a degenerate toolbar with nothing to
 * move to, so it also returns `current` unchanged.
 */
export function nextToolbarIndex(current: number, key: string, count: number): number {
  if (count <= 0 || !isToolbarKey(key)) return current;
  switch (key) {
    case "ArrowRight":
      return (current + 1) % count;
    case "ArrowLeft":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
  }
}
