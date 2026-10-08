import type { TaskFormOption } from "../view/task-form.js";

/**
 * The structural slice of the Obsidian vault and metadata cache that the
 * workspace list reads. Workspaces live at `workspaces/<id>/`, and each root
 * `index.md` carries the display name in its `displayName` frontmatter field;
 * the folder name is the opaque id (VAULT-09).
 */
export interface WorkspaceVault {
  folderChildren(path: string): readonly { readonly name: string; readonly isFolder: boolean }[];
  displayName(indexPath: string): unknown;
}

const WORKSPACE_ID = /^[0-9a-z]{25}$/;

/** Lists the vault's workspaces as `workspace:<id>` options; an unnamed one shows its id. */
export function listVaultWorkspaces(vault: WorkspaceVault): Promise<readonly TaskFormOption[]> {
  const options: TaskFormOption[] = [];
  for (const child of vault.folderChildren("workspaces")) {
    if (!child.isFolder || !WORKSPACE_ID.test(child.name)) continue;
    const name = vault.displayName(`workspaces/${child.name}/index.md`);
    options.push({
      id: `workspace:${child.name}`,
      name: typeof name === "string" && name.trim() !== "" ? name : child.name,
    });
  }
  return Promise.resolve(options);
}
