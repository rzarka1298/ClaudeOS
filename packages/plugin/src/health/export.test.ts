import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BUNDLE_MAX_BYTES } from "@ccc/domain/diagnostic-bundle.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  remote,
  type SaveDialogOptions,
  type StubWindow,
  saveDialogOptionsOf,
  saveDialogWindowOf,
} from "../test-support/electron-stub.js";
import {
  CONTAINMENT_TIMEOUT_MS,
  defaultBundleFileName,
  type ExportFileSystem,
  isInsideVault,
  nodeExportFileSystem,
  pickSavePath,
  saveBundle,
  saveDialogAvailable,
  writeBundleFile,
} from "./export.js";

/**
 * The export seam (plan 08-16 Task 2; D-12, T-08-41, T-08-42): a typed save dialog, and a write
 * that goes only to an absolute `.json` path outside the open vault, atomically, with mode 0600,
 * never following a symlink, never replacing an existing file (FIX4B m9, D-12a), and that never
 * reports the path it wrote.
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

/** The real file system with some operations replaced: the seam the race tests use. */
function fsWith(patch: Partial<ExportFileSystem>): ExportFileSystem {
  return { ...nodeExportFileSystem, ...patch };
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
  it("opens the dialog with a bare default name and a JSON filter, and asks for no overwrite confirmation", async () => {
    let seen: SaveDialogOptions | undefined;
    dialog().showSaveDialog = (...args) => {
      seen = saveDialogOptionsOf(...args);
      return Promise.resolve({ canceled: false, filePath: join(outside, "b.json") });
    };
    const pick = await pickSavePath({ defaultName: defaultBundleFileName(NOW) });
    expect(pick).toEqual({ kind: "picked", path: join(outside, "b.json") });
    expect(seen?.defaultPath).toBe("claude-command-center-diagnostics-2026-10-22.json");
    expect(seen?.defaultPath).not.toContain("/");
    expect(seen?.filters).toEqual([{ name: "JSON", extensions: ["json"] }]);
    // The save never replaces a file, so the dialog does not offer to (FIX4B m9, D-12a).
    expect(seen?.properties ?? []).not.toContain("showOverwriteConfirmation");
  });

  it("FIX4B m8: passes the current window as the parent when the renderer has one", async () => {
    const win: StubWindow = { stubWindow: true };
    let seenWindow: StubWindow | undefined;
    let seenOptions: SaveDialogOptions | undefined;
    remote.getCurrentWindow = () => win;
    dialog().showSaveDialog = (...args) => {
      seenWindow = saveDialogWindowOf(...args);
      seenOptions = saveDialogOptionsOf(...args);
      return Promise.resolve({ canceled: false, filePath: join(outside, "b.json") });
    };
    try {
      expect(await pickSavePath({ defaultName: "x.json" })).toEqual({
        kind: "picked",
        path: join(outside, "b.json"),
      });
    } finally {
      remote.getCurrentWindow = undefined;
    }
    expect(seenWindow).toBe(win);
    expect(seenOptions?.defaultPath).toBe("x.json");
  });

  it("FIX4B m8: falls back to the options alone when there is no window, or asking for it throws", async () => {
    const calls: number[] = [];
    dialog().showSaveDialog = (...args) => {
      calls.push(args.length);
      return Promise.resolve({ canceled: true });
    };
    remote.getCurrentWindow = undefined;
    expect(await pickSavePath({ defaultName: "x.json" })).toEqual({ kind: "cancelled" });
    remote.getCurrentWindow = () => {
      throw new Error("no window");
    };
    try {
      expect(await pickSavePath({ defaultName: "x.json" })).toEqual({ kind: "cancelled" });
    } finally {
      remote.getCurrentWindow = undefined;
    }
    expect(calls).toEqual([1, 1]);
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

  it("FIX4B m9: never overwrites an existing file: it says exists and leaves the file byte-identical", async () => {
    const target = join(outside, "b.json");
    writeFileSync(target, "old contents", { mode: 0o644 });
    choose(target);
    expect(await saveBundle(TEXT, vault, NOW)).toEqual({ kind: "exists" });
    expect(readFileSync(target, "utf8")).toBe("old contents");
    expect(statSync(target).mode & 0o777).toBe(0o644);
    // No temporary file is left behind either.
    expect(files(outside)).toEqual(["b.json"]);
  });

  it("FIX4B m9: exists is checked at the moment of landing, so a file that appears after the check is kept", async () => {
    const target = join(outside, "b.json");
    const fs = fsWith({
      link: (existing, created) => {
        writeFileSync(created, "arrived late");
        return nodeExportFileSystem.link(existing, created);
      },
    });
    expect(await writeBundleFile(TEXT, target, vault, fs)).toEqual({ kind: "exists" });
    expect(readFileSync(target, "utf8")).toBe("arrived late");
    expect(files(outside)).toEqual(["b.json"]);
  });

  it("FIX4B m9: a directory at the target is exists, not replaced", async () => {
    mkdirSync(join(outside, "dir.json"));
    expect(await writeBundleFile(TEXT, join(outside, "dir.json"), vault)).toEqual({
      kind: "exists",
    });
    expect(files(outside)).toEqual(["dir.json"]);
  });

  it("the file is mode 0600 even under a hostile umask that removes the owner's bits", async () => {
    // With `mode: 0600` alone, umask 0277 would leave 0400: only the explicit chmod restores 0600.
    const previous = process.umask(0o277);
    try {
      const target = join(outside, "umask.json");
      expect(await writeBundleFile(TEXT, target, vault)).toEqual({ kind: "saved" });
      expect(statSync(target).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previous);
    }
    // And a permissive umask cannot widen it: the create mode is 0600 to begin with.
    const wide = process.umask(0o000);
    try {
      const target = join(outside, "wide.json");
      expect(await writeBundleFile(TEXT, target, vault)).toEqual({ kind: "saved" });
      expect(statSync(target).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(wide);
    }
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
    // The parent folder does not exist.
    expect(await writeBundleFile(TEXT, join(outside, "nope", "b.json"), vault)).toEqual({
      kind: "failed",
    });
    // The write fails after the temporary file exists: the temporary file is removed.
    const fs = fsWith({
      open: async (...args) => {
        const handle = await nodeExportFileSystem.open(...args);
        return {
          writeFile: (text, encoding) => handle.writeFile(text, encoding),
          chmod: () => Promise.reject(new Error("disk full")),
          sync: () => handle.sync(),
          stat: (options) => handle.stat(options),
          close: () => handle.close(),
        };
      },
    });
    expect(await writeBundleFile(TEXT, join(outside, "b.json"), vault, fs)).toEqual({
      kind: "failed",
    });
    expect(files(outside)).toEqual([]);
  });
});

describe("FIX4B m7: text over the size cap is refused by the writer and the port on their own", () => {
  const atCap = "x".repeat(BUNDLE_MAX_BYTES);

  it("writes a string of exactly the cap, and refuses one byte more", async () => {
    expect(await writeBundleFile(atCap, join(outside, "cap.json"), vault)).toEqual({
      kind: "saved",
    });
    expect(statSync(join(outside, "cap.json")).size).toBe(BUNDLE_MAX_BYTES);
    expect(await writeBundleFile(`${atCap}x`, join(outside, "over.json"), vault)).toEqual({
      kind: "failed",
    });
    expect(files(outside)).toEqual(["cap.json"]);
  });

  it("counts utf-8 bytes, not characters", async () => {
    const wide = "é".repeat(BUNDLE_MAX_BYTES / 2 + 1);
    expect(wide.length).toBeLessThan(BUNDLE_MAX_BYTES);
    expect(await writeBundleFile(wide, join(outside, "wide.json"), vault)).toEqual({
      kind: "failed",
    });
    expect(files(outside)).toEqual([]);
  });

  it("the port refuses before it even opens the dialog", async () => {
    let opened = 0;
    dialog().showSaveDialog = () => {
      opened += 1;
      return Promise.resolve({ canceled: false, filePath: join(outside, "b.json") });
    };
    expect(await saveBundle(`${atCap}x`, vault, NOW)).toEqual({ kind: "failed" });
    expect(opened).toBe(0);
    expect(files(outside)).toEqual([]);
  });
});

describe("FIX4B M1: containment is judged by identity, so a firmlink spelling of the vault is still the vault", () => {
  const FIRMLINK_ROOT = "/System/Volumes/Data";

  it("refuses the same folder reached through /System/Volumes/Data, and writes nothing into the vault", async () => {
    const alias = `${FIRMLINK_ROOT}${realpathSync(vault)}`;
    if (!existsSync(alias)) return; // Not macOS (or no firmlink for this folder): nothing to prove.
    // The firmlink spelling passes a text comparison, which is the point of the identity check.
    expect(isInsideVault(join(alias, "x.json"), vault)).toBe(false);
    expect(isInsideVault(join(alias, "x.json"), realpathSync(vault))).toBe(false);
    expect(await writeBundleFile(TEXT, join(alias, "x.json"), vault)).toEqual({
      kind: "inside-vault",
    });
    expect(files(vault)).toEqual([]);
  });

  it("refuses a nested folder under the vault reached through the firmlink", async () => {
    mkdirSync(join(vault, "sub"));
    const alias = `${FIRMLINK_ROOT}${realpathSync(join(vault, "sub"))}`;
    if (!existsSync(alias)) return;
    expect(await writeBundleFile(TEXT, join(alias, "x.json"), vault)).toEqual({
      kind: "inside-vault",
    });
    expect(files(join(vault, "sub"))).toEqual([]);
  });

  it("refuses a symlink to a folder nested under the vault", async () => {
    // The link resolves to a folder inside the vault.
    const nested = join(vault, "deep", "er");
    mkdirSync(nested, { recursive: true });
    const viaLink = join(root, "alias-to-deeper");
    symlinkSync(nested, viaLink);
    expect(await writeBundleFile(TEXT, join(viaLink, "x.json"), vault)).toEqual({
      kind: "inside-vault",
    });
    expect(files(nested)).toEqual([]);
  });

  it("an outside folder that merely shares ancestors with the vault is still allowed", async () => {
    expect(await writeBundleFile(TEXT, join(outside, "ok.json"), vault)).toEqual({
      kind: "saved",
    });
  });
});

describe("FIX4B m1: the parent folder swapped between the check and the write", () => {
  /** Moves the real folder away and leaves a link into the vault where it was. */
  function swapParentForVaultLink(): string {
    const moved = join(root, "out-moved");
    renameSync(outside, moved);
    symlinkSync(vault, outside);
    return moved;
  }

  it("a swap before the file is created lands nothing in the vault", async () => {
    let moved = "";
    let links = 0;
    const fs = fsWith({
      open: (...args) => {
        if (moved === "") moved = swapParentForVaultLink();
        return nodeExportFileSystem.open(...args);
      },
      link: (existing, created) => {
        links += 1;
        return nodeExportFileSystem.link(existing, created);
      },
    });
    expect(await writeBundleFile(TEXT, join(outside, "b.json"), vault, fs)).toEqual({
      kind: "failed",
    });
    expect(moved).not.toBe("");
    // The check before landing caught it: the file never even got its final name.
    expect(links).toBe(0);
    expect(files(vault)).toEqual([]);
    expect(files(moved)).toEqual([]);
  });

  it("a swap at the moment of landing is undone: the landed file and the temporary are removed", async () => {
    let moved = "";
    const fs = fsWith({
      link: (existing, created) => {
        if (moved === "") {
          moved = swapParentForVaultLink();
          // The attacker also puts a copy of the temporary file where the link will land.
          linkSync(join(moved, basename(existing)), existing);
        }
        return nodeExportFileSystem.link(existing, created);
      },
    });
    expect(await writeBundleFile(TEXT, join(outside, "b.json"), vault, fs)).toEqual({
      kind: "failed",
    });
    expect(moved).not.toBe("");
    expect(files(vault)).toEqual([]);
  });

  it("an unchanged parent is saved as usual (the check does not misfire)", async () => {
    expect(await writeBundleFile(TEXT, join(outside, "b.json"), vault)).toEqual({ kind: "saved" });
    expect(files(outside)).toEqual(["b.json"]);
  });
});

describe("FIX6B: a location that cannot hold the bundle safely, and a walk that does not return", () => {
  function linkFailing(code: string): ExportFileSystem {
    return fsWith({
      link: () => Promise.reject(Object.assign(new Error("no hard links here"), { code })),
    });
  }

  it.each(["EPERM", "ENOTSUP", "EXDEV"])(
    "link(2) failing with %s is unsupported-location: nothing is written and the temporary file is removed",
    async (code) => {
      const result = await writeBundleFile(TEXT, join(outside, "b.json"), vault, linkFailing(code));
      expect(result).toEqual({ kind: "unsupported-location" });
      expect(files(outside)).toEqual([]);
    },
  );

  it("never falls back to a write that could replace: the target is not created by any other route", async () => {
    const result = await writeBundleFile(
      TEXT,
      join(outside, "b.json"),
      vault,
      linkFailing("EPERM"),
    );
    expect(result.kind).toBe("unsupported-location");
    expect(files(outside)).not.toContain("b.json");
  });

  it("any other link failure is still failed, and EEXIST is still exists", async () => {
    expect(await writeBundleFile(TEXT, join(outside, "b.json"), vault, linkFailing("EIO"))).toEqual(
      {
        kind: "failed",
      },
    );
    expect(
      await writeBundleFile(TEXT, join(outside, "c.json"), vault, linkFailing("EEXIST")),
    ).toEqual({ kind: "exists" });
    expect(files(outside)).toEqual([]);
  });

  it("an identity walk that never returns is failed within the bound, and nothing is written", async () => {
    const hung = fsWith({ stat: () => new Promise<never>(() => {}) });
    const started = Date.now();
    const result = await writeBundleFile(TEXT, join(outside, "b.json"), vault, hung, {
      containmentTimeoutMs: 30,
    });
    expect(result).toEqual({ kind: "failed" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(files(outside)).toEqual([]);
  });

  it("a realpath that never returns is failed too", async () => {
    const hung = fsWith({ realpath: () => new Promise<never>(() => {}) });
    expect(
      await writeBundleFile(TEXT, join(outside, "b.json"), vault, hung, {
        containmentTimeoutMs: 30,
      }),
    ).toEqual({ kind: "failed" });
    expect(files(outside)).toEqual([]);
  });

  it("the re-check of the parent after the file was created is bounded as well, and the temporary is removed", async () => {
    let folderStats = 0;
    const fs = fsWith({
      stat: (path) => {
        if (path.endsWith(".tmp")) return nodeExportFileSystem.stat(path);
        folderStats += 1;
        // The first walk (vault, its realpath, the parent and its ancestors) answers; later ones hang.
        return folderStats > 40 ? new Promise<never>(() => {}) : nodeExportFileSystem.stat(path);
      },
      open: (path, flags, mode) => {
        // From here on every folder stat hangs.
        folderStats = 100;
        return nodeExportFileSystem.open(path, flags, mode);
      },
    });
    const result = await writeBundleFile(TEXT, join(outside, "b.json"), vault, fs, {
      containmentTimeoutMs: 30,
    });
    expect(result).toEqual({ kind: "failed" });
    expect(files(outside)).toEqual([]);
  });

  it("the default bound is a few seconds, not unbounded", () => {
    expect(CONTAINMENT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(CONTAINMENT_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });
});

describe("FIX4B m9: a symlink at the target is refused, never followed or replaced", () => {
  it("says exists and leaves the pointee and the link untouched", async () => {
    const precious = join(vault, "precious.json");
    writeFileSync(precious, "PRECIOUS");
    const link = join(outside, "b.json");
    symlinkSync(precious, link);
    expect(await writeBundleFile(TEXT, link, vault)).toEqual({ kind: "exists" });
    expect(readFileSync(precious, "utf8")).toBe("PRECIOUS");
    // Still a symlink to the same file; nothing was written through it.
    expect(realpathSync(link)).toBe(realpathSync(precious));
    expect(files(vault)).toEqual(["precious.json"]);
    expect(files(outside)).toEqual(["b.json"]);
  });

  it("a dangling symlink is refused too, and its missing pointee is not created", async () => {
    const missing = join(outside, "not-there.json");
    const link = join(outside, "b.json");
    symlinkSync(missing, link);
    expect(await writeBundleFile(TEXT, link, vault)).toEqual({ kind: "exists" });
    expect(existsSync(missing)).toBe(false);
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
