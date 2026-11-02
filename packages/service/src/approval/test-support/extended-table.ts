// The Phase 7 shape for registry and engine tests (D-43): a classification
// table with one extra enabled row and one extra reserved row, which the
// production composition never passes. Folder-private test support.
import { CLASSIFICATION, type ClassificationTable, type EnabledOperation } from "@ccc/domain";
import { createFakeOperation, type FakeOperation } from "./fake-operation.js";

export const EXTENDED_TABLE = {
  ...CLASSIFICATION,
  "connector.fake-send": {
    class: "approval-required",
    status: "enabled",
    ttlMs: 60_000,
    maxApprovalAgeMs: 60_000,
    retry: "never",
    modifiable: false,
    presence: "none",
    summary: "send a fake message",
  },
  // The connector-class shape (D-02): an enabled write that needs the owner's verified presence.
  // Test-only: never in the production CLASSIFICATION, and named for a fake external write (GMAIL-08).
  "connector.fake-write": {
    class: "approval-required",
    status: "enabled",
    ttlMs: 60_000,
    maxApprovalAgeMs: 60_000,
    retry: "never",
    modifiable: false,
    presence: "required",
    summary: "write to a fake external service",
  },
  "connector.fake-reserved": {
    class: "approval-required",
    status: "reserved",
    ttlMs: 60_000,
    maxApprovalAgeMs: 60_000,
    retry: "never",
    modifiable: false,
    presence: "none",
    summary: "send a reserved message",
  },
} as const satisfies ClassificationTable;

/** A fake operation under a name the domain type does not know: a test-only cast. */
export function fakeNamed(name: string): FakeOperation {
  const fake = createFakeOperation("diagnostic.test");
  const operation = name as EnabledOperation;
  return { ...fake, operation, definition: { ...fake.definition, operation } };
}
