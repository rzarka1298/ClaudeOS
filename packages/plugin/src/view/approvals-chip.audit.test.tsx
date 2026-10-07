import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureApprovalsApi } from "../approvals/api.js";
import { resetApprovalsState } from "../approvals/signals.js";
import { connectionState } from "../connection-state.js";
import { approvalsSnapshot } from "../test-support/approval-fixtures.js";
import { FIXTURE_NOW_MS } from "../test-support/approval-view-fixtures.js";
import { ApprovalsSection } from "./approvals-section.js";
import { approvalChip, resetApprovalsView } from "./approvals-state.js";

/**
 * Wave 4 audit of 06-17: the three filter chips are "default Pending, never
 * persisted" (D-23, UI-SPEC S1). A chip choice is session state only: a fresh
 * mount always opens on Pending, and no approval view module reaches a
 * storage API.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const STORAGE_NAMES = [
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "saveData",
  "loadData",
  "app.saveLocalStorage",
  "data.json",
];

beforeEach(() => {
  configureApprovalsApi({
    list: async () => approvalsSnapshot(),
    get: async () => {
      throw new Error("get was not expected");
    },
    decide: async () => {
      throw new Error("decide was not expected");
    },
    test: async () => {
      throw new Error("test was not expected");
    },
  });
  resetApprovalsState();
  resetApprovalsView();
  connectionState.value = { kind: "live" };
});
afterEach(() => {
  cleanup();
  configureApprovalsApi(null);
  resetApprovalsState();
  resetApprovalsView();
  connectionState.value = { kind: "connecting" };
});

describe("the approval filter chip is never persisted", () => {
  it.each(["approvals-state.ts", "approvals-section.tsx"])("%s reaches no storage API", (file) => {
    const source = readFileSync(join(HERE, file), "utf8");
    for (const name of STORAGE_NAMES) {
      expect(source, `${file} mentions ${name}`).not.toContain(name);
    }
  });

  it("opens on Pending after a previous mount ended on Decided and the view state was reset", () => {
    const first = render(<ApprovalsSection now={FIXTURE_NOW_MS} />);
    fireEvent.click(screen.getByRole("button", { name: /^Decided/ }));
    expect(approvalChip.value).toBe("decided");
    first.unmount();
    resetApprovalsView();
    render(<ApprovalsSection now={FIXTURE_NOW_MS} />);
    expect(screen.getByRole("button", { name: /^Pending/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: /^Decided/ }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });
});
