import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DetectionResponse, LAUNCHER_TEST_AUTOMATION_CAP_MS } from "@ccc/domain";
import { describe, expect, it } from "vitest";
import {
  detectLaunchers,
  LAUNCHER_TEST_AUTOMATION_CLIENT_TIMEOUT_MS,
  LAUNCHER_TEST_CLIENT_TIMEOUT_MS,
  LAUNCHERS_DETECT_CLIENT_TIMEOUT_MS,
  testLauncher,
} from "./projects-api.js";
import {
  createSocketApiClient,
  type SocketApiClient,
  type SocketRequestOptions,
  SocketUnreachableError,
} from "./socket-api-client.js";

/**
 * Wave-5 review finding 2: one 5 s client idle timeout killed the Test
 * step's 60 s Automation-prompt wait and long detections on the CLIENT while
 * the service carried on. A request now carries its own `timeoutMs`; the Test
 * and detect helpers set budgets longer than the service's own caps.
 */

function recordingClient(body: unknown): {
  client: SocketApiClient;
  seen: SocketRequestOptions[];
} {
  const seen: SocketRequestOptions[] = [];
  return {
    seen,
    client: {
      request<T>(opts: SocketRequestOptions) {
        seen.push(opts);
        return Promise.resolve({ status: 200, body: body as T });
      },
    },
  };
}

const DETECTION: DetectionResponse = {
  detectedAt: "2026-09-30T00:00:00Z",
  apps: {
    antigravity: [],
    "claude-desktop": [],
    iterm2: [],
    ghostty: [],
    wezterm: [],
    terminal: [],
  },
  claudeExecutables: [],
  terminalPresets: [],
  git: "available",
};

describe("per-request timeoutMs on the socket client", () => {
  async function withSlowServer(
    delayMs: number,
    run: (socketPath: string) => Promise<void>,
  ): Promise<void> {
    const socketPath = join(mkdtempSync(join(tmpdir(), "ccc-sock-")), "t.sock");
    const server = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }, delayMs);
    });
    await new Promise<void>((done) => server.listen(socketPath, done));
    try {
      await run(socketPath);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }

  it("a request's own timeoutMs outlasts the client default", async () => {
    await withSlowServer(300, async (socketPath) => {
      const client = createSocketApiClient({ socketPath, timeoutMs: 100 });
      const reply = await client.request({ method: "POST", path: "/x", timeoutMs: 3000 });
      expect(reply).toEqual({ status: 200, body: { ok: true } });
    });
  });

  it("without one, the client default still applies", async () => {
    await withSlowServer(300, async (socketPath) => {
      const client = createSocketApiClient({ socketPath, timeoutMs: 100 });
      const failure = await client.request({ method: "POST", path: "/x" }).catch((e) => e);
      expect(failure).toBeInstanceOf(SocketUnreachableError);
      expect((failure as SocketUnreachableError).errno).toBe("ETIMEDOUT");
    });
  });
});

describe("testLauncher's client budget", () => {
  it("outlasts the Automation cap for an osascript-driven Claude Code terminal", async () => {
    const { client, seen } = recordingClient({ ok: true });
    await testLauncher(client, "claude-code", {
      terminal: { kind: "custom", preset: "iterm2", argv: ["/usr/bin/osascript", "{script}"] },
    });
    expect(seen[0]?.timeoutMs).toBe(LAUNCHER_TEST_AUTOMATION_CLIENT_TIMEOUT_MS);
    expect(LAUNCHER_TEST_AUTOMATION_CLIENT_TIMEOUT_MS).toBeGreaterThan(
      LAUNCHER_TEST_AUTOMATION_CAP_MS,
    );
  });

  it("assumes the prompt may appear when the Claude Code terminal is not known", async () => {
    const { client, seen } = recordingClient({ ok: true });
    await testLauncher(client, "claude-code");
    expect(seen[0]?.timeoutMs).toBe(LAUNCHER_TEST_AUTOMATION_CLIENT_TIMEOUT_MS);
  });

  it("uses the ordinary Test budget for Terminal and for the app launchers", async () => {
    const { client, seen } = recordingClient({ ok: true });
    await testLauncher(client, "claude-code", { terminal: { kind: "terminal-app" } });
    await testLauncher(client, "antigravity");
    await testLauncher(client, "finder");
    expect(seen.map((opts) => opts.timeoutMs)).toEqual([
      LAUNCHER_TEST_CLIENT_TIMEOUT_MS,
      LAUNCHER_TEST_CLIENT_TIMEOUT_MS,
      LAUNCHER_TEST_CLIENT_TIMEOUT_MS,
    ]);
    // Longer than the service's 4 s launch cap plus the plugin's 5 s deadline,
    // far shorter than the Automation budget.
    expect(LAUNCHER_TEST_CLIENT_TIMEOUT_MS).toBeGreaterThan(5000);
    expect(LAUNCHER_TEST_CLIENT_TIMEOUT_MS).toBeLessThan(LAUNCHER_TEST_AUTOMATION_CAP_MS);
  });
});

describe("detectLaunchers' client budget", () => {
  it("is larger than the 5 s default", async () => {
    const { client, seen } = recordingClient(DETECTION);
    await detectLaunchers(client);
    expect(seen[0]?.timeoutMs).toBe(LAUNCHERS_DETECT_CLIENT_TIMEOUT_MS);
    expect(LAUNCHERS_DETECT_CLIENT_TIMEOUT_MS).toBeGreaterThan(5000);
  });
});
