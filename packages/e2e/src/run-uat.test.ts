import { describe, expect, it } from "vitest";
import type { ResultRecord } from "./results.js";
import { pathsForRoot } from "./run-root.js";
import {
  type LookHandoff,
  type LookPendingItem,
  parseLookPendingLines,
  type RunOptions,
  type RunPorts,
  runUat,
} from "./run-uat.js";
import type { SandboxHandle, SandboxOutcome } from "./sandbox.js";
import { ratifyReport } from "./ratify.js";
import { SPIKE_DECISIONS } from "./spike-decisions.js";
import type { SpecTitle } from "./tag-lint.js";
import { parseUatScript } from "./uat-tags.js";

const ROOT = "/tmp/ccc-uat.test01";
const RUN_ID = "0123abcd";
const paths = pathsForRoot(ROOT, RUN_ID);
const HEAD = "a".repeat(40);

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
  "auto-part: the retained handler opens Approvals",
  "expected: |",
  "  Click the banner.",
  "result: [pending]",
  "",
  "### 5. Deny",
  "run: auto",
  "via: dom, store",
  "spec: packages/e2e/specs/approvals-core.e2e.ts::[06-UAT#05]",
  "expected: |",
  "  Deny the request.",
  "result: [pending]",
  "",
  "### 7. Approve",
  "run: auto",
  "via: dom",
  "spec: packages/e2e/specs/approvals-core.e2e.ts::[06-UAT#07]",
  "expected: |",
  "  Approve once.",
  "result: [pending]",
  "",
  "### 21. Ten thousand tasks",
  "run: auto",
  "via: dom, proc",
  "spec: packages/e2e/specs/tasks-scale.e2e.ts::[06-UAT#21]",
  "expected: |",
  "  Stays responsive.",
  "result: [pending]",
  "",
  "## Summary",
  "",
  "total: 5",
  "",
].join("\n");

const record = (title: string, state: ResultRecord["state"]): ResultRecord => ({
  title,
  state,
  durationMs: 5,
  message: state === "failed" ? "boom" : "",
});

// No expectations by default; the tests that exercise them pass their own titles.
const DEFAULT_TITLES: SpecTitle[] = [];

const GOOD_RESULTS: ResultRecord[] = [
  record("[06-UAT#01] banner appears", "passed"),
  record("[06-UAT#02] click handler part", "passed"),
  record("[06-UAT#05] deny", "passed"),
];

interface Harness {
  ports: RunPorts;
  calls: string[];
  reports: Array<{ path: string | null; text: string }>;
  handoffs: LookHandoff[];
  deleted: string[];
  wdioInputs: Array<{ wdioEnv: Record<string, string>; extraArgs: string[] }>;
}

function harness(
  over: Partial<RunPorts> = {},
  setup: {
    results?: ResultRecord[];
    script?: string | null;
    looks?: LookPendingItem[];
    leaks?: number;
    cleanupErrors?: number;
    titles?: SpecTitle[];
  } = {},
): Harness {
  const calls: string[] = [];
  const reports: Harness["reports"] = [];
  const handoffs: LookHandoff[] = [];
  const deleted: string[] = [];
  const wdioInputs: Harness["wdioInputs"] = [];
  const sandbox = {
    paths,
    runId: RUN_ID,
    account: `ccc-uat-${RUN_ID}`,
  } as unknown as SandboxHandle;
  const ports: RunPorts = {
    env: {},
    platform: "darwin",
    decisions: SPIKE_DECISIONS,
    homeDir: "/Users/USERNAME",
    now: () => new Date("2026-10-11T10:00:00Z"),
    log: () => {},
    missingArtifacts: () => {
      calls.push("checks");
      return [];
    },
    checkInstalledApp: () => {
      calls.push("installed-app");
    },
    verifyCache: () => {
      calls.push("verify-cache");
      return { ok: true, note: "checksum matches" };
    },
    purgeShots: () => {
      calls.push("purge-shots");
    },
    runSandbox: async <T>(body: (box: SandboxHandle) => Promise<T>) => {
      calls.push("sandbox-start");
      let value: T | undefined;
      let error: unknown;
      let failed = false;
      try {
        value = await body(sandbox);
      } catch (err) {
        failed = true;
        error = err;
      }
      calls.push("teardown", "delete-account", "leak-check");
      const leaks = Array.from({ length: setup.leaks ?? 0 }, (_unused, index) => ({
        pid: 900 + index,
      }));
      return {
        ok: !failed && leaks.length === 0,
        value,
        error,
        leaks,
        cleanupErrors: Array.from({ length: setup.cleanupErrors ?? 0 }, () => new Error("cleanup")),
        runId: RUN_ID,
        runRoot: ROOT,
        runRootRemoved: leaks.length === 0,
        sweep: { status: "clean" },
      } as unknown as SandboxOutcome<T>;
    },
    generateVault: async (_box, kind) => {
      calls.push(`vault-${kind}`);
    },
    stageGeneratedPlugin: () => {
      calls.push("stage-plugin");
    },
    createShots: () => {
      calls.push("create-shots");
      return "/tmp/ccc-uat-shots-0123abcd";
    },
    deleteShots: (dir) => {
      deleted.push(dir);
    },
    spawnWdio: async (input) => {
      calls.push("wdio");
      wdioInputs.push({ wdioEnv: input.wdioEnv, extraArgs: input.extraArgs });
      return { exitCode: 0, signal: null };
    },
    readSpecTitles: () => {
      calls.push("read-spec-titles");
      return setup.titles ?? DEFAULT_TITLES;
    },
    readResults: () => {
      calls.push("read-results");
      return setup.results ?? GOOD_RESULTS;
    },
    readLookPending: () => {
      calls.push("read-look-pending");
      return setup.looks ?? [{ item: 1, labels: ["pane", "settings"], count: 2 }];
    },
    readVersions: () => ({ app: "1.14.4", installer: "1.13.7", mismatches: [] }),
    readScript: () => {
      calls.push("read-script");
      return setup.script === undefined ? SCRIPT : setup.script;
    },
    readGitFacts: async () => ({ head: HEAD, clean: true, changedSince: null }),
    buildHash: () => "0123456789ab",
    writeReport: (path, text) => {
      calls.push("write-report");
      reports.push({ path, text });
    },
    handoffLooks: (input) => {
      calls.push("handoff");
      handoffs.push(input);
    },
    ...over,
  };
  return { ports, calls, reports, handoffs, deleted, wdioInputs };
}

const options = (over: Partial<RunOptions> = {}): RunOptions => ({
  profile: "standard",
  script: "/work/06-UAT.md",
  phaseDir: "/work/phase",
  specs: [],
  ...over,
});

describe("runUat refusals (Test 2)", () => {
  it("returns usage-error under CI and starts nothing", async () => {
    const h = harness({ env: { CI: "true" } });
    const outcome = await runUat(options(), h.ports);
    expect(outcome.exitCode).toBe(2);
    expect(h.calls).not.toContain("sandbox-start");
    expect(h.calls).not.toContain("wdio");
  });

  it("refuses a non-macOS platform", async () => {
    const h = harness({ platform: "linux" });
    const outcome = await runUat(options(), h.ports);
    expect(outcome.exitCode).toBe(2);
    expect(h.calls).not.toContain("sandbox-start");
  });

  it("refuses a missing build artifact, naming the build command and no path", async () => {
    const h = harness({ missingArtifacts: () => ["/repo/packages/service/dist/main.js"] });
    const outcome = await runUat(options(), h.ports);
    expect(outcome.exitCode).toBe(2);
    expect(outcome.message).toContain("turbo run build");
    expect(outcome.message).not.toContain("/repo");
    expect(h.calls).not.toContain("sandbox-start");
  });

  it("refuses a cache checksum mismatch", async () => {
    const h = harness({ verifyCache: () => ({ ok: false, note: "checksum differs" }) });
    const outcome = await runUat(options(), h.ports);
    expect(outcome.exitCode).toBe(2);
    expect(h.calls).not.toContain("sandbox-start");
  });

  it("refuses version decisions that are not recorded", async () => {
    const h = harness({ decisions: { ...SPIKE_DECISIONS, status: "provisional" } });
    const outcome = await runUat(options(), h.ports);
    expect(outcome.exitCode).toBe(2);
    expect(h.calls).not.toContain("sandbox-start");
  });

  it("refuses an installed app that differs from the decision", async () => {
    const h = harness({
      checkInstalledApp: () => {
        throw new Error(
          "Installed Obsidian installer is 1.2.3 but the recorded decision is 1.13.7.",
        );
      },
    });
    const outcome = await runUat(options(), h.ports);
    expect(outcome.exitCode).toBe(2);
    expect(h.calls).not.toContain("sandbox-start");
  });
});

describe("runUat order (Test 3)", () => {
  it("runs the standard profile in the fixed order and never builds the big vault", async () => {
    const h = harness();
    await runUat(options(), h.ports);
    const order = h.calls.filter(
      (call) => call !== "installed-app" && call !== "read-script" && call !== "read-spec-titles",
    );
    expect(order).toEqual([
      "checks",
      "verify-cache",
      "purge-shots",
      "sandbox-start",
      "vault-live",
      "stage-plugin",
      "create-shots",
      "wdio",
      "read-results",
      "read-look-pending",
      "write-report",
      "handoff",
      "teardown",
      "delete-account",
      "leak-check",
    ]);
    expect(h.calls).not.toContain("vault-big");
  });

  it("builds both vaults in the full profile and passes the big vault to wdio", async () => {
    const h = harness();
    await runUat(options({ profile: "full" }), h.ports);
    expect(h.calls.filter((call) => call.startsWith("vault-"))).toEqual([
      "vault-live",
      "vault-big",
    ]);
    expect(h.wdioInputs[0]?.wdioEnv.CCC_UAT_VAULT_BIG).toBe(`${ROOT}/vaults/big`);
  });

  it("gives wdio the sandbox environment, the shots folder and the --spec filters", async () => {
    const h = harness();
    await runUat(options({ specs: ["./specs/a.e2e.ts"] }), h.ports);
    const input = h.wdioInputs[0];
    expect(input?.wdioEnv.CCC_UAT_RUN_ROOT).toBe(ROOT);
    expect(input?.wdioEnv.CCC_UAT_SHOTS_DIR).toBe("/tmp/ccc-uat-shots-0123abcd");
    expect(input?.wdioEnv.CCC_UAT_PROFILE).toBe("standard");
    expect(input?.wdioEnv.CCC_SOCKET_PATH).toBe(paths.socketPath);
    expect(input?.extraArgs).toEqual(["--spec", "./specs/a.e2e.ts"]);
  });
});

describe("runUat failure still tears down (Test 4)", () => {
  it("tears down and exits 1 when wdio rejects", async () => {
    const h = harness({
      spawnWdio: async () => {
        throw new Error("spawn failed");
      },
    });
    const outcome = await runUat(options(), h.ports);
    expect(outcome.exitCode).toBe(1);
    expect(h.calls).toEqual(expect.arrayContaining(["teardown", "delete-account", "leak-check"]));
  });

  it("tears down and exits 1 on a non-zero wdio exit", async () => {
    const h = harness({ spawnWdio: async () => ({ exitCode: 1, signal: null }) });
    const outcome = await runUat(options(), h.ports);
    expect(outcome.exitCode).toBe(1);
    expect(h.calls).toContain("teardown");
    expect(h.calls).toContain("write-report");
  });

  it("tears down and exits 1 when the report write throws, and deletes the shots folder", async () => {
    const h = harness({
      writeReport: () => {
        throw new Error("disk full");
      },
    });
    const outcome = await runUat(options(), h.ports);
    expect(outcome.exitCode).toBe(1);
    expect(h.calls).toEqual(expect.arrayContaining(["teardown", "delete-account", "leak-check"]));
    expect(h.deleted).toEqual(["/tmp/ccc-uat-shots-0123abcd"]);
  });

  it("exits 1 when the leak check finds a leak", async () => {
    const h = harness({}, { leaks: 1 });
    const outcome = await runUat(options(), h.ports);
    expect(outcome.exitCode).toBe(1);
  });

  it("turns a sandbox that refuses to start into a usage error", async () => {
    const h = harness({
      runSandbox: async () => {
        throw new Error("Another UAT run is active; wait for it to finish or stop it first.");
      },
    });
    const outcome = await runUat(options(), h.ports);
    expect(outcome.exitCode).toBe(2);
  });
});

describe("runUat statuses to report (Test 5)", () => {
  it("writes pass, fail, look pending, skipped-profile and owner partials", async () => {
    const h = harness();
    const outcome = await runUat(options(), h.ports);
    const text = h.reports[0]?.text ?? "";
    const row = (item: number) => text.split("\n").find((line) => line.startsWith(`| ${item} |`));
    expect(row(5)).toContain("| pass |");
    expect(row(7)).toContain("| fail |");
    expect(row(1)).toContain("| inconclusive (look pending) |");
    expect(row(21)).toContain("| skipped-profile |");
    expect(row(2)).toContain("| owner |");
    expect(text).toContain("click handler part");
    expect(text).toContain(`run-id: ${RUN_ID}`);
    expect(text).toContain("profile: standard");
    expect(text).toContain("app-version: 1.14.4");
    expect(text).toContain("installer-version: 1.13.7");
    expect(text).toContain("build-hash: 0123456789ab");
    expect(text).toContain("ratified: pending");
    expect(outcome.failedItems).toEqual([7]);
    expect(outcome.exitCode).toBe(1);
    expect(h.reports[0]?.path).toBe("/work/phase/06-UAT-AUTO-REPORT.md");
  });

  it("hands the look runner exactly the items awaiting a verdict with their image counts", async () => {
    const h = harness();
    const outcome = await runUat(options(), h.ports);
    expect(h.handoffs).toEqual([
      {
        shotsDir: "/tmp/ccc-uat-shots-0123abcd",
        runId: RUN_ID,
        reportPath: "/work/phase/06-UAT-AUTO-REPORT.md",
        items: [{ item: 1, labels: ["pane", "settings"], count: 2 }],
      },
    ]);
    expect(outcome.lookPending).toEqual([{ item: 1, labels: ["pane", "settings"], count: 2 }]);
  });

  it("completes with exit 0 when every automated item passed and only a look is pending", async () => {
    const h = harness(
      {},
      {
        results: [
          record("[06-UAT#01] banner", "passed"),
          record("[06-UAT#05] deny", "passed"),
          record("[06-UAT#07] approve", "passed"),
        ],
      },
    );
    const outcome = await runUat(options(), h.ports);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.failedItems).toEqual([]);
  });

  it("reports a look item with no recorded images as pending with a zero count", async () => {
    const h = harness({}, { looks: [] });
    await runUat(options(), h.ports);
    expect(h.handoffs[0]?.items).toEqual([{ item: 1, labels: [], count: 0 }]);
  });

  it("hands over an empty list (so the shots folder is deleted) when no look is pending", async () => {
    const h = harness(
      {},
      {
        script: SCRIPT.replace("run: auto+look", "run: auto"),
        results: [
          record("[06-UAT#01] banner", "passed"),
          record("[06-UAT#05] deny", "passed"),
          record("[06-UAT#07] approve", "passed"),
        ],
      },
    );
    await runUat(options(), h.ports);
    expect(h.handoffs[0]?.items).toEqual([]);
  });

  it("marks a version mismatch in the report front matter and exits 1", async () => {
    const h = harness({
      readVersions: () => ({
        app: "1.2.3",
        installer: "1.13.7",
        mismatches: ["app-differs-from-decision"],
      }),
    });
    const outcome = await runUat(options(), h.ports);
    expect(outcome.exitCode).toBe(1);
    expect(h.reports[0]?.text).toContain("version-mismatch: app-differs-from-decision");
  });
});

describe("runUat expected titles (Wave 2 fix: a missing test cannot pass)", () => {
  const titles = (...names: string[]): SpecTitle[] =>
    names.map((title) => ({
      file: "packages/e2e/specs/approvals-core.e2e.ts",
      title,
      only: false,
    }));

  it("marks an item inconclusive when one of its spec tests left no record, and exits 1", async () => {
    const h = harness(
      {},
      {
        results: [
          record("[06-UAT#01] banner", "passed"),
          record("[06-UAT#05] deny", "passed"),
          record("[06-UAT#07] approve", "passed"),
        ],
        titles: titles(
          "[06-UAT#01] banner",
          "[06-UAT#05] deny",
          "[06-UAT#05] deny again",
          "[06-UAT#07] approve",
        ),
      },
    );
    const outcome = await runUat(options(), h.ports);
    const row = (item: number) =>
      (h.reports[0]?.text ?? "").split("\n").find((line) => line.startsWith(`| ${item} |`));
    expect(row(5)).toContain("| inconclusive |");
    expect(row(5)).toContain("1 of 2 expected tests recorded");
    expect(outcome.exitCode).toBe(1);
    expect(outcome.failedItems).toEqual([5]);
  });

  it("passes the item when every expected title has a record", async () => {
    const h = harness(
      {},
      {
        results: [
          record("[06-UAT#01] banner", "passed"),
          record("[06-UAT#05] deny", "passed"),
          record("[06-UAT#05] deny again", "passed"),
          record("[06-UAT#07] approve", "passed"),
        ],
        titles: titles(
          "[06-UAT#01] banner",
          "[06-UAT#05] deny",
          "[06-UAT#05] deny again",
          "[06-UAT#07] approve",
        ),
      },
    );
    const outcome = await runUat(options(), h.ports);
    expect(outcome.failedItems).toEqual([]);
    expect(outcome.exitCode).toBe(0);
  });

  it("reads the spec titles with the script's phase prefix", async () => {
    const seen: string[] = [];
    const h = harness({
      readSpecTitles: (prefix) => {
        seen.push(prefix);
        return [];
      },
    });
    await runUat(options(), h.ports);
    expect(seen).toEqual(["06"]);
  });
});

describe("runUat without a tagged script (Test 6)", () => {
  it("still completes, lists tests by title and state, and notes the mapping as unavailable", async () => {
    const h = harness({}, { script: null, results: GOOD_RESULTS });
    const outcome = await runUat(options({ script: undefined, phaseDir: undefined }), h.ports);
    const text = h.reports[0]?.text ?? "";
    expect(outcome.exitCode).toBe(0);
    expect(text).toContain("[06-UAT#05] deny");
    expect(text).toContain("item-mapping: unavailable");
    expect(h.reports[0]?.path).toBeNull();
    expect(h.handoffs[0]?.items).toEqual([]);
  });

  it("derives the exit code only from wdio and leaks when there is no script", async () => {
    const failing = harness(
      { spawnWdio: async () => ({ exitCode: 1, signal: null }) },
      { script: null, results: [record("[06-UAT#05] deny", "failed")] },
    );
    expect((await runUat(options({ script: undefined }), failing.ports)).exitCode).toBe(1);
    const green = harness({}, { script: null, results: [record("[06-UAT#05] deny", "failed")] });
    expect((await runUat(options({ script: undefined }), green.ports)).exitCode).toBe(0);
  });
});

describe("parseLookPendingLines", () => {
  it("groups labels per item, drops repeats and counts them", () => {
    const text = [
      JSON.stringify({ item: 12, labels: ["a", "b"] }),
      JSON.stringify({ item: 12, labels: ["b", "c"], count: 2 }),
      JSON.stringify({ item: 1, labels: ["x"] }),
      "",
    ].join("\n");
    expect(parseLookPendingLines(text)).toEqual([
      { item: 1, labels: ["x"], count: 1 },
      { item: 12, labels: ["a", "b", "c"], count: 3 },
    ]);
  });

  it("ignores a torn last line and refuses a malformed earlier one", () => {
    expect(parseLookPendingLines('{"item":3,"labels":["a"]}\n{"item":')).toEqual([
      { item: 3, labels: ["a"], count: 1 },
    ]);
    expect(() => parseLookPendingLines('nonsense\n{"item":3,"labels":["a"]}\n')).toThrow();
  });
});

describe("the synthetic script used above", () => {
  it("parses with five items and no findings", () => {
    const parsed = parseUatScript(SCRIPT);
    expect(parsed.items.map((item) => item.number)).toEqual([1, 2, 5, 7, 21]);
    expect(parsed.findings).toEqual([]);
  });
});

describe("runUat records run problems in the report (Wave 3 WR-01)", () => {
  const ratifyInput = {
    runId: RUN_ID,
    statement: "owner statement",
    date: "2026-10-12",
    currentHead: HEAD,
    changedFiles: [] as string[],
    currentClean: true,
  };
  const allPass: ResultRecord[] = [
    record("[06-UAT#05] deny", "passed"),
    record("[06-UAT#02] click handler part", "passed"),
  ];
  const lastReport = (h: Harness): string => h.reports[h.reports.length - 1]?.text ?? "";
  const refusalReasons = (text: string): string[] => {
    const result = ratifyReport(text, ratifyInput);
    return result.ok ? [] : result.reasons;
  };

  it("a wdio failure after every row passed leaves a report that ratify refuses", async () => {
    const h = harness(
      { spawnWdio: async () => ({ exitCode: 1, signal: null }) },
      { results: allPass, looks: [] },
    );
    await runUat(options(), h.ports);
    expect(lastReport(h)).toContain("run-problems: wdio-failed");
    expect(refusalReasons(lastReport(h)).some((reason) => /recorded problems/.test(reason))).toBe(
      true,
    );
  });

  it("a leaked process is added to the written report after teardown", async () => {
    const h = harness({}, { results: allPass, looks: [], leaks: 1 });
    await runUat(options(), h.ports);
    expect(lastReport(h)).toContain("run-problems: leak");
    expect(refusalReasons(lastReport(h)).some((reason) => /recorded problems/.test(reason))).toBe(
      true,
    );
  });

  it("a cleanup error is added to the written report after teardown", async () => {
    const h = harness({}, { results: allPass, looks: [], cleanupErrors: 1 });
    await runUat(options(), h.ports);
    expect(lastReport(h)).toContain("cleanup-error");
  });

  it("a clean run carries no run-problems line and writes the report once", async () => {
    const h = harness({}, { results: allPass, looks: [] });
    await runUat(options(), h.ports);
    expect(h.reports).toHaveLength(1);
    expect(lastReport(h)).not.toContain("run-problems");
  });
});
