import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingRow, SettingSelect, SettingSwitch, StatusLine } from "./settings-controls.js";

/**
 * The shared Settings controls (plan 08-11 Task 3; 08-UI-SPEC S2 Controls, accessibility
 * additions 6 to 8): a row that groups name, description and control; a switch that is a button;
 * a native select in its wrap; and the one polite status line.
 */

afterEach(cleanup);

/** A promise the test settles by hand, so "before the await" is observable. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("SettingRow", () => {
  it("is a labelled group whose first child is the name, then the description", () => {
    render(
      <SettingRow
        name="Approval notifications"
        description="Show a notification."
        control={() => <span>control</span>}
      />,
    );
    const group = screen.getByRole("group", { name: "Approval notifications" });
    expect(group.className).toContain("ccc-setting-row");
    const text = group.querySelector(".ccc-setting-row-text");
    expect(text?.firstElementChild?.textContent).toBe("Approval notifications");
    expect(text?.querySelector("p")?.textContent).toBe("Show a notification.");
    expect(group.querySelector(".ccc-setting-row-control")?.textContent).toBe("control");
  });

  it("hands the control the ids of the name and the description", () => {
    const seen: Array<{ nameId: string; descriptionId: string | undefined }> = [];
    render(
      <SettingRow
        name="Name"
        description="Description"
        control={(ids) => {
          seen.push(ids);
          return <span />;
        }}
      />,
    );
    const ids = seen[0];
    expect(document.getElementById(ids?.nameId ?? "")?.textContent).toBe("Name");
    expect(document.getElementById(ids?.descriptionId ?? "")?.textContent).toBe("Description");
  });
});

describe("Task 3 Test 1: SettingSwitch", () => {
  function renderSwitch(
    onChange: (next: boolean) => Promise<"saved" | "reverted">,
    checked = false,
  ) {
    return render(
      <SettingRow
        name="Approval notifications"
        description="Show a notification."
        control={({ nameId, descriptionId }) => (
          <SettingSwitch
            checked={checked}
            labelledBy={nameId}
            describedBy={descriptionId}
            onChange={onChange}
          />
        )}
      />,
    );
  }

  it("is a button with role switch, aria-checked, a hidden On/Off word and the row's name and description", () => {
    renderSwitch(() => Promise.resolve("saved"), true);
    const toggle = screen.getByRole("switch", { name: "Approval notifications" });
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.getAttribute("type")).toBe("button");
    expect(toggle.className).toContain("ccc-switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    const word = toggle.querySelector("span");
    expect(word?.textContent).toBe("On");
    expect(word?.getAttribute("aria-hidden")).toBe("true");
    const described = document.getElementById(toggle.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe("Show a notification.");
    expect(toggle.hasAttribute("disabled")).toBe(false);
  });

  it("reads Off when unchecked", () => {
    renderSwitch(() => Promise.resolve("saved"), false);
    const toggle = screen.getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.textContent).toBe("Off");
  });

  it("sets aria-busy and aria-disabled before the change resolves, and ignores a second activation", async () => {
    const pending = deferred<"saved" | "reverted">();
    const onChange = vi.fn(() => pending.promise);
    renderSwitch(onChange);
    const toggle = screen.getByRole("switch");

    fireEvent.click(toggle);
    // A second activation in the same tick (before any render) is refused by the ref guard.
    fireEvent.click(toggle);
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(toggle.getAttribute("aria-busy")).toBe("true");
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    // The visible word shows the value being saved.
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledTimes(1);

    pending.resolve("saved");
    await flush();
    expect(toggle.getAttribute("aria-busy")).toBeNull();
    expect(toggle.getAttribute("aria-disabled")).toBeNull();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("reverts when the change comes back reverted", async () => {
    const pending = deferred<"saved" | "reverted">();
    renderSwitch(() => pending.promise, true);
    const toggle = screen.getByRole("switch");
    fireEvent.click(toggle);
    await flush();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    pending.resolve("reverted");
    await flush();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.textContent).toBe("On");
    expect(toggle.getAttribute("aria-busy")).toBeNull();
  });

  it("reverts, and stays usable, when the change rejects", async () => {
    const onChange = vi
      .fn<(next: boolean) => Promise<"saved" | "reverted">>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("saved");
    renderSwitch(onChange, false);
    const toggle = screen.getByRole("switch");
    fireEvent.click(toggle);
    await flush();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.getAttribute("aria-busy")).toBeNull();
    fireEvent.click(toggle);
    await flush();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("follows the committed value when the caller changes it", async () => {
    const view = renderSwitch(() => Promise.resolve("saved"), false);
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    view.rerender(
      <SettingRow
        name="Approval notifications"
        description="Show a notification."
        control={({ nameId }) => (
          <SettingSwitch checked labelledBy={nameId} onChange={() => Promise.resolve("saved")} />
        )}
      />,
    );
    await flush();
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });

  it("an unavailable switch is aria-disabled and does nothing, with no native disabled attribute", async () => {
    const onChange = vi.fn(() => Promise.resolve("saved" as const));
    render(<SettingSwitch checked={false} labelledBy="x" unavailable onChange={onChange} />);
    const toggle = screen.getByRole("switch");
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(toggle.hasAttribute("disabled")).toBe(false);
    fireEvent.click(toggle);
    await flush();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("Task 3 Test 2: SettingSelect", () => {
  const OPTIONS = { auto: "System", reduced: "Always reduced" } as const;

  function renderSelect(
    onChange: (value: string) => Promise<"saved" | "reverted">,
    value = "auto",
  ) {
    return render(
      <SettingRow
        name="Reduced motion"
        description="Turn off decorative motion."
        control={({ nameId, descriptionId }) => (
          <SettingSelect
            value={value}
            options={OPTIONS}
            labelledBy={nameId}
            describedBy={descriptionId}
            onChange={onChange}
          />
        )}
      />,
    );
  }

  it("is a native select in a .ccc-select-wrap, named by the row, with every option labelled", () => {
    renderSelect(() => Promise.resolve("saved"));
    const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "Reduced motion" });
    expect(select.tagName).toBe("SELECT");
    expect(select.className).toContain("ccc-select");
    expect(select.parentElement?.className).toContain("ccc-select-wrap");
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
      ["auto", "System"],
      ["reduced", "Always reduced"],
    ]);
    expect(select.value).toBe("auto");
    const described = document.getElementById(select.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe("Turn off decorative motion.");
  });

  it("calls onChange with the chosen value and keeps it when saved", async () => {
    const onChange = vi.fn(() => Promise.resolve("saved" as const));
    renderSelect(onChange);
    const select = screen.getByRole<HTMLSelectElement>("combobox");
    fireEvent.change(select, { target: { value: "reduced" } });
    await flush();
    expect(onChange).toHaveBeenCalledWith("reduced");
    expect(select.value).toBe("reduced");
  });

  it("restores the previous option when the save is reverted", async () => {
    const pending = deferred<"saved" | "reverted">();
    renderSelect(() => pending.promise);
    const select = screen.getByRole<HTMLSelectElement>("combobox");
    fireEvent.change(select, { target: { value: "reduced" } });
    await flush();
    expect(select.value).toBe("reduced");
    expect(select.getAttribute("aria-busy")).toBe("true");
    pending.resolve("reverted");
    await flush();
    expect(select.value).toBe("auto");
    expect(select.getAttribute("aria-busy")).toBeNull();
  });

  it("restores the previous option when the change rejects", async () => {
    renderSelect(() => Promise.reject(new Error("boom")));
    const select = screen.getByRole<HTMLSelectElement>("combobox");
    fireEvent.change(select, { target: { value: "reduced" } });
    await flush();
    expect(select.value).toBe("auto");
  });

  it("ignores a second change while one is being saved", async () => {
    const pending = deferred<"saved" | "reverted">();
    const onChange = vi.fn(() => pending.promise);
    renderSelect(onChange);
    const select = screen.getByRole<HTMLSelectElement>("combobox");
    fireEvent.change(select, { target: { value: "reduced" } });
    fireEvent.change(select, { target: { value: "auto" } });
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(select.value).toBe("reduced");
  });

  it("never uses the native disabled attribute", () => {
    renderSelect(() => Promise.resolve("saved"));
    expect(screen.getByRole("combobox").hasAttribute("disabled")).toBe(false);
  });
});

describe("StatusLine", () => {
  it("is one polite role=status paragraph, present and empty before its first message", () => {
    const view = render(<StatusLine message="" />);
    const line = screen.getByRole("status");
    expect(line.tagName).toBe("P");
    expect(line.className).toContain("ccc-settings-status");
    expect(line.textContent).toBe("");
    view.rerender(<StatusLine message="Bundle copied." />);
    expect(screen.getByRole("status")).toBe(line);
    expect(line.textContent).toBe("Bundle copied.");
  });
});
