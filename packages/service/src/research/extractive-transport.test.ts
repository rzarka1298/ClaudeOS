import { delimitSources, extractiveSummary } from "@ccc/research";
import { describe, expect, it } from "vitest";
import { createExtractiveTransport } from "./extractive-transport.js";

const ID = "a".repeat(32);
const NONCE = "0123456789abcdef0123456789abcdef";

describe("the extractive transport", () => {
  it("answers exactly what the extractive summariser answers, without any I/O", async () => {
    const input = `${delimitSources(
      [
        {
          sourceId: ID,
          text: "The maintainers confirmed that the stream reset is fixed in this release.",
        },
      ],
      NONCE,
    )}\nSource IDs: ${ID}`;
    const transport = createExtractiveTransport();
    const answer = await transport.complete({ instructions: "ignored", input });
    expect(answer).toBe(extractiveSummary(input));
    expect(JSON.parse(answer).items.length).toBeGreaterThan(0);
  });
});
