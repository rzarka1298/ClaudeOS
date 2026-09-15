import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createSocketApiClient, SocketUnreachableError } from "./socket-api-client.js";

describe("createSocketApiClient", () => {
  it("rejects with SocketUnreachableError when no socket is listening", async () => {
    const socketPath = join(tmpdir(), "ccc-no-such-socket.sock");
    const client = createSocketApiClient({ socketPath, timeoutMs: 1000 });
    await expect(client.request({ method: "GET", path: "/api/v1/health" })).rejects.toBeInstanceOf(
      SocketUnreachableError,
    );
  });
});
