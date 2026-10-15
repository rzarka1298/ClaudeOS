// Security finding 5 (plan 07-04): a parse that throws part-way must not throw out of the
// sanitiser, must not leave half-filtered text behind, and must say it was cut. The parser is
// replaced by one that emits some events and then fails.
import { describe, expect, it, vi } from "vitest";

vi.mock("htmlparser2", () => {
  class FailingParser {
    private readonly callbacks: Record<string, (...args: unknown[]) => void>;
    constructor(callbacks: Record<string, (...args: unknown[]) => void>) {
      this.callbacks = callbacks;
    }
    write(): void {
      this.callbacks.onopentag?.("p", {});
      this.callbacks.ontext?.("SAFE");
      this.callbacks.onclosetag?.("p", false);
      this.callbacks.onopentag?.("div", { hidden: "" });
      this.callbacks.ontext?.("HID");
      throw new Error("parser failed");
    }
    end(): void {
      this.callbacks.ontext?.("HID_AFTER_END");
    }
  }
  return { Parser: FailingParser };
});

describe("a parse that throws", () => {
  it("returns the text decided before the failure, flags truncation and does not throw", async () => {
    const { htmlToText } = await import("./html-to-text.js");
    const result = htmlToText("<p>SAFE</p><div hidden>HID</div>");
    expect(result.text).toBe("SAFE");
    expect(result.truncated).toBe(true);
  });

  it("never emits what arrives after the failure", async () => {
    const { htmlToText } = await import("./html-to-text.js");
    const result = htmlToText("x");
    expect(result.text).not.toContain("HID");
    expect(result.text).not.toContain("HID_AFTER_END");
  });
});
