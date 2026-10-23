import { afterEach, describe, expect, it, vi } from "vitest";
import { healthResponse } from "../test-support/health-fixtures.js";
import { configureHealth, HealthApiError, healthApi, healthConfigured } from "./api.js";

/**
 * The health API holder (plan 08-13 Task 1; the `research/api.ts` precedent): one function, a
 * closed error vocabulary, and a trigger that is `gesture` only when it is exactly `gesture`.
 */

afterEach(() => {
  configureHealth(null);
});

describe("the health API holder", () => {
  it("rejects as the service being away until a host configures it", async () => {
    expect(healthConfigured()).toBe(false);
    await expect(healthApi().get("gesture")).rejects.toMatchObject({
      name: "HealthApiError",
      code: "service-disconnected",
      message: "service-disconnected",
    });
  });

  it("passes the response through once configured, and resets on null", async () => {
    const response = healthResponse();
    const get = vi.fn(() => Promise.resolve(response));
    configureHealth({ api: { get } });
    expect(healthConfigured()).toBe(true);
    await expect(healthApi().get("gesture")).resolves.toBe(response);
    expect(get).toHaveBeenCalledWith("gesture");

    configureHealth(null);
    expect(healthConfigured()).toBe(false);
    await expect(healthApi().get("reconnect")).rejects.toBeInstanceOf(HealthApiError);
  });

  it("sends gesture only for the exact word, and reconnect for anything else (Amendment A1)", async () => {
    const get = vi.fn((_trigger: string) => Promise.resolve(healthResponse()));
    configureHealth({ api: { get } });
    await healthApi().get("reconnect");
    await healthApi().get("Gesture" as never);
    await healthApi().get(undefined as never);
    await healthApi().get("gesture");
    expect(get.mock.calls.map((call) => call[0])).toEqual([
      "reconnect",
      "reconnect",
      "reconnect",
      "gesture",
    ]);
  });
});
