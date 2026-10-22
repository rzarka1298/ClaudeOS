import { describe, expect, it } from "vitest";
import { DisplayPathSchema, toDisplayPath } from "./display-path.js";

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
    expect(toDisplayPath("/Users/USERNAME2/work/app", HOME)).toBe("…/work/app");
    expect(toDisplayPath("/Users/USERNAME-archive", HOME)).toBe("…/Users/USERNAME-archive");
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
  const pool = ["Obsidian", "vault", "work", "app", user, "notes", ".config", "a b", "tmp", "x"];
  const homes = [`/Users/${user}`, `/Users/${user}/`, `/home/${user}`];

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
      if (shownSegments.some((segment) => segment.toLowerCase() === user.toLowerCase())) {
        // Only an inside-home path may keep the user segment, and only from after the prefix.
        expect(inside, absolute).toBe(true);
        expect(
          segments.some((s) => s === user),
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
    ];
    for (const value of bad) {
      expect(DisplayPathSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
    expect(DisplayPathSchema.safeParse(`~/${"a".repeat(510)}`).success).toBe(true);
  });
});
