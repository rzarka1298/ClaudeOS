import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimSocketPath, SocketInUseError, startSocketServer } from "./socket-server.js";

/** Resolves once a client connection to `path` succeeds; rejects on error. */
function connectOnce(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path }, () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });
}

/** A plain listener standing in for an already-running service. */
function listenLive(path: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.end());
    server.once("error", reject);
    server.listen({ path }, () => resolve(server));
  });
}

/**
 * Leaves a real socket file behind with nobody listening: a child process
 * binds it and is SIGKILLed, so it never unlinks (an unclean shutdown).
 */
function leaveStaleSocket(path: string): void {
  spawnSync(process.execPath, [
    "-e",
    `require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, "SIGKILL"))`,
  ]);
}

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

  it("refuses to start, and leaves the socket alone, when a live service already holds it", async () => {
    const live = await listenLive(socketPath);
    try {
      await expect(
        startSocketServer({ socketPath, requestListener: (_req, res) => res.end("ok") }),
      ).rejects.toBeInstanceOf(SocketInUseError);
      expect(existsSync(socketPath)).toBe(true);
      await expect(connectOnce(socketPath)).resolves.toBeUndefined();
    } finally {
      live.close();
    }
  });

  it("replaces a stale socket file left by a process that died without unlinking it", async () => {
    leaveStaleSocket(socketPath);
    expect(statSync(socketPath).isSocket()).toBe(true);
    await expect(connectOnce(socketPath)).rejects.toMatchObject({ code: "ECONNREFUSED" });

    const server = await startSocketServer({
      socketPath,
      requestListener: (_req, res) => res.end("ok"),
    });
    try {
      await expect(connectOnce(socketPath)).resolves.toBeUndefined();
    } finally {
      server.close();
    }
  });
});

describe("claimSocketPath", () => {
  it("throws SocketInUseError for a live socket and never unlinks it", async () => {
    const live = await listenLive(socketPath);
    try {
      const error = await claimSocketPath(socketPath).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(SocketInUseError);
      expect((error as Error).message).toContain("already listening");
      expect(statSync(socketPath).isSocket()).toBe(true);
    } finally {
      live.close();
    }
  });

  it("unlinks a stale socket and resolves", async () => {
    leaveStaleSocket(socketPath);
    await expect(claimSocketPath(socketPath)).resolves.toBeUndefined();
    expect(existsSync(socketPath)).toBe(false);
  });

  it("resolves for a missing path without creating anything", async () => {
    await expect(claimSocketPath(socketPath)).resolves.toBeUndefined();
    expect(existsSync(socketPath)).toBe(false);
  });
});
