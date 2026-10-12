import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CliIo, COMMANDS, createRunPorts, main } from "./cli.js";
import { writeLookHandoff } from "./look.js";
import type { PreflightOptions, PreflightPorts } from "./preflight.js";
import { type ReportRow, renderReport } from "./report.js";
import type { RunOptions, RunOutcome, RunPorts } from "./run-uat.js";

const OUTCOME: RunOutcome = {
  exitCode: 0,
  message: "",
  runId: "0123abcd",
  reportPath: null,
  lookPending: [],
  failedItems: [],
};

describe("cli command table (Test 9)", () => {
  it("holds run, preflight, look, report, ratify and lint-tags", () => {
    expect(Object.keys(COMMANDS).sort()).toEqual(
      ["lint-tags", "look", "preflight", "ratify", "report", "run"].sort(),
    );
  });

  it("exits 2 with the usage text for an unknown command or none", async () => {
    const lines: string[] = [];
    expect(await main(["bogus"], { write: (line) => lines.push(line) })).toBe(2);
    expect(lines.join("\n")).toContain("Usage");
    const none: string[] = [];
    expect(await main([], { write: (line) => none.push(line) })).toBe(2);
    expect(none.join("\n")).toContain("Usage");
  });

  it("wires the run handler to runUat with the parsed options and the real ports", async () => {
    const seen: Array<{ options: RunOptions; ports: RunPorts }> = [];
    const ports = createRunPorts();
    const code = await main(["run", "--profile", "full", "--spec", "./specs/a.e2e.ts"], {
      write: () => {},
      createRunPorts: () => ports,
      runUat: async (options, given) => {
        seen.push({ options, ports: given });
        return OUTCOME;
      },
    });
    expect(code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.options.profile).toBe("full");
    expect(seen[0]?.options.specs).toEqual(["./specs/a.e2e.ts"]);
    expect(seen[0]?.ports).toBe(ports);
  });

  it("returns the outcome's exit code and prints its message", async () => {
    const lines: string[] = [];
    const code = await main(["run"], {
      write: (line) => lines.push(line),
      createRunPorts: () => createRunPorts(),
      runUat: async () => ({ ...OUTCOME, exitCode: 2, message: "Refused for a reason." }),
    });
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("Refused for a reason.");
  });

  it("exits 2 on a bad run flag without calling runUat", async () => {
    let called = false;
    const lines: string[] = [];
    const code = await main(["run", "--bogus"], {
      write: (line) => lines.push(line),
      runUat: async () => {
        called = true;
        return OUTCOME;
      },
    });
    expect(code).toBe(2);
    expect(called).toBe(false);
    expect(lines.join("\n")).toContain("--bogus");
  });

  it("prints usage and exits 0 for run --help", async () => {
    const lines: string[] = [];
    expect(await main(["run", "--help"], { write: (line) => lines.push(line) })).toBe(0);
    expect(lines.join("\n")).toContain("--profile");
  });

  it("builds real default ports whose every member is present", () => {
    const ports = createRunPorts();
    for (const name of [
      "missingArtifacts",
      "checkInstalledApp",
      "verifyCache",
      "purgeShots",
      "runSandbox",
      "generateVault",
      "stageGeneratedPlugin",
      "createShots",
      "deleteShots",
      "spawnWdio",
      "readResults",
      "readLookPending",
      "readVersions",
      "readScript",
      "readGitFacts",
      "buildHash",
      "writeReport",
      "handoffLooks",
      "now",
      "log",
    ] as const) {
      expect(typeof ports[name], name).toBe("function");
    }
    expect(ports.platform).toBe(process.platform);
  });
});

const HEAD = "a".repeat(40);

const statusRow = (
  number: number,
  status: "pass" | "fail" | "inconclusive (look pending)",
  runClass: "auto" | "auto+look" = "auto",
): ReportRow => ({
  number,
  title: `Item ${number}`,
  runClass,
  resolution: { kind: "status", item: number, status, reason: "r", message: "" },
});

const OWNER_ROW: ReportRow = {
  number: 2,
  title: "Owner item",
  runClass: "owner",
  resolution: { kind: "owner", item: 2, partials: [] },
};

function reportText(rows: ReportRow[], extra: { gitClean?: boolean } = {}): string {
  return renderReport({
    runId: "0123abcd",
    profile: "standard",
    startedAt: "2026-10-11T10:00:00.000Z",
    finishedAt: "2026-10-11T10:05:00.000Z",
    appVersion: "1.14.4",
    installerVersion: "1.13.7",
    gitHead: HEAD,
    gitClean: extra.gitClean ?? true,
    buildHash: "0123456789ab",
    phasePrefix: "06",
    rows,
  });
}

const SCRIPT = [
  "---",
  "status: testing",
  "phase: 06-demo",
  "---",
  "",
  "## Tests",
  "",
  "### 1. Banner look",
  "run: auto+look",
  "via: spy, shot",
  "spec: packages/e2e/specs/notification-look.e2e.ts::[06-UAT#01]",
  "expected: |",
  "  The banner appears.",
  "result: [pending]",
  "",
  "### 2. Click the banner",
  "run: owner",
  "owner-why: banner-click",
  "expected: |",
  "  Click it.",
  "result: [pending]",
  "",
  "### 3. Deny",
  "run: auto",
  "via: dom, store",
  "spec: packages/e2e/specs/approvals-core.e2e.ts::[06-UAT#03]",
  "expected: |",
  "  Deny.",
  "result: [pending]",
  "",
  "### 4. Approve",
  "run: auto",
  "via: dom",
  "spec: packages/e2e/specs/approvals-core.e2e.ts::[06-UAT#04]",
  "expected: |",
  "  Approve.",
  "result: [pending]",
  "",
  "## Summary",
  "",
  "total: 4",
  "passed: 0",
  "issues: 0",
  "pending: 4",
  "skipped: 0",
  "blocked: 0",
  "",
].join("\n");

function memoryIo(files: Record<string, string>, over: Partial<CliIo> = {}): CliIo {
  return {
    readText: (path) => files[path] ?? null,
    writeText: (path, text) => {
      files[path] = text;
    },
    readGitFacts: async () => ({ head: HEAD, clean: true, changedSince: [] }),
    now: () => new Date("2026-10-12T08:00:00Z"),
    tmpDir: () => "/tmp",
    listFiles: () => [],
    ...over,
  };
}

async function run(argv: string[], io: CliIo): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await main(argv, { write: (line) => lines.push(line), io });
  return { code, out: lines.join("\n") };
}

describe("report command (Test 7)", () => {
  const rows = [
    statusRow(1, "inconclusive (look pending)", "auto+look"),
    OWNER_ROW,
    statusRow(3, "pass"),
    statusRow(4, "fail"),
  ];

  it("writes auto-result lines only for final statuses, never for a look still pending", async () => {
    const files = { "/r/report.md": reportText(rows), "/s/06-UAT.md": SCRIPT };
    const { code, out } = await run(
      [
        "report",
        "--run",
        "0123abcd",
        "--report",
        "/r/report.md",
        "--script",
        "/s/06-UAT.md",
        "--write-script",
      ],
      memoryIo(files),
    );
    expect(code).toBe(0);
    const script = files["/s/06-UAT.md"] as string;
    expect(script).toContain("auto-result: pass @ 0123abcd 2026-10-12");
    expect(script).toContain("auto-result: fail @ 0123abcd 2026-10-12");
    expect(script.match(/^auto-result:/gm)).toHaveLength(2);
    expect(out).toContain("2");
  });

  it("does not write the script without --write-script", async () => {
    const files = { "/r/report.md": reportText(rows), "/s/06-UAT.md": SCRIPT };
    const { code } = await run(
      ["report", "--run", "0123abcd", "--report", "/r/report.md", "--script", "/s/06-UAT.md"],
      memoryIo(files),
    );
    expect(code).toBe(0);
    expect(files["/s/06-UAT.md"]).toBe(SCRIPT);
  });

  it("with no script prints that nothing was written and exits 0", async () => {
    const files = { "/r/report.md": reportText(rows) };
    const { code, out } = await run(
      ["report", "--run", "0123abcd", "--report", "/r/report.md"],
      memoryIo(files),
    );
    expect(code).toBe(0);
    expect(out).toMatch(/nothing was written/i);
  });

  it("refuses a report of another run", async () => {
    const files = { "/r/report.md": reportText(rows), "/s/06-UAT.md": SCRIPT };
    const { code } = await run(
      [
        "report",
        "--run",
        "deadbeef",
        "--report",
        "/r/report.md",
        "--script",
        "/s/06-UAT.md",
        "--write-script",
      ],
      memoryIo(files),
    );
    expect(code).toBe(1);
    expect(files["/s/06-UAT.md"]).toBe(SCRIPT);
  });

  it("exits 2 when --run or --report is missing", async () => {
    expect((await run(["report", "--report", "/r/report.md"], memoryIo({}))).code).toBe(2);
    expect((await run(["report", "--run", "0123abcd"], memoryIo({}))).code).toBe(2);
  });
});

describe("ratify command (Test 8)", () => {
  const allPass = [
    statusRow(1, "pass", "auto+look"),
    OWNER_ROW,
    statusRow(3, "pass"),
    statusRow(4, "pass"),
  ];

  it("requires --run, --statement and --report", async () => {
    const io = memoryIo({});
    expect((await run(["ratify", "--statement", "ok", "--report", "/r"], io)).code).toBe(2);
    expect((await run(["ratify", "--run", "0123abcd", "--report", "/r"], io)).code).toBe(2);
    expect((await run(["ratify", "--run", "0123abcd", "--statement", "ok"], io)).code).toBe(2);
  });

  it("prints the reasons and exits 1 when the run is not ratifiable, changing nothing", async () => {
    const files = { "/r/report.md": reportText([...allPass, statusRow(7, "fail")]) };
    const before = files["/r/report.md"];
    const { code, out } = await run(
      ["ratify", "--run", "0123abcd", "--report", "/r/report.md", "--statement", "ok"],
      memoryIo(files),
    );
    expect(code).toBe(1);
    expect(out).toContain("7");
    expect(files["/r/report.md"]).toBe(before);
  });

  it("on success prints the run id and the date only, and writes the front matter", async () => {
    const files = { "/r/report.md": reportText(allPass) };
    const { code, out } = await run(
      [
        "ratify",
        "--run",
        "0123abcd",
        "--report",
        "/r/report.md",
        "--statement",
        "Owner ratifies it",
      ],
      memoryIo(files),
    );
    expect(code).toBe(0);
    expect(out).toContain("0123abcd");
    expect(out).toContain("2026-10-12");
    expect(out).not.toContain("Owner ratifies it");
    expect(files["/r/report.md"]).toContain("ratified: Owner ratifies it (2026-10-12)");
  });

  it("writes pass - auto run results into the script only with --write-results", async () => {
    const withResults = ["auto-result: pass @ 0123abcd 2026-10-12"];
    const script = SCRIPT.replace(
      "spec: packages/e2e/specs/approvals-core.e2e.ts::[06-UAT#03]",
      `spec: packages/e2e/specs/approvals-core.e2e.ts::[06-UAT#03]\n${withResults[0]}`,
    );
    const files = { "/r/report.md": reportText(allPass), "/s/06-UAT.md": script };
    const base = [
      "ratify",
      "--run",
      "0123abcd",
      "--report",
      "/r/report.md",
      "--statement",
      "ok",
      "--script",
      "/s/06-UAT.md",
    ];
    await run(base, memoryIo(files));
    expect(files["/s/06-UAT.md"]).toBe(script);
    files["/r/report.md"] = reportText(allPass);
    const { code } = await run([...base, "--write-results"], memoryIo(files));
    expect(code).toBe(0);
    expect(files["/s/06-UAT.md"]).toContain("result: pass - auto run 0123abcd");
  });

  it("refuses when the working tree is dirty now, changing nothing", async () => {
    const files = { "/r/report.md": reportText(allPass) };
    const before = files["/r/report.md"];
    const { code, out } = await run(
      ["ratify", "--run", "0123abcd", "--report", "/r/report.md", "--statement", "ok"],
      memoryIo(files, {
        readGitFacts: async () => ({ head: HEAD, clean: false, changedSince: [] }),
      }),
    );
    expect(code).toBe(1);
    expect(out).toMatch(/uncommitted/);
    expect(files["/r/report.md"]).toBe(before);
  });

  it("refuses a dirty-tree run", async () => {
    const files = { "/r/report.md": reportText(allPass, { gitClean: false }) };
    const { code } = await run(
      ["ratify", "--run", "0123abcd", "--report", "/r/report.md", "--statement", "ok"],
      memoryIo(files),
    );
    expect(code).toBe(1);
  });
});

describe("look command", () => {
  it("lists pending items and records a verdict through the shots folder", async () => {
    const base = mkdtempSync(join(tmpdir(), "cli-look-"));
    try {
      const shots = join(base, "ccc-uat-shots-0123abcd");
      mkdirSync(shots, { mode: 0o700 });
      writeFileSync(join(shots, "12-pane.png"), "x");
      const reportPath = join(base, "report.md");
      writeFileSync(
        reportPath,
        reportText([statusRow(12, "inconclusive (look pending)", "auto+look")]),
      );
      writeLookHandoff({
        shotsDir: shots,
        runId: "0123abcd",
        reportPath,
        items: [{ item: 12, labels: ["pane"], count: 1 }],
      });
      const io = memoryIo({}, { tmpDir: () => base });
      const listed = await run(["look", "list", "--run", "0123abcd", "--shots-dir", base], io);
      expect(listed.code).toBe(0);
      expect(listed.out).toContain("12");
      const recorded = await run(
        [
          "look",
          "record",
          "--run",
          "0123abcd",
          "--shots-dir",
          base,
          "--item",
          "12",
          "--verdict",
          "pass",
          "--images",
          "1",
        ],
        io,
      );
      expect(recorded.code).toBe(0);
      expect(existsSync(shots)).toBe(false);
      expect(readFileSync(reportPath, "utf8")).toContain("| pass |");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("exits 2 for an unknown subcommand or a bad verdict", async () => {
    const io = memoryIo({});
    expect((await run(["look", "wander"], io)).code).toBe(2);
    expect(
      (
        await run(
          [
            "look",
            "record",
            "--run",
            "0123abcd",
            "--item",
            "1",
            "--verdict",
            "maybe",
            "--images",
            "1",
          ],
          io,
        )
      ).code,
    ).toBe(2);
  });
});

describe("preflight command", () => {
  const okPorts = {} as unknown as PreflightPorts;

  it("runs runPreflight with the parsed flag and returns 0 when it is ok", async () => {
    const seen: PreflightOptions[] = [];
    const lines: string[] = [];
    const code = await main(["preflight", "--require-real-service"], {
      write: (line) => lines.push(line),
      createPreflightPorts: () => okPorts,
      runPreflight: async (options) => {
        seen.push(options);
        return { ok: true, lines: ["ok: service started"] };
      },
    });
    expect(code).toBe(0);
    expect(seen).toEqual([{ requireRealService: true }]);
    expect(lines.join("\n")).toContain("ok: service started");
  });

  it("returns 1 when the preflight fails and 2 for an unknown flag", async () => {
    const failing = await main(["preflight"], {
      write: () => {},
      createPreflightPorts: () => okPorts,
      runPreflight: async () => ({ ok: false, lines: ["fail: real store or socket changed"] }),
    });
    expect(failing).toBe(1);
    expect(await main(["preflight", "--bogus"], { write: () => {} })).toBe(2);
  });
});

describe("lint-tags command", () => {
  it("requires both --script and --specs-dir", async () => {
    expect((await run(["lint-tags", "--script", "/s"], memoryIo({}))).code).toBe(2);
    expect((await run(["lint-tags", "--specs-dir", "/d"], memoryIo({}))).code).toBe(2);
  });

  it("exits 1 when the script cannot be read, printing a code only", async () => {
    const { code, out } = await run(
      ["lint-tags", "--script", "/s/06-UAT.md", "--specs-dir", "/d"],
      memoryIo({}),
    );
    expect(code).toBe(1);
    expect(out).toContain("SCRIPT_UNREADABLE");
  });
});

describe("cli and scripts stay consistent (Test 5)", () => {
  const read = (relative: string) =>
    JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
    };
  const pkg = read("../package.json").scripts;
  const root = read("../../../package.json").scripts;

  it("maps every package script that runs the CLI to a command in the table", () => {
    for (const [name, command] of Object.entries(pkg)) {
      const match = /^node dist\/cli\.js (\S+)$/.exec(command);
      if (match === null) continue;
      expect(Object.keys(COMMANDS), name).toContain(match[1]);
    }
  });

  it("exposes every command through a one-word script except ratify", () => {
    const exposed = Object.values(pkg)
      .map((command) => /^node dist\/cli\.js (\S+)$/.exec(command)?.[1])
      .filter((command): command is string => command !== undefined);
    for (const command of Object.keys(COMMANDS)) {
      if (command === "ratify") expect(exposed).not.toContain("ratify");
      else expect(exposed, command).toContain(command);
    }
  });

  it("keeps the root uat:auto script unchanged and out of every ci script", () => {
    expect(root["uat:auto"]).toBe("turbo run build && pnpm --filter @ccc/e2e run uat");
    for (const [name, command] of Object.entries(root)) {
      if (name.startsWith("ci:")) expect(command, name).not.toMatch(/uat|e2e/i);
    }
  });
});
