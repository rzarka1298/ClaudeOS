import { act, cleanup, fireEvent, render, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState } from "../connection-state.js";
import type { TestOutcome } from "../projects/launchers-actions.js";
import { deferred, fakeLaunchersActions } from "../test-support/launchers-fixtures.js";
import { createLaunchersSession, LaunchersSettings } from "./launchers-settings.js";

/**
 * Judge-panel finding: the Test follow-up's focus guard read the global
 * `document.activeElement`. In an Obsidian popout window the panel lives in
 * another document, where the global document's active element says nothing
 * about where the owner is — so it must read the panel's ownerDocument.
 */

const NOW = Date.parse("2026-09-30T10:05:00.000Z");
const LIVE: ConnectionState = { kind: "live" };

afterEach(cleanup);

/** A second document, as an Obsidian popout window has: an iframe's own. */
function popoutDocument(): Document {
  const { container } = render(<iframe title="Popout window" />);
  const doc = container.querySelector("iframe")?.contentDocument ?? null;
  if (doc === null) throw new Error("iframe has no document");
  return doc;
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

describe("Test follow-up focus in a popout window", () => {
  it("leaves focus on a field the owner moved to in the popout while the Test was pending", async () => {
    const doc = popoutDocument();
    const pending = deferred<TestOutcome>();
    const actions = fakeLaunchersActions({ test: vi.fn(() => pending.promise) });
    render(
      <div>
        <input aria-label="Somewhere else" />
        <LaunchersSettings
          actions={actions}
          connection={LIVE}
          now={NOW}
          session={createLaunchersSession()}
        />
      </div>,
      { container: doc.body },
    );
    await settle();
    const elsewhere = within(doc.body).getByRole("textbox", { name: "Somewhere else" });

    const finder = within(doc.body).getByRole("region", { name: "Finder" });
    const testButton = within(finder).getByRole("button", { name: "Test the Finder launcher" });
    testButton.focus();
    fireEvent.click(testButton);
    elsewhere.focus();
    expect(doc.activeElement).toBe(elsewhere);

    await act(async () => pending.resolve({ kind: "sent" }));
    await settle();

    expect(within(finder).getByRole("button", { name: "It opened" })).toBeTruthy();
    expect(doc.activeElement).toBe(elsewhere);
  });

  it("moves focus to It opened when the owner stayed on Test launcher in the popout", async () => {
    const doc = popoutDocument();
    render(
      <LaunchersSettings
        actions={fakeLaunchersActions()}
        connection={LIVE}
        now={NOW}
        session={createLaunchersSession()}
      />,
      { container: doc.body },
    );
    await settle();

    const finder = within(doc.body).getByRole("region", { name: "Finder" });
    const testButton = within(finder).getByRole("button", { name: "Test the Finder launcher" });
    testButton.focus();
    fireEvent.click(testButton);
    await settle();

    expect(doc.activeElement).toBe(within(finder).getByRole("button", { name: "It opened" }));
  });
});
