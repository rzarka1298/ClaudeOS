import type { ProjectLookup } from "@ccc/domain";
import type { OperationalStore } from "@ccc/operational-store";

/** RED skeleton (04-06 Task 1): every id reads as missing. */
export function createStoreProjectLookup(_store: OperationalStore): ProjectLookup {
  return {
    resolve() {
      return { error: "project-missing" };
    },
  };
}
