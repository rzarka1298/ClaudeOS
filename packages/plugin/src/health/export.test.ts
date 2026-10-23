import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { remote, type SaveDialogOptions } from "../test-support/electron-stub.js";
import {
  copyBundle,
  defaultBundleFileName,
  isInsideVault,
  pickSavePath,
  saveBundle,
  saveDialogAvailable,
  writeBundleFile,
} from "./export.js";

/**
 * The export seam (plan 08-16 Task 2; D-12, T-08-41, T-08-42): a typed save dialog, and a write
 * that goes only to an absolute `.json` path outside the open vault, atomically, with mode 0600,
 * never following a symlink, and that never reports the path it wrote.
 */

const NOW = Date.parse("2026-10-22T10:00:00.000Z");
const TEXT = '{\n  "bundleVersion": 1\n}';

let root: string;
let vault: string;
let outside: string;

function dialog() {
  return remote.dialog;
}

function choose(path: string | undefined, canceled = false): void {
  dialog().showSaveDialog = () => Promise.resolve({ canceled, filePath: path });
}

function files(dir: string): string[] {
  return readdirSync(dir).sort();
}

beforeEach(() => {
  // On macOS the temporary folder sits behind the /var -> /private/var link, which is the point:
  // the lexical path and the real path differ and the containment check must see through it.
  root = mkdtempSync(join(tmpdir(), "ccc-export-"));
  vault = join(root, "Vault");
  outside = join(root, "out");
  mkdirSync(vault);
  mkdirSync(outside);
  choose(undefined, true);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  choose(undefined, true);
});

describe("defaultBundleFileName", () => {
  it("is the bare name with the UTC date, whatever the local zone", () => {
    expect(defaultBundleFileName(Date.parse("2026-10-22T23:59:59.000Z"))).toBe(
      "claude-command-center-diagnostics-2026-10-22.json",
    );
    expect(defaultBundleFileName(Date.parse("2026-10-23T00:00:00.000Z"))).toBe(
      "claude-command-center-diagnostics-2026-10-23.json",
    );
    expect(defaultBundleFileName(NOW)).not.toContain("/");
  });
});

describe("pickSavePath", () => {
  it("opens the dialog with a bare default name, a JSON filter and overwrite confirmation", async () => {
    let seen: SaveDialogOptions | undefined;
    dialog().showSaveDialog = (options) => {
      seen = options;
      return Promise.resolve({ canceled: false, filePath: join(outside, "b.json") });
    };
    const pick = await pickSavePath({ defaultName: defaultBundleFileName(NOW) });
    expect(pick).toEqual({ kind: "picked", path: join(outside, "b.json") });
    expect(seen?.defaultPath).toBe("claude-command-center-diagnostics-2026-10-22.json");
    expect(seen?.defaultPath).not.toContain("/");
    expect(seen?.filters).toEqual([{ name: "JSON", extensions: ["json"] }]);
    expect(seen?.properties).toContain("showOverwriteConfirmation");
  });

  it("is cancelled for a dismissed dialog and for a result with no path", async () => {
    choose(undefined, true);
    expect(await pickSavePath({ defaultName: "x.json" })).toEqual({ kind: "cancelled" });
    choose(undefined, false);
    expect(await pickSavePath({ defaultName: "x.json" })).toEqual({ kind: "cancelled" });
    choose("", false);
    expect(await pickSavePath({ defaultName: "x.json" })).toEqual({ kind: "cancelled" });
  });

  it("never throws: no dialog function is unavailable, a throwing dialog is failed", async () => {
    dialog().showSaveDialog = () => Promise.reject(new Error("/Users/username/secret"));
    expect(await pickSavePath({ defaultName: "x.json" })).toEqual({ kind: "failed" });
    // @ts-expect-error test double: simulate a renderer with no showSaveDialog
    dialog().showSaveDialog = undefined;
    expect(saveDialogAvailable()).toBe(false);
    expect(await pickSavePath({ defaultName: "x.json" })).toEqual({ kind: "unavailable" });
  });

  it("reports the dialog as available when the function exists", () => {
    expect(saveDialogAvailable()).toBe(true);
  });
});

describe("Task 2, Test 1: a save writes the text byte for byte with mode 0600 and reports no path", () => {
  it("writes to the picked absolute .json path outside the vault", async () => {
    const target = join(outside, "b.json");
    choose(target);
    const result = await saveBundle(TEXT, vault, NOW);
    expect(result).toEqual({ kind: "saved" });
    expect(readFileSync(target, "utf8")).toBe(TEXT);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    // No temporary file is left behind, and the vault is untouched.
    expect(files(outside)).toEqual(["b.json"]);
    expect(files(vault)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it("replaces an existing regular file atomically and keeps mode 0600", async () => {
    const target = join(outside, "b.json");
    writeFileSync(target, "old contents", { mode: 0o644 });
    choose(target);
    expect(await saveBundle(TEXT, vault, NOW)).toEqual({ kind: "saved" });
    expect(readFileSync(target, "utf8")).toBe(TEXT);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(files(outside)).toEqual(["b.json"]);
  });

  it("an upper-case .JSON extension is still a JSON file", async () => {
    const target = join(outside, "b.JSON");
    choose(target);
    expect(await saveBundle(TEXT, vault, NOW)).toEqual({ kind: "saved" });
    expect(readFileSync(target, "utf8")).toBe(TEXT);
  });
});

describe("Task 2, Test 3: refusals write nothing", () => {
  async function refused(path: string, vaultBase: string | null = vault) {
    const before = [...files(vault), ...files(outside)];
    const result = await writeBundleFile(TEXT, path, vaultBase);
    expect([...files(vault), ...files(outside)]).toEqual(before);
    return result;
  }

  it("refuses a path inside the vault, however it is spelled", async () => {
    mkdirSync(join(vault, "sub"));
    const spellings = [
      join(vault, "b.json"),
      `${vault}//b.json`,
      join(vault, "sub", "b.json"),
      join(vault, "sub", "..", "b.json"),
      join(outside, "..", "Vault", "b.json"),
      join(vault, ".", "b.json"),
    ];
    for (const spelling of spellings) {
      const before = files(vault);
      expect(await writeBundleFile(TEXT, spelling, vault), spelling).toEqual({
        kind: "inside-vault",
      });
      expect(files(vault)).toEqual(before);
    }
    expect(existsSync(join(vault, "b.json"))).toBe(false);
  });

  it("refuses a path under a symlinked folder that leads into the vault", async () => {
    symlinkSync(vault, join(outside, "link"));
    expect(await refused(join(outside, "link", "b.json"))).toEqual({ kind: "inside-vault" });
    expect(files(vault)).toEqual([]);
  });

  it("sees the vault through a symlink given as its base path", async () => {
    const alias = join(root, "vault-alias");
    symlinkSync(vault, alias);
    expect(await refused(join(vault, "b.json"), alias)).toEqual({ kind: "inside-vault" });
    expect(await refused(join(alias, "b.json"), vault)).toEqual({ kind: "inside-vault" });
  });

  it("refuses a case variant of the vault folder (APFS is case-insensitive) and never writes into it", async () => {
    const variant = join(root, "VAULT", "b.json");
    const result = await writeBundleFile(TEXT, variant, vault);
    expect(files(vault)).toEqual([]);
    if (existsSync(join(root, "VAULT"))) {
      // A case-insensitive volume: the variant IS the vault, so it must be refused as inside it.
      expect(result).toEqual({ kind: "inside-vault" });
    } else {
      // A case-sensitive volume: the folder does not exist, so nothing can be written there.
      expect(result.kind === "inside-vault" || result.kind === "failed").toBe(true);
    }
  });

  it("refuses a relative path, a path that is not .json and a directory-shaped path", async () => {
    expect(await refused("b.json")).toEqual({ kind: "invalid-path" });
    expect(await refused(join(outside, "b.txt"))).toEqual({ kind: "invalid-path" });
    expect(await refused(join(outside, "b"))).toEqual({ kind: "invalid-path" });
    expect(await refused(`${join(outside, "b.json")}/`)).toEqual({ kind: "invalid-path" });
    expect(await refused("")).toEqual({ kind: "invalid-path" });
    expect(await refused(`${join(outside, "b.json")}\0.txt`)).toEqual({ kind: "invalid-path" });
    expect(await refused(`/${"a".repeat(2000)}.json`)).toEqual({ kind: "invalid-path" });
  });

  it("cannot be certain without a vault folder, so it writes nothing", async () => {
    expect(await refused(join(outside, "b.json"), null)).toEqual({ kind: "failed" });
  });

  it("says cancelled and writes nothing when the dialog is dismissed", async () => {
    choose(undefined, true);
    expect(await saveBundle(TEXT, vault, NOW)).toEqual({ kind: "cancelled" });
    expect(files(outside)).toEqual([]);
  });

  it("says unavailable when there is no dialog, and failed when the dialog throws", async () => {
    dialog().showSaveDialog = () => Promise.reject(new Error("boom"));
    expect(await saveBundle(TEXT, vault, NOW)).toEqual({ kind: "failed" });
    // @ts-expect-error test double: simulate a renderer with no showSaveDialog
    dialog().showSaveDialog = undefined;
    expect(await saveBundle(TEXT, vault, NOW)).toEqual({ kind: "unavailable" });
    expect(files(outside)).toEqual([]);
  });

  it("a write that cannot complete is failed, throws nothing and leaves no temporary file", async () => {
    // The target is an existing directory: the final rename cannot replace it.
    mkdirSync(join(outside, "dir.json"));
    expect(await writeBundleFile(TEXT, join(outside, "dir.json"), vault)).toEqual({
      kind: "failed",
    });
    expect(files(outside)).toEqual(["dir.json"]);
    // The parent folder does not exist.
    expect(await writeBundleFile(TEXT, join(outside, "nope", "b.json"), vault)).toEqual({
      kind: "failed",
    });
  });
});

describe("a symlink at the target is replaced, never followed", () => {
  it("leaves the file the link pointed at untouched and puts a real file where the link was", async () => {
    const precious = join(vault, "precious.json");
    writeFileSync(precious, "PRECIOUS");
    const link = join(outside, "b.json");
    symlinkSync(precious, link);
    expect(await writeBundleFile(TEXT, link, vault)).toEqual({ kind: "saved" });
    expect(readFileSync(precious, "utf8")).toBe("PRECIOUS");
    expect(readFileSync(link, "utf8")).toBe(TEXT);
    expect(realpathSync(link)).toBe(join(realpathSync(outside), "b.json"));
    expect(files(vault)).toEqual(["precious.json"]);
  });
});

describe("isInsideVault compares what the file system compares", () => {
  it("is true for the vault, its children and its case, trailing-slash and Unicode variants", () => {
    expect(isInsideVault("/a/Vault", "/a/Vault")).toBe(true);
    expect(isInsideVault("/a/Vault/b.json", "/a/Vault")).toBe(true);
    expect(isInsideVault("/a/Vault/b.json", "/a/Vault/")).toBe(true);
    expect(isInsideVault("/a/VAULT/b.json", "/a/Vault")).toBe(true);
    expect(isInsideVault("/a/vault/x/y/b.json", "/a/Vault")).toBe(true);
    expect(isInsideVault("/a/Café/b.json", "/a/Café")).toBe(true);
    expect(isInsideVault("/a/Café/b.json", "/a/Café")).toBe(true);
  });

  it("is false for a sibling that merely shares a prefix and for unrelated paths", () => {
    expect(isInsideVault("/a/Vault2/b.json", "/a/Vault")).toBe(false);
    expect(isInsideVault("/a/Vault-old/b.json", "/a/Vault")).toBe(false);
    expect(isInsideVault("/a/out/b.json", "/a/Vault")).toBe(false);
    expect(isInsideVault("/a", "/a/Vault")).toBe(false);
  });
});

describe("copyBundle", () => {
  it("passes exactly the text to the clipboard port", async () => {
    const copyText = vi.fn(() => Promise.resolve());
    expect(await copyBundle(TEXT, copyText)).toBe("copied");
    expect(copyText).toHaveBeenCalledWith(TEXT);
  });

  it("reports failed for a refused write, without throwing", async () => {
    expect(await copyBundle(TEXT, () => Promise.reject(new Error("blocked")))).toBe("failed");
  });
});
