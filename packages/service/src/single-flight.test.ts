import { describe, expect, it, vi } from "vitest";
import { createSingleFlight, raceSignal } from "./single-flight.js";

/** FIX6A Codex-1: the keyed single-flight table the file-system reads share. */
describe("createSingleFlight", () => {
  it("shares a pending call per key, starts a fresh one after it settles, and keeps keys apart", async () => {
    const flight = createSingleFlight();
    const gates: Array<() => void> = [];
    const start = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          gates.push(() => resolve(gates.length));
        }),
    );
    const a1 = flight.run("a", start);
    const a2 = flight.run("a", start);
    const b = flight.run("b", start);
    expect(start).toHaveBeenCalledTimes(2);
    expect(a1).toBe(a2);
    for (const open of gates) open();
    await Promise.all([a1, b]);
    flight.run("a", start);
    expect(start).toHaveBeenCalledTimes(3);
  });

  it("drops a rejected call's entry and turns a synchronous throw into a rejection", async () => {
    const flight = createSingleFlight();
    await expect(flight.run("k", () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(
      flight.run("k", () => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
    await expect(flight.run("k", () => Promise.resolve(1))).resolves.toBe(1);
  });
});

describe("raceSignal", () => {
  it("answers onAbort when the signal fires first and the value when the call does", async () => {
    const c = new AbortController();
    const pending = new Promise<string>(() => undefined);
    const raced = raceSignal(pending, c.signal, () => "aborted");
    c.abort();
    expect(await raced).toBe("aborted");
    expect(await raceSignal(Promise.resolve("v"), new AbortController().signal, () => "a")).toBe(
      "v",
    );
    expect(await raceSignal(Promise.resolve("v"), undefined, () => "a")).toBe("v");
  });
});
