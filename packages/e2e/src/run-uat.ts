import type { GitFacts } from "./git-facts.js";
import { buildWdioEnv } from "./isolation-guards.js";
import type { UatProfile } from "./profile.js";
import { type ReportRow, renderReport, resolveReportPath } from "./report.js";
import { addFrontMatterNote } from "./report-io.js";
import { type ItemResolution, type ResultRecord, resolveItemStatus } from "./results.js";
import type { SandboxHandle, SandboxOutcome } from "./sandbox.js";
import { sanitizeText } from "./sanitize.js";
import { UAT_ITEM_PLAN, UAT_PHASE_PREFIX } from "./spec-map.js";
import type { SpikeDecisions } from "./spike-decisions.js";
import {
  expectedTitlesByItem,
  findOnlyTests,
  groupTitles,
  LINT_CODES,
  lintTags,
  type SpecTitle,
} from "./tag-lint.js";
import { parseUatScript, phasePrefixOf } from "./uat-tags.js";
import type { VaultKind } from "./uat-vault.js";
import { finalMismatches, type VersionRecord } from "./versions.js";
import type { WdioResult } from "./wdio-spawn.js";

/**
 * The run pipeline over injected ports (05.2-09, D-03, D-05, D-06, D-10, D-11, E2E-03).
 * The order is the safety property: every refusal precedes any process, the whole run executes
 * inside the sandbox so teardown, the account deletion and the leak check are unconditional,
 * and the report and the look handoff are written before the run root disappears. Exit codes:
 * 0 completed with nothing failed and no leak (look-pending items do not fail the run), 1 any
 * failed item, wdio failure, version mismatch or leak, 2 usage or refusal.
 */

export interface CacheVerdict {
  ok: boolean;
  note: string;
}

export interface LookPendingItem {
  item: number;
  labels: string[];
  count: number;
}

export interface LookHandoff {
  shotsDir: string;
  runId: string;
  reportPath: string | null;
  items: LookPendingItem[];
}

export interface RunOptions {
  profile: UatProfile;
  script?: string | undefined;
  phaseDir?: string | undefined;
  out?: string | undefined;
  shotsDir?: string | undefined;
  specs: readonly string[];
}

/** What the runner asks of the sandbox's own teardown. */
export interface SandboxHooks {
  beforeRemove?: (info: { root: string; wdioDir: string; runId: string }) => void;
}

export interface RunPorts {
  env: Readonly<Record<string, string | undefined>>;
  platform: string;
  decisions: SpikeDecisions;
  homeDir: string;
  now: () => Date;
  log: (line: string) => void;
  missingArtifacts: () => string[];
  checkInstalledApp: () => void;
  verifyCache: () => CacheVerdict;
  purgeShots: (shotsBase: string | undefined) => void;
  runSandbox: <T>(
    body: (sandbox: SandboxHandle) => Promise<T>,
    hooks?: SandboxHooks,
  ) => Promise<SandboxOutcome<T>>;
  generateVault: (sandbox: SandboxHandle, kind: VaultKind, profile: UatProfile) => Promise<void>;
  stageGeneratedPlugin: (sandbox: SandboxHandle) => void;
  createShots: (runId: string, shotsBase: string | undefined) => string;
  deleteShots: (dir: string) => void;
  spawnWdio: (input: {
    sandbox: SandboxHandle;
    wdioEnv: Record<string, string>;
    extraArgs: string[];
  }) => Promise<WdioResult>;
  /**
   * Optional: keeps wdio's per-worker logs (hook errors land there, not on the console) before
   * the run root is torn down. Returns the folder it wrote, for the run log.
   */
  saveWdioLogs?: (input: { wdioDir: string; runId: string }) => string | null;
  /** The tagged test titles of the spec files, for the expected-title check. */
  readSpecTitles: (phasePrefix: string) => SpecTitle[];
  readResults: (path: string) => ResultRecord[];
  readLookPending: (path: string) => LookPendingItem[];
  readVersions: (path: string) => VersionRecord | undefined;
  readScript: (path: string) => string | null;
  readGitFacts: () => Promise<GitFacts>;
  buildHash: () => string;
  writeReport: (path: string | null, text: string) => void;
  handoffLooks: (input: LookHandoff) => void;
}

export interface RunOutcome {
  exitCode: 0 | 1 | 2;
  message: string;
  runId: string | null;
  reportPath: string | null;
  lookPending: LookPendingItem[];
  failedItems: number[];
}

const LOOK_PENDING_STATUS = "inconclusive (look pending)";
const LOOK_UNAVAILABLE_STATUS = "inconclusive (look unavailable: handoff failed)";
const LOOK_RECORD_ERROR = "The look-pending file holds a line that is not a valid record.";

const MSG = {
  ci: "The live UAT runner needs a GUI session and refuses to run under CI.",
  platform: "The live UAT runner runs on macOS only.",
  build: "Build output is missing; run pnpm exec turbo run build first.",
  decisions: "The spike decisions are not recorded; record them in spike-decisions.ts first.",
} as const;

/**
 * Reads look-pending.jsonl (one JSON line per recorded group of images): the labels of each item
 * are merged without repeats and counted. A torn final line is ignored, an earlier bad line is not.
 */
export function parseLookPendingLines(text: string): LookPendingItem[] {
  const lines = text.split("\n");
  const endsWithNewline = text.endsWith("\n");
  const byItem = new Map<number, string[]>();
  lines.forEach((line, index) => {
    if (line === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      if (index === lines.length - 1 && !endsWithNewline) return;
      throw new Error(LOOK_RECORD_ERROR);
    }
    const record = (typeof value === "object" && value !== null ? value : {}) as {
      item?: unknown;
      labels?: unknown;
    };
    if (
      typeof record.item !== "number" ||
      !Number.isInteger(record.item) ||
      !Array.isArray(record.labels) ||
      !record.labels.every((label) => typeof label === "string")
    ) {
      throw new Error(LOOK_RECORD_ERROR);
    }
    const labels = byItem.get(record.item) ?? [];
    for (const label of record.labels as string[]) if (!labels.includes(label)) labels.push(label);
    byItem.set(record.item, labels);
  });
  return [...byItem.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([item, labels]) => ({ item, labels, count: labels.length }));
}

function refusal(message: string): RunOutcome {
  return { exitCode: 2, message, runId: null, reportPath: null, lookPending: [], failedItems: [] };
}

interface Produced {
  reportPath: string | null;
  lookPending: LookPendingItem[];
  failedItems: number[];
  wdioFailed: boolean;
  versionProblems: string[];
  counts: string;
  /** The report text before any run-problems line, kept to re-render it after teardown. */
  baseReport: string;
  /** The run-problems words already written into the report from inside the body. */
  writtenProblems: string[];
}

/** One row per script item (D-09), or one per recorded test when there is no script. */
function rowsFrom(
  scriptText: string | null,
  results: readonly ResultRecord[],
  profile: UatProfile,
  readSpecTitles: (phasePrefix: string) => SpecTitle[],
): { rows: ReportRow[]; phasePrefix: string; mapped: boolean } {
  if (scriptText === null) {
    const rows = results.map((entry, index): ReportRow => {
      const status =
        entry.state === "passed" ? "pass" : entry.state === "failed" ? "fail" : "inconclusive";
      const resolution: ItemResolution = {
        kind: "status",
        item: index + 1,
        status,
        reason: `test ${entry.state}`,
        message: entry.message,
      };
      return { number: index + 1, title: entry.title, runClass: "auto", resolution };
    });
    return { rows, phasePrefix: UAT_PHASE_PREFIX, mapped: false };
  }
  const parsed = parseUatScript(scriptText);
  const phasePrefix = phasePrefixOf(parsed.frontMatter) ?? UAT_PHASE_PREFIX;
  // Every tagged spec test an item expects, so an item cannot pass while one left no record.
  const expected = expectedTitlesByItem(readSpecTitles(phasePrefix), phasePrefix);
  const rows = parsed.items.map((item): ReportRow => {
    const plan = UAT_ITEM_PLAN.find((entry) => entry.number === item.number);
    const resolution = resolveItemStatus({
      item: {
        number: item.number,
        runClass: item.runClass,
        fullProfileOnly: plan?.profile === "full",
        expectedTitles: expected.get(item.number) ?? [],
      },
      results,
      looks: [],
      profile,
      phasePrefix,
    });
    return { number: item.number, title: item.title, runClass: item.runClass, resolution };
  });
  return { rows, phasePrefix, mapped: true };
}

/**
 * The script/test mapping findings (parser findings, tags without an item or an item without a
 * test, `.only` tests): the same checks the lint command makes, run before anything launches so a
 * report with a silently dropped item can never be ratified. Finding codes and item numbers only.
 */
export function mappingFindings(
  scriptText: string,
  readSpecTitles: (phasePrefix: string) => SpecTitle[],
): string[] {
  const parsed = parseUatScript(scriptText);
  const phasePrefix = phasePrefixOf(parsed.frontMatter) ?? UAT_PHASE_PREFIX;
  const titles = readSpecTitles(phasePrefix);
  const found = [
    ...parsed.findings,
    // A tagged test with no matching script item  would be dropped silently from the report. A tagged item with no test is
    // already caught per item, by the expected-titles check in resolveItemStatus.
    ...lintTags({ items: parsed.items, specTitles: groupTitles(titles), phasePrefix }).filter(
      (entry) => entry.code === LINT_CODES.testNoItem,
    ),
    ...findOnlyTests(titles, phasePrefix),
  ];
  return found.map((entry) =>
    entry.item === null ? entry.code : `${entry.code} item ${entry.item}`,
  );
}

function statusOf(row: ReportRow): string | null {
  return row.resolution.kind === "status" ? row.resolution.status : null;
}

function plain(text: string, ports: RunPorts): string {
  return sanitizeText(text, { homeDir: ports.homeDir, maxLength: 200 });
}

export async function runUat(options: RunOptions, ports: RunPorts): Promise<RunOutcome> {
  // Refusals come first and start nothing (D-03, T-05.2-40).
  if (ports.env.CI !== undefined && ports.env.CI !== "") return refusal(MSG.ci);
  if (ports.platform !== "darwin") return refusal(MSG.platform);
  if (ports.decisions.status !== "recorded") return refusal(MSG.decisions);
  if (ports.missingArtifacts().length > 0) return refusal(MSG.build);
  try {
    ports.checkInstalledApp();
  } catch (error) {
    return refusal(plain((error as Error).message, ports));
  }
  const cache = ports.verifyCache();
  if (!cache.ok) return refusal(`The Obsidian download cache check failed: ${cache.note}`);
  if (options.script !== undefined) {
    const early = ports.readScript(options.script);
    if (early !== null) {
      const findings = mappingFindings(early, ports.readSpecTitles);
      if (findings.length > 0) {
        return refusal(`The script and the specs do not map one to one: ${findings.join("; ")}.`);
      }
    }
  }

  const startedAt = ports.now();
  let shotsDir: string | undefined;
  let handedOff = false;
  let handoffFailed = false;
  // Kept outside the sandbox callback so the final report is written even if the callback fails
  // after rendering it (for example when the screenshot handoff throws).
  let captured: { reportPath: string | null; baseReport: string; wdioFailed: boolean } | undefined;
  let outcome: SandboxOutcome<Produced>;
  try {
    outcome = await ports.runSandbox(
      async (sandbox): Promise<Produced> => {
        // Only after the sandbox started (so a run refused as busy purges nothing, Codex finding 4).
        ports.purgeShots(options.shotsDir);
        await ports.generateVault(sandbox, "live", options.profile);
        if (options.profile === "full") await ports.generateVault(sandbox, "big", options.profile);
        ports.stageGeneratedPlugin(sandbox);
        const shots = ports.createShots(sandbox.runId, options.shotsDir);
        shotsDir = shots;
        const wdioEnv = buildWdioEnv(sandbox.paths, {
          account: sandbox.account,
          profile: options.profile,
          shotsDir: shots,
        });
        const extraArgs = options.specs.flatMap((spec) => ["--spec", spec]);
        let wdioFailed = false;
        try {
          const result = await ports.spawnWdio({ sandbox, wdioEnv, extraArgs });
          wdioFailed = result.exitCode !== 0;
        } catch {
          wdioFailed = true;
        }
        // Results are read even after a wdio failure: a partial report beats none.
        const results = ports.readResults(sandbox.paths.resultsPath);
        const scriptText = options.script === undefined ? null : ports.readScript(options.script);
        const looks = ports.readLookPending(sandbox.paths.lookPendingPath);
        const versions = ports.readVersions(sandbox.paths.versionsPath);
        const versionProblems = finalMismatches(versions, results.length > 0);
        const git = await ports.readGitFacts();
        const built = rowsFrom(scriptText, results, options.profile, ports.readSpecTitles);
        const { phasePrefix, mapped } = built;
        let rows = built.rows;

        const reportPath = resolveReportPath({
          phaseDir: options.phaseDir,
          phasePrefix,
          out: options.out,
        });
        let pending = rows
          .filter((row) => statusOf(row) === LOOK_PENDING_STATUS)
          .map((row): LookPendingItem => {
            const recorded = looks.find((entry) => entry.item === row.number);
            return recorded ?? { item: row.number, labels: [], count: 0 };
          });
        // The handoff comes before the report is rendered: when it fails the images are gone, so the
        // report must not offer looks nobody can record (Codex re-review 3).
        try {
          ports.handoffLooks({ shotsDir: shots, runId: sandbox.runId, reportPath, items: pending });
          handedOff = true;
        } catch {
          // The run is still reported; the failure is a run problem, so ratify refuses it.
          handoffFailed = true;
          const unavailable = new Set(pending.map((entry) => entry.item));
          rows = rows.map((row) =>
            unavailable.has(row.number) && row.resolution.kind === "status"
              ? { ...row, resolution: { ...row.resolution, status: LOOK_UNAVAILABLE_STATUS } }
              : row,
          );
          pending = [];
        }

        let text = renderReport({
          runId: sandbox.runId,
          profile: options.profile,
          startedAt: startedAt.toISOString(),
          finishedAt: ports.now().toISOString(),
          appVersion: versions?.app ?? "unknown",
          installerVersion: versions?.installer ?? "unknown",
          gitHead: git.head,
          gitClean: git.clean,
          buildHash: ports.buildHash(),
          phasePrefix,
          rows,
          homeDir: ports.homeDir,
        });
        if (versionProblems.length > 0) {
          text = addFrontMatterNote(text, "version-mismatch", versionProblems.join(","));
        }
        if (!mapped) text = addFrontMatterNote(text, "item-mapping", "unavailable");
        const baseReport = text;
        // `teardown-pending` stays in the report until teardown finished and the final outcome was
        // written; a run that dies in between can never be ratified (Codex finding 2).
        const writtenProblems = [...(wdioFailed ? ["wdio-failed"] : []), "teardown-pending"];
        if (writtenProblems.length > 0) {
          text = addFrontMatterNote(text, "run-problems", writtenProblems.join(","));
        }
        captured = { reportPath, baseReport, wdioFailed };
        // A stdout-only report is printed once, after teardown, with the final outcome: printing a
        // provisional one first would leave two reports on the screen. A file report is written now
        // (marked teardown-pending) so a crash leaves something, and finalised below.
        if (reportPath !== null) ports.writeReport(reportPath, text);

        const failedItems = mapped
          ? rows
              .filter((row) => ["fail", "inconclusive"].includes(statusOf(row) ?? ""))
              .map((row) => row.number)
          : [];
        const tally = (status: string): number =>
          rows.filter((row) => statusOf(row) === status).length;
        const counts = `pass ${tally("pass")}, fail ${tally("fail")}, look pending ${pending.length}.`;
        return {
          reportPath,
          lookPending: pending,
          failedItems,
          wdioFailed,
          versionProblems,
          counts,
          baseReport,
          writtenProblems,
        };
      },
      {
        // Kept only after teardown has logged its kills and before the run root is removed, so the
        // kept folder holds runner-kills.log (a copy taken earlier never saw it).
        beforeRemove: ({ wdioDir, runId }) => {
          try {
            const saved = ports.saveWdioLogs?.({ wdioDir, runId });
            if (saved) ports.log(`wdio logs kept in ${saved}`);
          } catch {
            ports.log("The wdio logs could not be kept.");
          }
        },
      },
    );
  } catch (error) {
    return refusal(plain((error as Error).message, ports));
  }

  // A handoff that succeeded before the body failed (for example the report write) points at a
  // report that does not exist: the images go too.
  if (shotsDir !== undefined && (!handedOff || outcome.error !== undefined)) {
    try {
      ports.deleteShots(shotsDir);
    } catch {
      // The next run purges stale shots folders at its start.
    }
  }

  const produced = outcome.value;
  const problems: string[] = [];
  if (outcome.error !== undefined) {
    const reason = outcome.error instanceof Error ? outcome.error.message : "unknown error";
    problems.push(`the run failed (${plain(reason, ports)})`);
  }
  if (outcome.leaks.length > 0) problems.push(`${outcome.leaks.length} leaked process(es)`);
  if (outcome.cleanupErrors.length > 0) {
    problems.push(`${outcome.cleanupErrors.length} cleanup error(s)`);
  }
  if (produced?.wdioFailed === true) problems.push("wdio failed");
  if (handoffFailed) problems.push("the screenshot handoff failed");
  if ((produced?.versionProblems.length ?? 0) > 0) {
    problems.push(`version mismatch (${produced?.versionProblems.join(", ")})`);
  }
  if ((produced?.failedItems.length ?? 0) > 0) {
    problems.push(`items not passed: ${produced?.failedItems.join(", ")}`);
  }
  // Leaks and cleanup errors are only known after teardown: put them in the report too, so a
  // run that exited non-zero cannot be ratified (Wave 3 WR-01).
  if (captured !== undefined) {
    const final = [
      ...(captured.wdioFailed ? ["wdio-failed"] : []),
      ...(handoffFailed ? ["handoff-error"] : []),
      ...(outcome.leaks.length > 0 ? ["leak"] : []),
      ...(outcome.cleanupErrors.length > 0 ? ["cleanup-error"] : []),
      ...(outcome.error !== undefined ? ["run-error"] : []),
    ];
    try {
      ports.writeReport(
        captured.reportPath,
        final.length === 0
          ? captured.baseReport
          : addFrontMatterNote(captured.baseReport, "run-problems", final.join(",")),
      );
    } catch {
      problems.push("the report could not be updated with the final run outcome");
    }
  }
  const summary = produced === undefined ? "" : ` ${produced.counts}`;
  return {
    exitCode: problems.length === 0 ? 0 : 1,
    message: `Run ${outcome.runId}:${summary} ${problems.length === 0 ? "ok." : `${problems.join("; ")}.`}`,
    runId: outcome.runId,
    reportPath: produced?.reportPath ?? null,
    lookPending: produced?.lookPending ?? [],
    failedItems: produced?.failedItems ?? [],
  };
}
