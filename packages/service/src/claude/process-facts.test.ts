import pino from "pino";
import { describe, expect, it } from "vitest";
import { createProcessFacts, type ExecFileRunner, type KillFn } from "./process-facts.js";

interface FakeProcess {
  readonly lstart?: string;
  readonly tty?: string;
  readonly ppid?: number;
  readonly comm?: string;
}

interface ExecCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly timeout: number;
}

/** A fake `/bin/ps` over a fixed process table: answers `-o <fields> -p <pids>`. */
function fakePs(table: Readonly<Record<number, FakeProcess>>): {
  execFile: ExecFileRunner;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const execFile: ExecFileRunner = async (file, args, options) => {
    calls.push({ file, args, env: options.env, timeout: options.timeout });
    const fields = args[args.indexOf("-o") + 1] ?? "";
    const pids = (args[args.indexOf("-p") + 1] ?? "").split(",").map(Number);
    const lines: string[] = [];
    for (const pid of pids) {
      const entry = table[pid];
      if (entry === undefined) continue;
      if (fields === "pid=,lstart=") lines.push(`${String(pid).padStart(5)} ${entry.lstart}`);
      if (fields === "tty=") lines.push(entry.tty ?? "??");
      if (fields === "ppid=,comm=") lines.push(`${String(entry.ppid).padStart(5)} ${entry.comm}`);
    }
    if (lines.length === 0) {
      throw Object.assign(new Error("ps exited 1"), { code: 1 });
    }
    return { stdout: `${lines.join("\n")}\n` };
  };
  return { execFile, calls };
}

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function facts(table: Readonly<Record<number, FakeProcess>>, kill: KillFn = () => {}) {
  const ps = fakePs(table);
  const processFacts = createProcessFacts({
    execFile: ps.execFile,
    kill,
    logger: pino({ level: "silent" }),
  });
  return { processFacts, calls: ps.calls };
}

describe("createProcessFacts (Test 4)", () => {
  it("reads both start times with ONE /bin/ps call, fixed argv, C locale and a timeout", async () => {
    const { processFacts, calls } = facts({
      12: { lstart: "Mon Jul 20 03:25:26 2026" },
      34: { lstart: "Tue Jul 21 11:02:09 2026" },
    });
    const times = await processFacts.readStartTimes([12, 34]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("/bin/ps");
    expect(calls[0]?.args).toEqual(["-o", "pid=,lstart=", "-p", "12,34"]);
    expect(calls[0]?.env).toEqual({ LC_ALL: "C" });
    expect(calls[0]?.timeout).toBe(2000);
    expect(times.get(12)).toBe("Mon Jul 20 03:25:26 2026");
    expect(times.get(34)).toBe("Tue Jul 21 11:02:09 2026");
  });

  it("refuses a non-digit or non-positive pid before any spawn", async () => {
    const { processFacts, calls } = facts({ 12: { lstart: "Mon Jul 20 03:25:26 2026" } });
    expect((await processFacts.readStartTimes([Number.NaN, -1, 0, 1.5])).size).toBe(0);
    expect(await processFacts.readTty(Number.NaN)).toBeNull();
    expect(await processFacts.readAncestry(-5)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("returns an empty map rather than throwing when ps fails", async () => {
    const { processFacts } = facts({});
    await expect(processFacts.readStartTimes([99])).resolves.toEqual(new Map());
  });

  it("maps ESRCH to gone and EPERM to alive, and never signals a non-positive pid", () => {
    const signalled: number[] = [];
    const kill: KillFn = (pid) => {
      signalled.push(pid);
      if (pid === 10) throw errno("ESRCH");
      if (pid === 11) throw errno("EPERM");
    };
    const { processFacts } = facts({}, kill);
    expect(processFacts.isAlive(10)).toBe(false);
    expect(processFacts.isAlive(11)).toBe(true);
    expect(processFacts.isAlive(12)).toBe(true);
    expect(processFacts.isAlive(0)).toBe(false);
    expect(processFacts.isAlive(-1)).toBe(false);
    expect(signalled).toEqual([10, 11, 12]);
  });

  it("follows ppid and comm up the tree and stops at pid 1", async () => {
    const { processFacts, calls } = facts({
      500: { ppid: 400, comm: "claude" },
      400: { ppid: 300, comm: "-zsh" },
      300: { ppid: 1, comm: "login" },
    });
    expect(await processFacts.readAncestry(500)).toEqual([
      { pid: 500, ppid: 400, comm: "claude" },
      { pid: 400, ppid: 300, comm: "-zsh" },
      { pid: 300, ppid: 1, comm: "login" },
    ]);
    expect(calls.every((call) => call.args[1] === "ppid=,comm=")).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it("walks at most 12 levels", async () => {
    const table: Record<number, FakeProcess> = {};
    for (let pid = 100; pid < 140; pid += 1) table[pid] = { ppid: pid + 1, comm: "sh" };
    const { processFacts, calls } = facts(table);
    expect(await processFacts.readAncestry(100)).toHaveLength(12);
    expect(calls).toHaveLength(12);
  });

  it("reads a tty, and null for a process without one", async () => {
    const { processFacts } = facts({ 12: { tty: "ttys021" }, 13: { tty: "??" } });
    expect(await processFacts.readTty(12)).toBe("ttys021");
    expect(await processFacts.readTty(13)).toBeNull();
  });
});
