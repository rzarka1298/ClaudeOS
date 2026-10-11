import { describe, expect, it } from "vitest";

describe("Codex collector sub-barrels (plan 05.1-03)", () => {
  it("are importable on their own and through the package barrel", async () => {
    const usage = await import("./usage/index.js");
    const records = await import("./records/index.js");
    const barrel = await import("../index.js");
    expect(typeof usage).toBe("object");
    expect(typeof records).toBe("object");
    expect(barrel).toHaveProperty("parseTranscriptChunk");
  });
});
