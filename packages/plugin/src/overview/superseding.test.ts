import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { signal } from "@preact/signals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedSnapshot } from "./feed-snapshot.js";
import { superseding } from "./superseding.js";

/**
 * The superseding helper (09-06, D-13): one owner of a feed's sequence token. A later refresh
 * supersedes an earlier one in flight, a failure keeps the last good value and marks the feed
 * failed, and `invalidate()` makes an answer still in flight land nowhere.
 */

const NEVER: FeedSnapshot<string> = { settled: false, value: null, fetchedAt: null, failed: false };
const NOW = Date.parse("2026-10-22T18:00:00Z");

interface Deferred {
  readonly promise: Promise<string>;
  resolve(value: string): void;
  reject(reason: unknown): void;
}

function deferred(): Deferred {
  let resolve!: (value: string) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("superseding(feed, fetcher)", () => {
  it("Test 1a: a slow answer A started before a fast answer B and resolved after it never overwrites B", async () => {
    const feed = signal<FeedSnapshot<string>>(NEVER);
    const calls = [deferred(), deferred()];
    let next = 0;
    const { refresh } = superseding(feed, () => (calls[next++] as Deferred).promise);
    const first = refresh();
    const second = refresh();
    (calls[1] as Deferred).resolve("B");
    await second;
    expect(feed.value).toEqual({ settled: true, value: "B", fetchedAt: NOW, failed: false });
    (calls[0] as Deferred).resolve("A");
    await first;
    expect(feed.value.value).toBe("B");
  });

  it("Test 1b: a rejected fetch keeps the previous value and marks the feed settled and failed", async () => {
    const feed = signal<FeedSnapshot<string>>(NEVER);
    const answers: Deferred[] = [deferred(), deferred()];
    let next = 0;
    const { refresh } = superseding(feed, () => (answers[next++] as Deferred).promise);
    const good = refresh();
    (answers[0] as Deferred).resolve("good");
    await good;
    const bad = refresh();
    (answers[1] as Deferred).reject(new Error("service away"));
    await bad;
    expect(feed.value).toEqual({ settled: true, value: "good", fetchedAt: NOW, failed: true });
  });

  it("Test 1b': a failure with no earlier value is settled, failed and empty", async () => {
    const feed = signal<FeedSnapshot<string>>(NEVER);
    const { refresh } = superseding(feed, () => Promise.reject(new Error("never answered")));
    await refresh();
    expect(feed.value).toEqual({ settled: true, value: null, fetchedAt: null, failed: true });
  });

  it("Test 1c: invalidate() makes an answer in flight land nowhere, and the next refresh still lands", async () => {
    const feed = signal<FeedSnapshot<string>>(NEVER);
    const calls = [deferred(), deferred()];
    let next = 0;
    const { refresh, invalidate } = superseding(feed, () => (calls[next++] as Deferred).promise);
    const inFlight = refresh();
    invalidate();
    (calls[0] as Deferred).resolve("late");
    await inFlight;
    expect(feed.value).toEqual(NEVER);

    const again = refresh();
    (calls[1] as Deferred).resolve("fresh");
    await again;
    expect(feed.value.value).toBe("fresh");
  });

  it("FIX2A R8a: an older answer that REJECTS after a newer success leaves the newer value and does not mark the feed failed", async () => {
    const feed = signal<FeedSnapshot<string>>(NEVER);
    const calls = [deferred(), deferred()];
    let next = 0;
    const { refresh } = superseding(feed, () => (calls[next++] as Deferred).promise);
    const older = refresh();
    const newer = refresh();
    (calls[1] as Deferred).resolve("newer");
    await newer;
    (calls[0] as Deferred).reject(new Error("late failure"));
    await older;
    expect(feed.value).toEqual({ settled: true, value: "newer", fetchedAt: NOW, failed: false });
  });

  it("FIX2A R8b: a newer failure while an older success is in flight is recorded, and the older success is ignored", async () => {
    const feed = signal<FeedSnapshot<string>>(NEVER);
    const calls = [deferred(), deferred()];
    let next = 0;
    const { refresh } = superseding(feed, () => (calls[next++] as Deferred).promise);
    const older = refresh();
    const newer = refresh();
    (calls[1] as Deferred).reject(new Error("service away"));
    await newer;
    expect(feed.value).toEqual({ settled: true, value: null, fetchedAt: null, failed: true });
    (calls[0] as Deferred).resolve("older success");
    await older;
    // The newer attempt is the latest word: its failure stands and the stale success does not undo it.
    expect(feed.value).toEqual({ settled: true, value: null, fetchedAt: null, failed: true });
  });

  it("FIX2A R6: the helper takes FeedSnapshot from the shared module, so it and overview-feeds do not import each other", () => {
    const source = readFileSync(resolve(process.cwd(), "src/overview/superseding.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["']\.\/overview-feeds\.js["']/);
    expect(source).toMatch(/from\s+["']\.\/feed-snapshot\.js["']/);
  });
});
