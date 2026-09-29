import type { SessionProjectLookup } from "@ccc/domain";
import type Database from "better-sqlite3";

// RED scaffold (05-11 Task 2): the real lookup replaces this body.
export function createStoreProjectLookup(_db: Database.Database): SessionProjectLookup {
  return { resolveByPath: () => null, list: () => [] };
}
