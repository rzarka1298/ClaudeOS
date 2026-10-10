import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LAUNCH_PAIR_PATH,
  type LaunchGuard,
  LaunchPairResponseSchema,
  type ProjectId,
} from "@ccc/domain";
import { insertProject, saveLauncherConfig } from "@ccc/operational-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANTIGRAVITY_IDE_BUNDLE_ID } from "../projects/antigravity-terminal.js";
import { type BridgeFixture, createBridgeFixture } from "../test-support/bridge-fixtures.js";
import {
  type CodexComposition,
  codexHomeWithThreads,
  startCodexComposition,
} from "../test-support/codex-composition.js";
import { launchContext } from "../test-support/codex-launch-context.js";

/**
 * Wave 8 test audit (plan 05.1-29 truth 2, CODEX-02): "one agent failing never hides the other",
 * through the composed listener and the window simulator. The wave's own pair tests only cover
 * both-open and both-failed; these cover exactly one half failing, in each direction.
 */

const fixtures: BridgeFixture[] = [];
const open: CodexComposition[] = [];
const tickers: Array<ReturnType<typeof setInterval>> = [];

beforeEach(() => {
  vi.stubEnv("XDG_STATE_HOME", "");
});

afterEach(async () => {
  for (const ticker of tickers.splice(0)) clearInterval(ticker);
  for (const composition of open.splice(0)) await composition.close();
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
  vi.unstubAllEnvs();
});

async function pairWorld(save: { claude: boolean | "missing-executable"; codex: boolean }) {
  const fx = createBridgeFixture();
  fixtures.push(fx);
  fx.installLauncher();
  fx.installMarker();
  vi.stubEnv("HOME", fx.home);
  const guard: LaunchGuard = {
    check: () => Promise.resolve({ ok: true }),
    settle: () => Promise.resolve(),
  };
  const c = await startCodexComposition({
    homeDir: fx.home,
    home: codexHomeWithThreads([]),
    routeContext: launchContext({ guard }),
    prepare: ({ store }) => {
      saveLauncherConfig(store.db, "antigravity", { bundleId: ANTIGRAVITY_IDE_BUNDLE_ID });
      if (save.claude !== false) {
        saveLauncherConfig(store.db, "claude-code", {
          executablePath:
            save.claude === "missing-executable" ? join(fx.home, "no-such-claude") : fx.claudePath,
          args: [],
          terminal: { kind: "antigravity-terminal" },
        });
      }
      if (save.codex) {
        saveLauncherConfig(store.db, "codex", { executablePath: fx.codexPath, args: [] });
      }
    },
  });
  open.push(c);
  const projectId: ProjectId = insertProject(c.store.db, {
    path: fx.projectDir,
    displayName: "Example",
  }).record.projectId;
  const sim = fx.simulator("current");
  sim.heartbeat();
  tickers.push(
    setInterval(() => {
      try {
        sim.tick();
      } catch {
        // The fixture was cleaned up while a tick was due.
      }
    }, 15),
  );
  return { c, fx, projectId };
}

function claimedAgents(fx: BridgeFixture): string[] {
  return fx
    .claimedFiles()
    .sort()
    .map(
      (file) =>
        (JSON.parse(readFileSync(join(fx.claimedDir, file), "utf8")) as { agent: string }).agent,
    );
}

describe("pair launch: a failing half never hides the other half's result", () => {
  it("shows Claude opened and Codex as an error when only the Codex launcher is not set up", async () => {
    const { c, fx, projectId } = await pairWorld({ claude: true, codex: false });
    const reply = await c.post(LAUNCH_PAIR_PATH, { projectId });
    expect(reply.status).toBe(200);
    const body = LaunchPairResponseSchema.parse(reply.body);
    expect(body).toMatchObject({ claude: { status: "opened" }, codex: { status: "setup" } });
    expect(claimedAgents(fx)).toEqual(["claude"]);
  });

  it("shows Codex opened and Claude as an error when only the Claude executable is missing", async () => {
    const { c, fx, projectId } = await pairWorld({ claude: "missing-executable", codex: true });
    const reply = await c.post(LAUNCH_PAIR_PATH, { projectId });
    expect(reply.status).toBe(200);
    const body = LaunchPairResponseSchema.parse(reply.body);
    expect(body).toMatchObject({ codex: { status: "opened" }, claude: { status: "error" } });
    expect(claimedAgents(fx)).toEqual(["codex"]);
  });
});
