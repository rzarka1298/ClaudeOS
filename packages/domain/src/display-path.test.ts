import { describe, expect, it } from "vitest";
import {
  DisplayPathSchema,
  isDisplayPath,
  toBoundedDisplayPath,
  toDisplayPath,
} from "./display-path.js";

const HOME = "/Users/USERNAME";

describe("Task 3 Test 1: toDisplayPath", () => {
  it("abbreviates a path under the home folder to ~/...", () => {
    expect(toDisplayPath("/Users/USERNAME/Obsidian/vault", HOME)).toBe("~/Obsidian/vault");
    expect(toDisplayPath("/Users/USERNAME/.claude-command-center/svc.sock", HOME)).toBe(
      "~/.claude-command-center/svc.sock",
    );
  });

  it("shows the home folder itself as ~", () => {
    expect(toDisplayPath(HOME, HOME)).toBe("~");
  });

  it("is not changed by a trailing slash on either argument", () => {
    const expected = "~/Obsidian/vault";
    expect(toDisplayPath("/Users/USERNAME/Obsidian/vault/", HOME)).toBe(expected);
    expect(toDisplayPath("/Users/USERNAME/Obsidian/vault", `${HOME}/`)).toBe(expected);
    expect(toDisplayPath("/Users/USERNAME/Obsidian/vault//", `${HOME}//`)).toBe(expected);
    expect(toDisplayPath(`${HOME}/`, HOME)).toBe("~");
  });

  it("shows a path outside the home folder as …/<parent>/<name>", () => {
    expect(toDisplayPath("/Volumes/Backup/notes/vault", HOME)).toBe("…/notes/vault");
    expect(toDisplayPath("/opt/tools", HOME)).toBe("…/opt/tools");
    expect(toDisplayPath("/tmp", HOME)).toBe("…/tmp");
  });

  it("does not treat a sibling that shares the home folder's prefix as inside home", () => {
    expect(toDisplayPath("/home/USERNAME2/work/app", "/home/USERNAME")).toBe("…/work/app");
    // The sibling's own name contains the user segment, so it is masked (FIX1A MINOR 2).
    expect(toDisplayPath("/home/USERNAME-archive", "/home/USERNAME")).toBe("…/home/…");
  });

  it("uses the outside rule when the home folder is null, empty or the root", () => {
    expect(toDisplayPath("/Users/USERNAME/Obsidian/vault", null)).toBe("…/Obsidian/vault");
    expect(toDisplayPath("/Users/USERNAME/Obsidian/vault", "")).toBe("…/Obsidian/vault");
    expect(toDisplayPath("/Users/USERNAME/Obsidian/vault", "/")).toBe("…/Obsidian/vault");
  });

  it("returns null for a relative path, an empty string, the root, NUL or a control character", () => {
    for (const bad of [
      "",
      "relative/path",
      "./here",
      "~/already",
      "/",
      "//",
      "/Users/USERNAME/a\u0000b",
      "/Users/USERNAME/a\nb",
      "/Users/USERNAME/a\u007fb",
    ]) {
      expect(toDisplayPath(bad, HOME), JSON.stringify(bad)).toBeNull();
    }
  });

  it("never lets the user segment through an outside-home path", () => {
    expect(toDisplayPath("/Volumes/USERNAME/projects", HOME)).toBe("…/…/projects");
    expect(toDisplayPath("/srv/username", HOME)).toBe("…/srv/…");
  });

  it("masks any segment that CONTAINS the user segment, case-insensitively (FIX1A MINOR 2)", () => {
    expect(toDisplayPath("/Volumes/USERNAME-backup/Vault", HOME)).toBe("…/…/Vault");
    expect(toDisplayPath("/Volumes/Vault/old-username", HOME)).toBe("…/Vault/…");
    expect(toDisplayPath("/Volumes/UserName2024/MyUserNameVault", HOME)).toBe("…/…/…");
    expect(toDisplayPath("/Volumes/Backup/notes", HOME)).toBe("…/Backup/notes");
  });

  it("normalises . and .. before deciding inside or outside (FIX1A MINOR 1)", () => {
    expect(toDisplayPath("/Users/USERNAME/a/../b", HOME)).toBe("~/b");
    expect(toDisplayPath("/Users/USERNAME/./a/./b", HOME)).toBe("~/a/b");
    // Climbing out of home is an outside path, not a ~/.. one.
    expect(toDisplayPath("/Users/USERNAME/../other/x", HOME)).toBe("…/other/x");
    expect(toDisplayPath("/Users/USERNAME/..", HOME)).toBe("…/Users");
    expect(toDisplayPath("/Users/USERNAME/../..", HOME)).toBeNull();
    // Cannot climb above the root.
    expect(toDisplayPath("/../../tmp/x", HOME)).toBe("…/tmp/x");
    expect(toDisplayPath("/a/..", HOME)).toBeNull();
    expect(toDisplayPath("/.", HOME)).toBeNull();
  });

  it("never emits an empty, . or .. segment", () => {
    for (const absolute of [
      "/Users/USERNAME/../../../etc/passwd",
      "/Users//USERNAME///x",
      "/./x/./y/..",
      "/Volumes/../Volumes/../x/y",
    ]) {
      const text = toDisplayPath(absolute, HOME);
      if (text === null) continue;
      expect(DisplayPathSchema.safeParse(text).success, `${absolute} -> ${text}`).toBe(true);
    }
  });
});

/** A small deterministic generator, so the sweep is reproducible without a dependency. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("Task 3 Test 2: property sweep", () => {
  const user = "USERNAME";
  const pool = [
    "Obsidian",
    "vault",
    "work",
    "app",
    user,
    "notes",
    ".config",
    "a b",
    "tmp",
    "x",
    // Segments that merely CONTAIN the user segment (FIX1A MINOR 2).
    `${user}-backup`,
    "old-username",
    `Mine${user}2`,
  ];
  const homes = ["/Users/USERNAME", "/Users/USERNAME/", "/home/USERNAME"];

  it("never returns an absolute path or the home path, and the user segment only after the home prefix", () => {
    const rand = lcg(0x5eed);
    for (let i = 0; i < 600; i += 1) {
      const home = homes[Math.floor(rand() * homes.length)] ?? homes[0] ?? "";
      const homeTrimmed = home.replace(/\/+$/, "");
      const depth = 1 + Math.floor(rand() * 5);
      const segments = Array.from(
        { length: depth },
        () => pool[Math.floor(rand() * pool.length)] ?? "x",
      );
      const inside = rand() < 0.5;
      const absolute = `${inside ? homeTrimmed : "/Volumes/Disk"}/${segments.join("/")}${rand() < 0.3 ? "/" : ""}`;
      const result = toDisplayPath(absolute, home);

      expect(result, absolute).not.toBeNull();
      const text = result ?? "";
      expect(text.startsWith("/"), absolute).toBe(false);
      expect(text.startsWith(inside ? "~/" : "…/"), `${absolute} -> ${text}`).toBe(true);
      expect(text.includes(homeTrimmed), absolute).toBe(false);
      expect(DisplayPathSchema.safeParse(text).success, `${absolute} -> ${text}`).toBe(true);

      const shownSegments = text.split("/");
      if (shownSegments.some((segment) => segment.toLowerCase().includes(user.toLowerCase()))) {
        // Only an inside-home path may keep the user segment (or a longer one holding it), and
        // only from after the prefix.
        expect(inside, absolute).toBe(true);
        expect(
          segments.some((s) => s.toLowerCase().includes(user.toLowerCase())),
          absolute,
        ).toBe(true);
      }
    }
  });
});

describe("Task 3 Test 3: DisplayPathSchema", () => {
  it("accepts ~/x, ~, …/a/b and …/a", () => {
    for (const ok of ["~/x", "~", "~/Obsidian/vault", "…/a/b", "…/a"]) {
      expect(DisplayPathSchema.safeParse(ok).success, ok).toBe(true);
    }
  });

  it("refuses an absolute path, a NUL, a control character, a long string and the wrong shape", () => {
    const bad = [
      "/Users/USERNAME/vault",
      "/",
      "",
      "~/a\u0000b",
      "~/a\nb",
      "…/a\u007fb",
      `~/${"a".repeat(511)}`,
      "relative/path",
      "~user/x",
      "…/",
      "…/a/b/c",
      "http://example.com",
      // Empty, . and .. segments, and a ~// prefix (FIX1A MINOR 1).
      "~//x",
      "~/a//b",
      "~/a/",
      "~/./x",
      "~/../x",
      "~/a/..",
      "~/..",
      "~/.",
      "…/./b",
      "…/../b",
      "…/a/..",
      "…/a/.",
      "…//b",
    ];
    for (const value of bad) {
      expect(DisplayPathSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
    expect(DisplayPathSchema.safeParse(`~/${"a".repeat(510)}`).success).toBe(true);
  });
});

describe("FIX2A F9: toBoundedDisplayPath always answers something the schema accepts, or null", () => {
  it("is toDisplayPath for an ordinary path", () => {
    expect(toBoundedDisplayPath("/Users/USERNAME/Obsidian/vault", HOME)).toBe("~/Obsidian/vault");
    expect(toBoundedDisplayPath("/Volumes/Notes/vault", HOME)).toBe("…/Notes/vault");
    expect(toBoundedDisplayPath("relative/path", HOME)).toBeNull();
  });

  it("keeps the last segment of an over-long path inside home as ~/…/<name>", () => {
    const deep = `/Users/USERNAME/${"d".repeat(300)}/${"e".repeat(300)}/vault`;
    const shown = toBoundedDisplayPath(deep, HOME);
    expect(shown).toBe("~/…/vault");
    expect(isDisplayPath(shown ?? "")).toBe(true);
  });

  it("truncates a 607-character vault folder name to fit the 512-character limit", () => {
    const name = "v".repeat(600);
    const inside = toBoundedDisplayPath(`/Users/USERNAME/${name}`, HOME);
    expect(inside).not.toBeNull();
    expect((inside ?? "").length).toBeLessThanOrEqual(512);
    expect(inside?.startsWith("~/…/v")).toBe(true);
    expect(isDisplayPath(inside ?? "")).toBe(true);

    const outside = toBoundedDisplayPath(`/Volumes/${name}`, HOME);
    expect(outside).not.toBeNull();
    expect((outside ?? "").length).toBeLessThanOrEqual(512);
    expect(outside?.startsWith("…/v")).toBe(true);
    expect(isDisplayPath(outside ?? "")).toBe(true);
    expect(DisplayPathSchema.safeParse(outside).success).toBe(true);
  });

  it("never cuts a surrogate pair in half", () => {
    const name = "😀".repeat(400);
    const shown = toBoundedDisplayPath(`/Users/USERNAME/${name}`, HOME) ?? "";
    expect(shown.length).toBeLessThanOrEqual(512);
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(shown),
    ).toBe(false);
    expect(isDisplayPath(shown)).toBe(true);
  });
});
