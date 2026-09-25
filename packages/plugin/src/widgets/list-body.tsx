import type { SizeHint } from "@ccc/domain";
import type { VNode } from "preact";
import type { DestinationId } from "../view/destinations.js";

/** RED skeleton (plan 03-06 task 2). */
export const ROW_BUDGET: Readonly<Record<SizeHint, number>> = {
  small: 0,
  medium: 0,
  wide: 0,
  tall: 0,
};

export interface ListBodyProps<Row> {
  readonly rows: readonly Row[];
  readonly size: SizeHint;
  readonly keyOf: (row: Row) => string;
  readonly renderPrimary: (row: Row) => string;
  readonly renderMeta: (row: Row) => string;
  readonly moreDestination: DestinationId;
  readonly onMore?: (destination: DestinationId) => void;
}

/** RED skeleton (plan 03-06 task 2). */
export function ListBody<Row>(_props: ListBodyProps<Row>): VNode | null {
  throw new Error("ListBody is not implemented yet (list-body.tsx)");
}
