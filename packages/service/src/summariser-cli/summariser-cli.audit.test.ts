import { describe, expect, it } from "vitest";
import * as barrel from "./index.js";

/** Wave-1 audit (plan 10-02): init found by type and subtype rather than position; the barrel surface. */
const MODEL = "claude-haiku-5-5";
const init = {
  type: "system",
  subtype: "init",
  tools: [],
  mcp_servers: [],
  slash_commands: [],
  skills: [],
  plugins: [{ name: "b", path: "builtin" }],
  apiKeySource: "none",
  permissionMode: "default",
  model: MODEL,
};
const assistant = {
  type: "assistant",
  message: { id: "m1", content: [{ type: "text", text: "hi" }] },
};
const result = { type: "result", is_error: false, subtype: "success", num_turns: 1, result: "hi" };
const nd = (events: unknown[]): string => `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;

describe("summariser-cli audit (10-02)", () => {
  it("finds init after a rate_limit_event and an api_retry, not only as the first line", () => {
    const out = barrel.parseClaudeStream(
      nd([
        { type: "rate_limit_event", rate_limit_info: {} },
        { type: "system", subtype: "api_retry" },
        init,
        assistant,
        result,
      ]),
      { model: MODEL },
    );
    expect(out.ok).toBe(true);
  });

  it("still refuses a non-builtin plugin even when init is not the first line", () => {
    const bad = { ...init, plugins: [{ name: "p", path: "/Users/USERNAME/p" }] };
    const out = barrel.parseClaudeStream(
      nd([{ type: "rate_limit_event" }, bad, assistant, result]),
      { model: MODEL },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("summariser-refused");
  });

  it("exports the argv builders and parser through the folder barrel", () => {
    expect(typeof barrel.buildClaudeArgv).toBe("function");
    expect(typeof barrel.buildClaudeChildEnv).toBe("function");
    expect(typeof barrel.parseClaudeStream).toBe("function");
    expect([...barrel.CLAUDE_AUTH_STATUS_ARGV]).toEqual(["auth", "status"]);
  });
});
