import { describe, expect, it } from "vitest";
import { listVaultWorkspaces } from "./workspaces.js";

const ID = "abcdefghij0123456789abcde";

describe("listVaultWorkspaces", () => {
  it("lists workspace folders with their display names and skips everything else", async () => {
    const result = await listVaultWorkspaces({
      folderChildren: () => [
        { name: ID, isFolder: true },
        { name: "notes.md", isFolder: false },
        { name: "short", isFolder: true },
      ],
      displayName: (path) => (path === `workspaces/${ID}/index.md` ? "Research" : undefined),
    });
    expect(result).toEqual([{ id: `workspace:${ID}`, name: "Research" }]);
  });

  it("falls back to the id when the index has no usable name", async () => {
    const result = await listVaultWorkspaces({
      folderChildren: () => [{ name: ID, isFolder: true }],
      displayName: () => 42,
    });
    expect(result).toEqual([{ id: `workspace:${ID}`, name: ID }]);
  });
});
