import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const errorCalls: unknown[][] = [];
vi.mock("../logging.js", () => ({
  logger: {
    error: (...args: unknown[]) => {
      errorCalls.push(args);
    },
  },
}));
// Skip the bearer check: this file proves the catch-all, not authentication.
vi.mock("../route-kit.js", async () => {
  const actual = await vi.importActual<typeof import("../route-kit.js")>("../route-kit.js");
  return { ...actual, withAuth: (handler: unknown) => handler };
});

import type { RouteContext } from "../route-kit.js";
import { withCodexDeps } from "./route-support.js";

const SECRET_PATH = "/Users/USERNAME/.codex/sessions/2026/10/10/rollout-abc.jsonl";

describe("withCodexDeps catch-all logging (T-05.1-23: no path, cwd or process text in logs)", () => {
  beforeEach(() => {
    errorCalls.length = 0;
  });

  it("logs a fixed reason and the error class, never the error message or stack", async () => {
    const handler = withCodexDeps(
      () => ({}),
      async () => {
        throw new Error(`ENOENT: no such file or directory, open '${SECRET_PATH}'`);
      },
    );
    let status = 0;
    const res = {
      headersSent: false,
      writeHead: (code: number) => {
        status = code;
      },
      end: () => {},
    } as unknown as ServerResponse;
    handler({} as IncomingMessage, res, {} as RouteContext);
    await vi.waitFor(() => expect(errorCalls.length).toBe(1));
    expect(status).toBe(500);
    // pino's `err` serializer writes message and stack, so an Error anywhere in the call leaks.
    const text = JSON.stringify(errorCalls, (_key, value: unknown) =>
      value instanceof Error ? { message: value.message, stack: value.stack } : value,
    );
    expect(text).not.toContain("someone");
    expect(text).not.toContain("rollout-abc");
  });
});
