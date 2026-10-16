import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeResearchApi, fakeResearchPorts } from "../test-support/research-api-fake.js";
import {
  configureResearch,
  ResearchApiError,
  researchApi,
  researchConfigured,
  researchPorts,
} from "./api.js";

afterEach(() => {
  configureResearch(null);
});

describe("the research port holder (plan 07-11, D-23 transport rule)", () => {
  it("is unconfigured by default: every call rejects as if the service were away", async () => {
    expect(researchConfigured()).toBe(false);
    const api = researchApi();
    for (const call of [
      () => api.run(),
      () => api.status(),
      () => api.list(),
      () => api.report("a".repeat(25), "items"),
    ]) {
      await expect(call()).rejects.toMatchObject({
        name: "ResearchApiError",
        code: "service-disconnected",
      });
    }
  });

  it("has host ports that do nothing until configured, and never throw", async () => {
    const ports = researchPorts();
    expect(() => ports.notify("x")).not.toThrow();
    expect(() => ports.requestRunNow()).not.toThrow();
    await expect(Promise.resolve(ports.openNote("global/output/a.md"))).resolves.toBe(false);
    await expect(Promise.resolve(ports.copyText("x"))).resolves.toBe(false);
  });

  it("routes the four API calls and the four host ports to what configureResearch installed", async () => {
    const api = fakeResearchApi({
      report: vi.fn(() =>
        Promise.resolve({
          page: "sources" as const,
          sources: [],
          nextCursor: null,
          truncated: false,
        }),
      ),
    });
    const ports = fakeResearchPorts();
    configureResearch({ api, ...ports });
    expect(researchConfigured()).toBe(true);

    await researchApi().run();
    await researchApi().status();
    await researchApi().list("cursor_1");
    await researchApi().report("n".repeat(25), "sources", "cursor_2");
    expect(api.run).toHaveBeenCalledTimes(1);
    expect(api.status).toHaveBeenCalledTimes(1);
    expect(api.list).toHaveBeenCalledWith("cursor_1");
    expect(api.report).toHaveBeenCalledWith("n".repeat(25), "sources", "cursor_2");

    researchPorts().notify("hello");
    void researchPorts().requestRunNow();
    await researchPorts().openNote("global/output/a.md");
    await researchPorts().copyText("text");
    expect(ports.notify).toHaveBeenCalledWith("hello");
    expect(ports.requestRunNow).toHaveBeenCalledTimes(1);
    expect(ports.openNote).toHaveBeenCalledWith("global/output/a.md");
    expect(ports.copyText).toHaveBeenCalledWith("text");
  });

  it("exposes exactly the four API functions and the four ports, nothing else", () => {
    configureResearch({ api: fakeResearchApi(), ...fakeResearchPorts() });
    expect(Object.keys(researchApi()).sort()).toEqual(["list", "report", "run", "status"]);
    expect(Object.keys(researchPorts()).sort()).toEqual([
      "copyText",
      "notify",
      "openNote",
      "requestRunNow",
    ]);
  });

  it("restores the disconnected default when configured with null", async () => {
    configureResearch({ api: fakeResearchApi(), ...fakeResearchPorts() });
    configureResearch(null);
    expect(researchConfigured()).toBe(false);
    await expect(researchApi().status()).rejects.toMatchObject({ code: "service-disconnected" });
  });

  it("an error carries the closed code and nothing else (message equals the code)", () => {
    const error = new ResearchApiError("timeout");
    expect(error.code).toBe("timeout");
    expect(error.message).toBe("timeout");
    expect(error).toBeInstanceOf(Error);
  });
});

describe("the research modules never reach Obsidian or the service client (acceptance)", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const FILES = ["api.ts", "state.ts"] as const;

  it.each(FILES)("%s imports neither obsidian nor the service client", (file) => {
    const source = readFileSync(join(HERE, file), "utf8");
    const specifiers = [
      ...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gms),
    ].map((match) => match[1] as string);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier, `${file} imports ${specifier}`).not.toMatch(
        /obsidian|service-api-client|connector|executor/i,
      );
    }
  });
});
