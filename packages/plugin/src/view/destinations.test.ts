import { describe, expect, it } from "vitest";
import { DESTINATIONS, nextDestination } from "./destinations.js";

describe("DESTINATIONS", () => {
  it("has exactly eight entries in the required order", () => {
    expect(DESTINATIONS).toHaveLength(8);
    expect(DESTINATIONS.map((d) => d.label)).toEqual([
      "Overview",
      "Projects",
      "Research",
      "Tasks",
      "Agent runs",
      "Skills",
      "Knowledge",
      "Settings",
    ]);
  });

  it("every id is a distinct, non-empty string", () => {
    const ids = DESTINATIONS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.length).toBeGreaterThan(0);
  });
});

describe("nextDestination", () => {
  it("moves forward through the list in order", () => {
    expect(nextDestination("overview", "next")).toBe("projects");
    expect(nextDestination("projects", "next")).toBe("research");
  });

  it("moves backward through the list in order", () => {
    expect(nextDestination("research", "previous")).toBe("projects");
    expect(nextDestination("projects", "previous")).toBe("overview");
  });

  it("wraps from the last entry to the first when moving next", () => {
    expect(nextDestination("settings", "next")).toBe("overview");
  });

  it("wraps from the first entry to the last when moving previous", () => {
    expect(nextDestination("overview", "previous")).toBe("settings");
  });
});
