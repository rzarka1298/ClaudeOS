import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CODEX_API_BASE,
  CODEX_DOCTOR_PATH,
  CODEX_FOLLOW_LOG_PATH,
  CODEX_HEADROOM_PATH,
  CODEX_HOOK_EVENTS_PATH,
  CODEX_INTEGRATION_PATH,
  CODEX_OPEN_TRANSCRIPT_PATH,
  CODEX_SESSIONS_PATH,
  CODEX_TOKEN_ACTIVITY_PATH,
  CODEX_USAGE_PATH,
} from "@ccc/domain";
import { afterEach, describe, expect, it } from "vitest";
import { type CodexComposition, startCodexComposition } from "../test-support/codex-composition.js";
import { weeklyReply } from "../test-support/fake-codex-app-server.js";
import { codexRouteTable } from "./routes.js";

/**
 * Plan 05.1-28: the composed Codex route table has exactly nine paths with their
 * documented verbs; none dispatches work, ranks agents, consumes credits or
 * writes Codex configuration (CODEX-12, T-05.1-25), and the router answers its
 * constant not-found for every other verb.
 */

const NO_ROUTE = { error: "no such route" };

const READ_ONLY_PATHS = [
  CODEX_HEADROOM_PATH,
  CODEX_USAGE_PATH,
  CODEX_SESSIONS_PATH,
  CODEX_TOKEN_ACTIVITY_PATH,
  CODEX_INTEGRATION_PATH,
] as const;
const POST_ONLY_PATHS = [
  CODEX_DOCTOR_PATH,
  CODEX_OPEN_TRANSCRIPT_PATH,
  CODEX_FOLLOW_LOG_PATH,
  CODEX_HOOK_EVENTS_PATH,
] as const;
const ALL_PATHS = [...READ_ONLY_PATHS, ...POST_ONLY_PATHS] as const;

let composition: CodexComposition | null = null;

afterEach(async () => {
  await composition?.close();
  composition = null;
});

async function compose(): Promise<CodexComposition> {
  composition = await startCodexComposition({
    appServer: { read: { kind: "result", result: weeklyReply(41) } },
  });
  return composition;
}

describe("the Codex route table (CODEX-12, T-05.1-25)", () => {
  it("Test 3: holds exactly the nine paths, all under the Codex base path, with their documented verbs", () => {
    const keys = Object.keys(codexRouteTable).sort();
    expect(keys).toEqual([...ALL_PATHS].sort());
    for (const key of keys) expect(key.startsWith(`${CODEX_API_BASE}/`)).toBe(true);
    for (const path of READ_ONLY_PATHS) {
      expect(Object.keys(codexRouteTable[path] ?? {})).toEqual(["GET"]);
    }
    for (const path of POST_ONLY_PATHS) {
      expect(Object.keys(codexRouteTable[path] ?? {})).toEqual(["POST"]);
    }
  });

  it("Test 3: no path or verb names dispatch, routing, ranking, credits or resuming", () => {
    for (const key of Object.keys(codexRouteTable)) {
      expect(key).not.toMatch(/dispatch|route|rank|credit|resume|consume|recommend|assign/i);
    }
  });

  it("Test 3: every other verb on every Codex path is the router's constant not-found", async () => {
    const c = await compose();
    for (const path of ALL_PATHS) {
      for (const method of ["PUT", "DELETE", "PATCH"]) {
        const reply = await c.request(method, path, {});
        expect(reply, `${method} ${path}`).toEqual({ status: 404, body: NO_ROUTE });
      }
    }
    for (const path of READ_ONLY_PATHS) {
      const reply = await c.request("POST", path, {});
      expect(reply, `POST ${path}`).toEqual({ status: 404, body: NO_ROUTE });
    }
    for (const path of POST_ONLY_PATHS) {
      const reply = await c.request("GET", path);
      expect(reply, `GET ${path}`).toEqual({ status: 404, body: NO_ROUTE });
    }
  });

  it("Test 3: a POST to the GET-only usage and headroom paths is the router's constant 404", async () => {
    const c = await compose();
    for (const path of [CODEX_USAGE_PATH, CODEX_HEADROOM_PATH]) {
      expect(await c.request("POST", path, {})).toEqual({ status: 404, body: NO_ROUTE });
    }
    // The read-only routes never run a handler for a POST, so nothing was spawned.
    expect(c.appServerStarts()).toBe(0);
  });

  it("Test 6: unauthenticated requests to every Codex path are refused before any handler runs", async () => {
    const c = await compose();
    for (const path of READ_ONLY_PATHS) {
      const reply = await c.get(path, { token: null });
      expect(reply.status, `GET ${path}`).toBe(401);
    }
    for (const path of POST_ONLY_PATHS) {
      const reply = await c.post(path, {}, { token: null });
      expect(reply.status, `POST ${path}`).toBe(401);
    }
    expect(c.appServerStarts()).toBe(0);
  });

  it("the table source builds each route file from a dependency getter on ctx.codex only", () => {
    const source = readFileSync(fileURLToPath(new URL("./routes.ts", import.meta.url)), "utf8");
    expect(source).toMatch(/ctx\.codex\?\.headroom/);
    expect(source).toMatch(/ctx\.codex\?\.sessions/);
    expect(source).toMatch(/ctx\.codex\?\.tokens/);
    expect(source).toMatch(/ctx\.codex\?\.doctor/);
    expect(source).toMatch(/ctx\.codex\?\.hooks/);
    expect(source).toMatch(/ctx\.codex\?\.follow/);
    expect(source).toMatch(/ctx\.codex\?\.integration/);
  });
});
