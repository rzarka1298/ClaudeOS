import type { StatusLineSnapshot } from "@ccc/domain";

/** Hook-style identity for one wrapper invocation. */
export interface StatusLineMeta {
  readonly eventId: string;
  readonly observedAt: string;
}

/** Interface stub (05-03 Task 3 RED): the mapping lands with the wrapper. */
export function minimizeStatusLine(_raw: string, _meta: StatusLineMeta): StatusLineSnapshot | null {
  return null;
}
