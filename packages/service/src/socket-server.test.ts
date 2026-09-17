import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startSocketServer } from "./socket-server.js";

// Uses a short, fixed base directory rather than os.tmpdir(): macOS's
// randomized per-user $TMPDIR is exactly what breaks the sun_path cap
// (ADR-0001; research §Pitfall 4/Pattern 1) — a test asserting real socket
// behavior must not itself violate the constraint it verifies.
const TEST_BASE = join(homedir(), ".ccc-test");

let dir: string;
let socketPath: string;

beforeEach(() => {
  mkdirSync(TEST_BASE, { recursive: true });
  dir = mkdtempSync(join(TEST_BASE, "sock-"));
  socketPath = join(dir, "t.sock");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("startSocketServer", () => {
  it("binds the socket file at mode 0600 the instant it reports listening", async () => {
    const server = await startSocketServer({
      socketPath,
      requestListener: (_req, res) => res.end("ok"),
    });
    try {
      const mode = statSync(socketPath).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      server.close();
    }
  });

  it("unlinks a stale regular file at the socket path before binding", async () => {
    writeFileSync(socketPath, "stale, not a socket");
    const server = await startSocketServer({
      socketPath,
      requestListener: (_req, res) => res.end("ok"),
    });
    try {
      expect(existsSync(socketPath)).toBe(true);
      const mode = statSync(socketPath).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      server.close();
    }
  });
});
