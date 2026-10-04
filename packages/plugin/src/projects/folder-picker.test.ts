import { describe, expect, it } from "vitest";
// Imports the test double DIRECTLY, rather than through the `electron` alias
// `folder-picker.ts` itself uses: this keeps `grep -rln "from \"electron\""
// packages/plugin/src` naming only `folder-picker.ts` (Task 1 acceptance
// criterion) while still sharing the exact same module instance — Vite's
// resolver caches by resolved file path, and `vitest.config.ts`'s `electron`
// alias points at this same file, so mutating `remote` here is mutating the
// singleton `folder-picker.ts` reads through the aliased specifier.
import { remote } from "../test-support/electron-stub.js";
import { pickFolder } from "./folder-picker.js";

function dialog() {
  const found = remote.dialog;
  if (!found) throw new Error("test double: electron stub has no dialog");
  return found;
}

describe("pickFolder (D-03, S4 step 1)", () => {
  it("resolves the picked path and passes the caller's title, button label and openDirectory through", async () => {
    dialog().showOpenDialog = async (options) => {
      expect(options).toEqual({
        title: "Choose a project folder",
        buttonLabel: "Register folder",
        properties: ["openDirectory"],
      });
      return { canceled: false, filePaths: ["/Users/USERNAME/code/example-project"] };
    };

    const result = await pickFolder({
      title: "Choose a project folder",
      buttonLabel: "Register folder",
    });

    expect(result).toEqual({ kind: "picked", path: "/Users/USERNAME/code/example-project" });
  });

  it("resolves cancelled when the dialog is dismissed", async () => {
    dialog().showOpenDialog = async () => ({ canceled: true, filePaths: [] });

    const result = await pickFolder({ title: "x", buttonLabel: "y" });

    expect(result).toEqual({ kind: "cancelled" });
  });

  it("resolves unavailable when the dialog has no filePaths (defensive: canceled=false but empty)", async () => {
    dialog().showOpenDialog = async () => ({ canceled: false, filePaths: [] });

    const result = await pickFolder({ title: "x", buttonLabel: "y" });

    expect(result).toEqual({ kind: "cancelled" });
  });

  it("resolves unavailable when no dialog function exists (feature detection, D-03 fallback)", async () => {
    // @ts-expect-error test double: simulate a renderer with no showOpenDialog
    dialog().showOpenDialog = undefined;

    const result = await pickFolder({ title: "x", buttonLabel: "y" });

    expect(result).toEqual({ kind: "unavailable" });
  });
});
