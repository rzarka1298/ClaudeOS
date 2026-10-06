import { CLASSIFICATION, type ClassificationTable } from "@ccc/domain";
import type { OperationRegistry, RegisteredDefinition } from "./engine.js";

/**
 * Builds the operation registry once, at startup, and fails closed (D-04, D-43,
 * T-06-02, T-06-15, research Pattern 5). The set of definitions must be exactly
 * the set of `approval-required` rows whose status is `enabled`:
 *
 * - a definition for a reserved row, a no-approval or direct-gesture row, or a
 *   name the table does not know is an error (a definition would make a
 *   forbidden operation reachable);
 * - a duplicate definition is an error;
 * - an enabled row with no definition is an error (the table says it works,
 *   nothing could carry it out).
 *
 * `table` defaults to the domain table. It exists so a later connector phase,
 * and the fake connector in the 06-24 fixtures, can prove the operation
 * definition is the only extension point (D-43); production composition never
 * passes it. The registry exposes the table it was built against, so the engine
 * classifies through that table and never through a second copy.
 */
export function buildOperationRegistry(
  definitions: readonly RegisteredDefinition[],
  table: ClassificationTable = CLASSIFICATION,
): OperationRegistry {
  const byName = new Map<string, RegisteredDefinition>();
  for (const definition of definitions) {
    const name = definition.operation as string;
    const row = Object.hasOwn(table, name) ? table[name] : undefined;
    if (row === undefined) {
      throw new Error(`operation registry: "${name}" is not in the classification table`);
    }
    if (row.class !== "approval-required") {
      throw new Error(`operation registry: "${name}" is not an approval-required operation`);
    }
    if (row.status !== "enabled") {
      throw new Error(`operation registry: "${name}" is reserved and may have no definition`);
    }
    if (byName.has(name)) {
      throw new Error(`operation registry: "${name}" is defined more than once`);
    }
    byName.set(name, definition);
  }
  const missing = Object.entries(table)
    .filter(
      ([name, row]) =>
        row.class === "approval-required" && row.status === "enabled" && !byName.has(name),
    )
    .map(([name]) => `"${name}"`);
  if (missing.length > 0) {
    throw new Error(
      `operation registry: enabled operation${missing.length > 1 ? "s" : ""} ${missing.join(", ")} ${missing.length > 1 ? "have" : "has"} no definition`,
    );
  }
  return {
    table,
    lookup: (operation) => (byName.has(operation) ? byName.get(operation) : undefined),
    operations: () => [...byName.keys()],
  };
}
