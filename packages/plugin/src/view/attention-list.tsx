import type { TaskAttentionItem } from "@ccc/domain/tasks.js";
import type { VNode } from "preact";

/**
 * The notes-need-attention list (plan 06-19, UI-SPEC S3 "Notes need attention
 * list", D-37, T-06-21). Props-driven. Skeleton: the behaviour arrives with the
 * implementation.
 */
export interface AttentionListProps {
  /** The entries loaded so far. */
  readonly items: readonly TaskAttentionItem[];
  /** The service's total, which may exceed the loaded entries. */
  readonly total: number;
  readonly hasMore: boolean;
  readonly connected: boolean;
  readonly onShowMore: () => void;
  readonly onOpenNote: (path: string) => void;
}

export function AttentionList(_props: AttentionListProps): VNode | null {
  return null;
}
