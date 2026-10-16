import { RESEARCH_ERROR_CODES } from "@ccc/domain/research-routes.js";
import { describe, expect, it, vi } from "vitest";
import { ResearchApiError } from "./api.js";
import { createResearchApi, type ResearchClientLike } from "./client-api.js";

/**
 * The plugin-side adapter (plan 07-15, task 1): `createResearchApi(client)` implements the
 * `ResearchApi` port over the research client, which it receives by injection (the client
 * package's value exports pull in Node HTTP, so this file never imports it). Every failure
 * leaves as a `ResearchApiError` carrying a closed code and nothing a remote party said.
 */

const NOTE_ID = "0mfk1a2b3c4d5e6f7a8b9c001";

/** Throws exactly what it is given, an Error or not (the cast only satisfies the type of `throw`). */
function throwsRaw(value: unknown): never {
  throw value as Error;
}

/** A client whose members all resolve; `overrides` swap individual members. */
function clientWith(overrides: Partial<ResearchClientLike>): ResearchClientLike {
  return { ...fakeClient(), ...overrides } as ResearchClientLike;
}

function fakeClient(overrides: Partial<ResearchClientLike> = {}): {
  [K in keyof ResearchClientLike]: ReturnType<typeof vi.fn>;
} {
  return {
    run: vi.fn(() => Promise.resolve({ runId: NOTE_ID, alreadyRunning: false, state: "running" })),
    list: vi.fn(() => Promise.resolve({ rows: [], nextCursor: null })),
    report: vi.fn(() =>
      Promise.resolve({ page: "sources", sources: [], nextCursor: null, truncated: false }),
    ),
    status: vi.fn(() =>
      Promise.resolve({
        lastSuccess: null,
        lastFailure: null,
        inFlight: null,
        latestUnknown: null,
        configuredSources: null,
        topicLabel: null,
      }),
    ),
    ...overrides,
  } as never;
}

describe("Test 2 (adapter): createResearchApi implements the ResearchApi port", () => {
  it("routes the four calls to the client with strict request bodies", async () => {
    const client = fakeClient();
    const api = createResearchApi(client as unknown as ResearchClientLike);

    await api.run();
    await api.status();
    await api.list();
    await api.list("cursor_1");
    await api.report(NOTE_ID, "items");
    await api.report(NOTE_ID, "sources", "s-3");

    expect(client.run).toHaveBeenCalledTimes(1);
    expect(client.status).toHaveBeenCalledTimes(1);
    expect(client.list).toHaveBeenNthCalledWith(1, {});
    expect(client.list).toHaveBeenNthCalledWith(2, { cursor: "cursor_1" });
    expect(client.report).toHaveBeenNthCalledWith(1, { noteId: NOTE_ID, page: "items" });
    expect(client.report).toHaveBeenNthCalledWith(2, {
      noteId: NOTE_ID,
      page: "sources",
      cursor: "s-3",
    });
  });

  it("returns exactly what the client returned", async () => {
    const response = { runId: NOTE_ID, alreadyRunning: true, state: "running" };
    const client = clientWith({ run: () => Promise.resolve(response as never) });
    await expect(createResearchApi(client).run()).resolves.toBe(response);
  });

  it("rejects with ResearchApiError carrying the same closed code, for every code", async () => {
    for (const code of RESEARCH_ERROR_CODES) {
      const client = clientWith({
        status: () => {
          throw Object.assign(new Error(code), { name: "ResearchRequestError", code });
        },
      });
      const error = await createResearchApi(client)
        .status()
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ResearchApiError);
      expect((error as ResearchApiError).code).toBe(code);
      expect((error as ResearchApiError).message).toBe(code);
    }
  });

  it("maps anything that is not a closed code to unrecognised-response and keeps its text out", async () => {
    const hostile = [
      new Error("ENOENT /Users/USERNAME/secret"),
      Object.assign(new Error("x"), { code: "<script>alert(1)</script>" }),
      Object.assign(new Error("x"), { code: 42 }),
      "a string",
      null,
      undefined,
    ];
    for (const failure of hostile) {
      const client = clientWith({
        list: () => throwsRaw(failure),
      });
      const error = (await createResearchApi(client)
        .list()
        .catch((e: unknown) => e)) as ResearchApiError;
      expect(error).toBeInstanceOf(ResearchApiError);
      expect(error.code).toBe("unrecognised-response");
      expect(error.message).toBe("unrecognised-response");
    }
  });

  it("does not throw synchronously: a client that throws becomes a rejected promise", async () => {
    const client = clientWith({
      report: () => {
        throw new Error("boom");
      },
    });
    const api = createResearchApi(client);
    const pending = api.report(NOTE_ID, "items");
    await expect(pending).rejects.toMatchObject({ code: "unrecognised-response" });
  });
});
