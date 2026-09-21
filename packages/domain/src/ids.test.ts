// The ID-minting edges VAULT-07 and VAULT-09 actually depend on: the IDs
// are unique under a tight loop (not merely "probably"), their shape is
// fixed-width so lexicographic order IS mint order, and `newWorkspaceId`
// takes no argument — the structural reason a workspace rename cannot move
// its directory.
import { afterEach, describe, expect, test, vi } from "vitest";
import { newNoteId, newRunId, newWorkspaceId } from "./ids.js";

/** Nine base-36 timestamp characters followed by sixteen hex characters. */
const ID_SHAPE = /^[0-9a-z]{9}[0-9a-f]{16}$/;
const ID_LENGTH = 25;

afterEach(() => {
  vi.useRealTimers();
});

describe("newNoteId", () => {
  test("1,000 IDs minted in a tight loop are all unique", () => {
    const minted = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      minted.add(newNoteId());
    }

    expect(minted.size).toBe(1000);
  });

  test("every minted ID is exactly 25 characters of the fixed shape", () => {
    for (let i = 0; i < 100; i += 1) {
      const id = newNoteId();
      expect(id).toHaveLength(ID_LENGTH);
      expect(id).toMatch(ID_SHAPE);
    }
  });

  test("two IDs minted in the SAME millisecond differ only in the random suffix", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));

    const first = newNoteId();
    const second = newNoteId();

    expect(first.slice(0, 9)).toBe(second.slice(0, 9));
    expect(first).not.toBe(second);
  });

  test("IDs minted at increasing times sort lexicographically into mint order", () => {
    vi.useFakeTimers();
    const stamps = [
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.001Z",
      "2030-07-15T12:00:00.000Z",
      "2059-01-01T00:00:00.000Z",
      "2400-01-01T00:00:00.000Z",
    ];

    const minted = stamps.map((stamp) => {
      vi.setSystemTime(new Date(stamp));
      return newNoteId();
    });

    // A plain string sort must reproduce the mint order — this is what
    // lets an index order notes without reading a single body.
    expect([...minted].sort()).toEqual(minted);
  });

  test("the 25-character width holds for every date through the year 5000", () => {
    vi.useFakeTimers();
    for (const stamp of [
      "1970-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "5000-12-31T23:59:59.999Z",
    ]) {
      vi.setSystemTime(new Date(stamp));
      const id = newNoteId();
      expect(id, `minted at ${stamp}`).toHaveLength(ID_LENGTH);
      expect(id, `minted at ${stamp}`).toMatch(ID_SHAPE);
    }
  });
});

describe("newWorkspaceId", () => {
  test("takes no arguments — name-independence is structural, not a convention", () => {
    // `Function.length` is the declared arity. Zero means no display name
    // can reach the minting site at all, so no rename can change the ID
    // and therefore no rename can move `workspaces/<id>/` (VAULT-09).
    expect(newWorkspaceId.length).toBe(0);
  });

  test("mints IDs of the same fixed shape as note and run IDs", () => {
    expect(newWorkspaceId()).toMatch(ID_SHAPE);
    expect(newRunId()).toMatch(ID_SHAPE);
    expect(newWorkspaceId()).toHaveLength(ID_LENGTH);
  });

  test("1,000 workspace IDs minted in a tight loop are all unique", () => {
    const minted = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      minted.add(newWorkspaceId());
    }

    expect(minted.size).toBe(1000);
  });
});
