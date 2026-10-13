import { describe, expect, it } from "vitest";
import { allMotionOff, anyMotionOn } from "./spec-support/cross-support.js";
import { isRunCurrent } from "./staleness.js";

const H = "a".repeat(40);
const base = { recordedHead: H, currentHead: H, changedFiles: [] as string[] };

describe("wave 3 audit b: staleness clean flags", () => {
  it("is stale when the recorded run was dirty, even at the same HEAD", () => {
    expect(isRunCurrent({ ...base, recordedClean: false, currentClean: true }).current).toBe(false);
  });
  it("is stale when the recorded clean flag is unknown", () => {
    expect(isRunCurrent({ ...base, recordedClean: undefined, currentClean: true }).current).toBe(
      false,
    );
  });
  it("is stale when the tree is dirty or unknown now", () => {
    expect(isRunCurrent({ ...base, recordedClean: true, currentClean: false }).current).toBe(false);
    expect(isRunCurrent({ ...base, recordedClean: true, currentClean: undefined }).current).toBe(
      false,
    );
  });
  it("is current only when both are clean at the same HEAD", () => {
    expect(isRunCurrent({ ...base, recordedClean: true, currentClean: true }).current).toBe(true);
  });
});

describe("wave 3 audit b: motion verdict", () => {
  it("counts an unreadable duration as motion, never as off", () => {
    expect(
      allMotionOff([
        { transitionDuration: "garbage", animationDuration: "0s", animationName: "none" },
      ]),
    ).toBe(false);
    expect(
      anyMotionOn([
        { transitionDuration: "garbage", animationDuration: "0s", animationName: "none" },
      ]),
    ).toBe(true);
  });
  it("counts any named animation with a positive duration as motion", () => {
    expect(
      allMotionOff([
        { transitionDuration: "0s", animationDuration: "0s, 1s", animationName: "none, spin" },
      ]),
    ).toBe(false);
  });
  it("accepts a zero everything sample as off", () => {
    expect(
      allMotionOff([{ transitionDuration: "0s", animationDuration: "0s", animationName: "none" }]),
    ).toBe(true);
  });
});
