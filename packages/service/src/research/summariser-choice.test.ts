import { describe, expect, it } from "vitest";
import type { TextTransport } from "../untrusted/index.js";
import type { AnthropicTransportDeps } from "./anthropic-transport.js";
import { DEFAULT_RESEARCH_CONFIG } from "./default-sources.js";
import { createExtractiveTransport } from "./extractive-transport.js";
import { createChooseSummariser } from "./summariser-choice.js";
import { SummariserError } from "./summariser-error.js";
import { createKit, THREE } from "./test-support/research-kit.js";

/**
 * Plan 07-14 Task 3, Test 6 (D-03, D-04, ADR-0017): the live wiring shape. Built by dependency
 * injection, never by a live call: the transport receives the model named in the owner's allowlist
 * and a key-reading CLOSURE (never a key string); with no key stored the choice is refused up
 * front, before anything is fetched (07-FIX4 e).
 */

const KEY = "sk-ant-test-key-0123456789abcdef";
const FAKE: TextTransport = { complete: async () => "{}" };

const CONFIG = {
  topicLabel: "Topic",
  summariserModel: "claude-haiku-5-5" as const,
  sources: [...THREE],
};

describe("createChooseSummariser", () => {
  it("builds the live transport for the allowlist's model with a key-reading closure", async () => {
    const built: AnthropicTransportDeps[] = [];
    const readApiKey = async (): Promise<string | null> => KEY;
    const choose = createChooseSummariser({
      readApiKey,
      createTransport: (deps) => {
        built.push(deps);
        return FAKE;
      },
    });
    const choice = await choose(CONFIG);
    expect(choice.id).toBe("claude-haiku-5-5");
    expect(choice.transport).toBe(FAKE);
    expect(built).toHaveLength(1);
    expect(built[0]?.model).toBe("claude-haiku-5-5");
    // A closure, not a key string: the transport asks for the key at call time.
    expect(typeof built[0]?.readApiKey).toBe("function");
    expect(await built[0]?.readApiKey()).toBe(KEY);
    expect(JSON.stringify(built[0])).not.toContain(KEY);
  });

  it("uses the default model of the seeded allowlist", async () => {
    const built: AnthropicTransportDeps[] = [];
    const choose = createChooseSummariser({
      readApiKey: async () => KEY,
      createTransport: (deps) => {
        built.push(deps);
        return FAKE;
      },
    });
    await choose(DEFAULT_RESEARCH_CONFIG);
    expect(DEFAULT_RESEARCH_CONFIG.summariserModel).toBe("claude-haiku-5-5");
    expect(built[0]?.model).toBe("claude-haiku-5-5");
  });

  it("refuses up front, before building any transport, when no key is stored", async () => {
    let built = 0;
    const choose = createChooseSummariser({
      readApiKey: async () => null,
      createTransport: () => {
        built += 1;
        return FAKE;
      },
    });
    await expect(choose(CONFIG)).rejects.toMatchObject({ code: "summariser-unconfigured" });
    await expect(choose(CONFIG)).rejects.toBeInstanceOf(SummariserError);
    expect(built).toBe(0);
  });

  it("refuses with summariser-failed when the key cannot be read, without quoting the failure", async () => {
    const choose = createChooseSummariser({
      readApiKey: async () => {
        throw new Error(`keychain says ${KEY}`);
      },
      createTransport: () => FAKE,
    });
    const error = await choose(CONFIG).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SummariserError);
    expect((error as SummariserError).code).toBe("summariser-failed");
    expect(String((error as Error).message)).not.toContain(KEY);
  });

  it("does not read the key at all for the extractive override", async () => {
    let reads = 0;
    const override = createExtractiveTransport();
    const choose = createChooseSummariser({
      readApiKey: async () => {
        reads += 1;
        return null;
      },
      overrideTransport: override,
      createTransport: () => {
        throw new Error("the live transport must not be built");
      },
    });
    const choice = await choose(CONFIG);
    expect(choice).toEqual({ transport: override, id: "extractive" });
    expect(reads).toBe(0);
  });
});

describe("the pipeline waits for an asynchronous choice", () => {
  it("fails with the choice's own code and fetches nothing when the async choice refuses", async () => {
    const kit = createKit({
      chooseSummariser: async () => {
        throw new SummariserError("summariser-unconfigured");
      },
    });
    try {
      const started = kit.services.runNow();
      expect(started.ok).toBe(true);
      await kit.services.idle();
      expect(kit.fetchCalls).toEqual([]);
      const failed = kit.events.at(-1)?.payload;
      expect(failed).toMatchObject({ outcome: "failure" });
      const row = kit.store.db
        .prepare("SELECT error_code FROM job_runs ORDER BY started_at DESC LIMIT 1")
        .get() as { error_code: string };
      expect(row.error_code).toBe("summariser-unconfigured");
    } finally {
      kit.close();
    }
  });

  it("runs normally with an async choice that resolves", async () => {
    const kit = createKit({
      chooseSummariser: async () => ({ transport: createExtractiveTransport(), id: "extractive" }),
    });
    try {
      kit.services.runNow();
      await kit.services.idle();
      expect(kit.fetchCalls).toHaveLength(1);
      expect(kit.events.at(-1)?.payload).toMatchObject({ outcome: "success" });
    } finally {
      kit.close();
    }
  });
});
