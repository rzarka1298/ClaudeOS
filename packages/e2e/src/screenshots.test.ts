import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "./repo-paths.js";
import {
  SHOTS_PREFIX,
  assertShotInside,
  captureRegion,
  createShotsDir,
  deleteShotsDir,
  purgeStaleShotDirs,
  regionArgs,
  shotPath,
} from "./screenshots.js";

let root: string;
let fakeRepo: string;
let fakeHome: string;
let base: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ccc-shots-")));
  fakeRepo = join(root, "repo");
  fakeHome = join(root, "home");
  base = join(root, "scratch");
  for (const dir of [fakeRepo, fakeHome, base, join(fakeHome, "Documents")]) {
    mkdirSync(dir, { recursive: true });
  }
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const mode = (path: string) => statSync(path).mode & 0o777;
const opts = () => ({ repoRoot: fakeRepo, homeDir: fakeHome });

describe("createShotsDir (Test 1)", () => {
  it("makes <base>/ccc-uat-shots-<runId> with mode exactly 0700", () => {
    const dir = createShotsDir({ base, runId: "r1", ...opts() });
    expect(dir).toBe(join(base, `${SHOTS_PREFIX}r1`));
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(mode(dir)).toBe(0o700);
  });

  it("repairs a looser existing mode", () => {
    const existing = join(base, `${SHOTS_PREFIX}r2`);
    mkdirSync(existing, { mode: 0o755 });
    expect(createShotsDir({ base, runId: "r2", ...opts() })).toBe(existing);
    expect(mode(existing)).toBe(0o700);
  });

  it("refuses a base inside the repository or inside the home document folders", () => {
    const inRepo = join(fakeRepo, "tmp");
    mkdirSync(inRepo);
    expect(() => createShotsDir({ base: inRepo, runId: "r", ...opts() })).toThrow(/repository/);
    expect(() => createShotsDir({ base: fakeRepo, runId: "r", ...opts() })).toThrow(/repository/);
    for (const name of ["Documents", "Desktop", "Downloads"]) {
      const folder = join(fakeHome, name, "x");
      mkdirSync(folder, { recursive: true });
      expect(() => createShotsDir({ base: folder, runId: "r", ...opts() })).toThrow(/document/);
    }
    expect(existsSync(join(inRepo, `${SHOTS_PREFIX}r`))).toBe(false);
  });

  it("refuses the real repository root by default and a symlink into it", () => {
    expect(() => createShotsDir({ base: join(REPO_ROOT, "tmp"), runId: "r" })).toThrow(
      /repository/,
    );
    const link = join(root, "link");
    symlinkSync(fakeRepo, link);
    expect(() => createShotsDir({ base: link, runId: "r", ...opts() })).toThrow(/repository/);
  });

  it("refuses a relative base and a run id that is not plain", () => {
    expect(() => createShotsDir({ base: "relative", runId: "r", ...opts() })).toThrow();
    for (const bad of ["", "../x", "a/b", "a b", "x".repeat(80)]) {
      expect(() => createShotsDir({ base, runId: bad, ...opts() })).toThrow();
    }
  });

  it("never returns a path under the real repository with the default base", () => {
    const dir = createShotsDir({ runId: "scan-default" });
    try {
      expect(dir.startsWith(REPO_ROOT)).toBe(false);
      expect(mode(dir)).toBe(0o700);
    } finally {
      deleteShotsDir(dir);
    }
  });
});

describe("shotPath and assertShotInside (Test 2)", () => {
  it("builds <dir>/<NN>-<label>.png with a two-digit item", () => {
    const dir = join(base, `${SHOTS_PREFIX}r`);
    expect(shotPath(dir, 1, "overview-narrow")).toBe(join(dir, "01-overview-narrow.png"));
    expect(shotPath(dir, 22, "x1")).toBe(join(dir, "22-x1.png"));
  });

  it("throws for a bad item or label, with no separators or dots allowed", () => {
    const dir = join(base, `${SHOTS_PREFIX}r`);
    for (const label of ["", "A", "a b", "a/b", "../x", "a.b", "a_b", "x".repeat(70)]) {
      expect(() => shotPath(dir, 1, label), label).toThrow();
    }
    for (const item of [-1, 100, 1.5, Number.NaN]) {
      expect(() => shotPath(dir, item, "ok")).toThrow();
    }
  });

  it("assertShotInside refuses any file outside the folder", () => {
    const dir = join(base, `${SHOTS_PREFIX}r`);
    mkdirSync(dir);
    expect(() => assertShotInside(dir, join(dir, "01-a.png"))).not.toThrow();
    expect(() => assertShotInside(dir, join(base, "01-a.png"))).toThrow();
    expect(() => assertShotInside(dir, join(dir, "..", "01-a.png"))).toThrow();
    expect(() => assertShotInside(dir, dir)).toThrow();
    expect(() => assertShotInside(dir, join(dir, "01-a.txt"))).toThrow();
  });
});

describe("purgeStaleShotDirs (Test 3)", () => {
  it("removes shots folders whose run id is not kept and leaves other entries alone", () => {
    const keep = join(base, `${SHOTS_PREFIX}keep`);
    const stale = join(base, `${SHOTS_PREFIX}old`);
    for (const dir of [keep, stale]) {
      mkdirSync(dir);
      writeFileSync(join(dir, "01-a.png"), "x");
    }
    mkdirSync(join(base, "unrelated"));
    writeFileSync(join(base, `${SHOTS_PREFIX}file`), "a plain file");
    const removed = purgeStaleShotDirs({ base, keepRunIds: ["keep"] });
    expect(removed).toEqual([`${SHOTS_PREFIX}old`]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(keep)).toBe(true);
    expect(existsSync(join(base, "unrelated"))).toBe(true);
    expect(existsSync(join(base, `${SHOTS_PREFIX}file`))).toBe(true);
  });

  it("never follows a symlink out of the base", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "precious.txt"), "keep me");
    symlinkSync(outside, join(base, `${SHOTS_PREFIX}link`));
    const removed = purgeStaleShotDirs({ base, keepRunIds: [] });
    expect(removed).toEqual([`${SHOTS_PREFIX}link`]);
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("keep me");
    expect(existsSync(join(base, `${SHOTS_PREFIX}link`))).toBe(false);
  });

  it("returns an empty list with nothing to purge", () => {
    expect(purgeStaleShotDirs({ base, keepRunIds: [] })).toEqual([]);
    expect(purgeStaleShotDirs({ base: join(root, "missing"), keepRunIds: [] })).toEqual([]);
  });
});

describe("deleteShotsDir (Test 4)", () => {
  it("removes the folder and all images, and is idempotent", () => {
    const dir = createShotsDir({ base, runId: "del", ...opts() });
    writeFileSync(join(dir, "01-a.png"), "x");
    expect(deleteShotsDir(dir)).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(deleteShotsDir(dir)).toBe(false);
  });

  it("refuses a path whose basename does not match the shots prefix", () => {
    const other = join(base, "important");
    mkdirSync(other);
    writeFileSync(join(other, "keep.txt"), "x");
    expect(() => deleteShotsDir(other)).toThrow();
    expect(() => deleteShotsDir(base)).toThrow();
    expect(() => deleteShotsDir(join(base, SHOTS_PREFIX))).toThrow();
    expect(readdirSync(other)).toEqual(["keep.txt"]);
  });
});

describe("regionArgs and captureRegion (Test 5)", () => {
  const rect = { x: 1064, y: 32, w: 440, h: 180 };

  it("builds the quiet region argv with the comma-joined rectangle and the output path", () => {
    expect(regionArgs(rect, "/out/shot.png")).toEqual(["-x", "-R", "1064,32,440,180", "/out/shot.png"]);
    expect(() => regionArgs({ x: 0, y: 0, w: 10000, h: 10000 }, "/o.png")).not.toThrow();
  });

  it("rejects non-integers, negatives, NaN and oversize values", () => {
    for (const bad of [
      { ...rect, x: 1.5 },
      { ...rect, y: -1 },
      { ...rect, w: Number.NaN },
      { ...rect, h: 10001 },
      { ...rect, x: Number.POSITIVE_INFINITY },
    ]) {
      expect(() => regionArgs(bad, "/o.png")).toThrow();
    }
  });

  it("runs the tool through the injected function with that argv, and refuses an outside output", async () => {
    const dir = createShotsDir({ base, runId: "cap", ...opts() });
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const out = shotPath(dir, 1, "banner");
    const result = await captureRegion({
      shotsDir: dir,
      outPath: out,
      rect,
      deps: {
        execFile: async (file, args) => {
          calls.push({ file, args });
        },
      },
    });
    expect(result).toBe(out);
    expect(calls).toEqual([{ file: "/usr/sbin/screencapture", args: ["-x", "-R", "1064,32,440,180", out] }]);

    let ran = false;
    await expect(
      captureRegion({
        shotsDir: dir,
        outPath: join(base, "01-banner.png"),
        rect,
        deps: {
          execFile: async () => {
            ran = true;
          },
        },
      }),
    ).rejects.toThrow();
    expect(ran).toBe(false);
  });
});

describe("never in the repository (Test 6)", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "screenshots.ts"),
    "utf8",
  );

  it("has no write call that mentions the repository root", () => {
    const writes = source
      .split("\n")
      .filter((line) => /mkdirSync|writeFileSync|copyFileSync|renameSync|appendFileSync/.test(line));
    for (const line of writes) expect(line).not.toMatch(/REPO_ROOT|repoRoot/);
    expect(source).not.toMatch(/writeFileSync|copyFileSync|appendFileSync/);
  });

  it("states the privacy rules in its header", () => {
    expect(source).toMatch(/PRIV-04/);
    expect(source).toMatch(/never committed, quoted or attached/);
  });
});
