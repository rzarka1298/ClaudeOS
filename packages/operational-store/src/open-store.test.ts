import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore } from "./open-store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccc-store-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("openStore", () => {
  it("round-trips a service_meta value through write and read", () => {
    const store = openStore(join(dir, "operational.db"));
    try {
      expect(store.readServiceMeta("started_at")).toBeNull();
      store.writeServiceMeta("started_at", "2026-09-15T00:00:00.000Z");
      expect(store.readServiceMeta("started_at")).toBe("2026-09-15T00:00:00.000Z");
    } finally {
      store.close();
    }
  });

  it("overwrites an existing key rather than erroring on conflict", () => {
    const store = openStore(join(dir, "operational.db"));
    try {
      store.writeServiceMeta("service_version", "0.1.0");
      store.writeServiceMeta("service_version", "0.2.0");
      expect(store.readServiceMeta("service_version")).toBe("0.2.0");
    } finally {
      store.close();
    }
  });
});
