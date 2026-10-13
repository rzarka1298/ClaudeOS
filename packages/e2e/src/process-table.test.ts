import { describe, expect, it, vi } from "vitest";
import { parseProcessTable, readProcessTable } from "./process-table.js";

const SAMPLE = [
  "    1 Sat Oct  3 08:00:00 2026 /sbin/launchd",
  " 4242 Sun Oct 11 10:00:01 2026 node /repo/packages/service/dist/main.js --flag  two",
  "",
  "garbage without a pid",
  "  77 Mon Oct 12 09:05:09 2026 /Applications/Obsidian.app/Contents/MacOS/Obsidian --user-data-dir=/tmp/ccc-uat.abc123/wdio/x",
  " 12 not a start time here",
].join("\n");

describe("parseProcessTable (Test 1)", () => {
  it("turns ps output into pid, start text and the full command line", () => {
    expect(parseProcessTable(SAMPLE)).toEqual([
      { pid: 1, start: "Sat Oct  3 08:00:00 2026", command: "/sbin/launchd" },
      {
        pid: 4242,
        start: "Sun Oct 11 10:00:01 2026",
        command: "node /repo/packages/service/dist/main.js --flag  two",
      },
      {
        pid: 77,
        start: "Mon Oct 12 09:05:09 2026",
        command:
          "/Applications/Obsidian.app/Contents/MacOS/Obsidian --user-data-dir=/tmp/ccc-uat.abc123/wdio/x",
      },
    ]);
  });

  it("returns nothing for empty or malformed output", () => {
    expect(parseProcessTable("")).toEqual([]);
    expect(parseProcessTable("\n\nnot ps output\n")).toEqual([]);
  });
});

describe("readProcessTable (Test 1)", () => {
  it("runs ps through an argv array with a fixed locale and no shell", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: SAMPLE });
    const table = await readProcessTable(exec);
    expect(table).toHaveLength(3);
    expect(exec).toHaveBeenCalledTimes(1);
    const [file, args, options] = exec.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(file).toBe("ps");
    expect(args).toEqual(["-axo", "pid=,lstart=,command="]);
    expect(Array.isArray(args)).toBe(true);
    expect((options.env as Record<string, string>).LC_ALL).toBe("C");
    expect(options.shell).toBeUndefined();
  });
});
