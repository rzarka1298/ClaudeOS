import { describe, expect, it } from "vitest";
import { HealthResponseSchema } from "./api.js";

describe("HealthResponseSchema", () => {
  it("accepts a well-formed health response", () => {
    const result = HealthResponseSchema.safeParse({
      status: "ok",
      serviceVersion: "0.1.0",
      startedAt: new Date().toISOString(),
      schemaVersion: 1,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a body missing startedAt", () => {
    const result = HealthResponseSchema.safeParse({
      status: "ok",
      serviceVersion: "0.1.0",
      schemaVersion: 1,
    });
    expect(result.success).toBe(false);
  });
});
