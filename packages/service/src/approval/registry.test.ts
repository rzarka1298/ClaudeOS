import { CLASSIFICATION, type ClassificationTable } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import { buildOperationRegistry } from "./registry.js";
import { EXTENDED_TABLE, fakeNamed } from "./test-support/extended-table.js";
import { createFakeOperation } from "./test-support/fake-operation.js";

const diagnostic = () => createFakeOperation("diagnostic.test").definition;
const terminate = () => createFakeOperation("session.force-terminate").definition;

/** Tests only: a definition for a name the domain type does not allow needs a local cast. */
function definitionNamed(name: string) {
  return fakeNamed(name).definition;
}

describe("buildOperationRegistry (Test 1: fails closed)", () => {
  it("builds from exactly the enabled approval-required rows and exposes lookup and the operation list", () => {
    const a = diagnostic();
    const b = terminate();
    const registry = buildOperationRegistry([a, b]);
    expect(registry.lookup("diagnostic.test")).toBe(a);
    expect(registry.lookup("session.force-terminate")).toBe(b);
    expect(registry.lookup("vault.delete")).toBeUndefined();
    expect(registry.lookup("nonsense")).toBeUndefined();
    expect([...registry.operations()].sort()).toEqual([
      "diagnostic.test",
      "session.force-terminate",
    ]);
    expect(registry.table).toBe(CLASSIFICATION);
  });

  it("throws, naming the operation, when an enabled row has no definition", () => {
    expect(() => buildOperationRegistry([diagnostic()])).toThrow(/session\.force-terminate/);
    expect(() => buildOperationRegistry([terminate()])).toThrow(/diagnostic\.test/);
    expect(() => buildOperationRegistry([])).toThrow(/diagnostic\.test/);
  });

  it("throws for a definition of a reserved row", () => {
    expect(() =>
      buildOperationRegistry([diagnostic(), terminate(), definitionNamed("vault.delete")]),
    ).toThrow(/vault\.delete/);
  });

  it("throws for a definition of a no-approval or direct-gesture row", () => {
    expect(() =>
      buildOperationRegistry([diagnostic(), terminate(), definitionNamed("task.write")]),
    ).toThrow(/task\.write/);
    expect(() =>
      buildOperationRegistry([diagnostic(), terminate(), definitionNamed("launch.finder")]),
    ).toThrow(/launch\.finder/);
  });

  it("throws for an unknown operation name", () => {
    expect(() =>
      buildOperationRegistry([diagnostic(), terminate(), definitionNamed("made.up")]),
    ).toThrow(/made\.up/);
  });

  it("throws for a duplicate definition", () => {
    expect(() => buildOperationRegistry([diagnostic(), terminate(), diagnostic()])).toThrow(
      /diagnostic\.test/,
    );
  });

  it("checks against an injected table: an extra enabled row needs a definition, and builds with one", () => {
    expect(() => buildOperationRegistry([diagnostic(), terminate()], EXTENDED_TABLE)).toThrow(
      /connector\.fake-send/,
    );
    const registry = buildOperationRegistry(
      [diagnostic(), terminate(), definitionNamed("connector.fake-send")],
      EXTENDED_TABLE,
    );
    expect(registry.lookup("connector.fake-send")).toBeDefined();
    expect(registry.table).toBe(EXTENDED_TABLE);
  });

  it("still refuses a definition for a reserved row of the injected table", () => {
    expect(() =>
      buildOperationRegistry(
        [
          diagnostic(),
          terminate(),
          definitionNamed("connector.fake-send"),
          definitionNamed("connector.fake-reserved"),
        ],
        EXTENDED_TABLE,
      ),
    ).toThrow(/connector\.fake-reserved/);
  });

  it("an injected table with no enabled row for a default operation does not demand it", () => {
    const onlyOne = {
      "diagnostic.test": CLASSIFICATION["diagnostic.test"],
    } as const satisfies ClassificationTable;
    expect(() => buildOperationRegistry([diagnostic()], onlyOne)).not.toThrow();
    expect(() => buildOperationRegistry([diagnostic(), terminate()], onlyOne)).toThrow(
      /session\.force-terminate/,
    );
  });
});
