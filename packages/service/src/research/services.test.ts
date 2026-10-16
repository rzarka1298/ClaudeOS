import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  JOB_RUN_OUTCOMES,
  newRunId,
  RESEARCH_JOB_ID,
  RUN_ERROR_CODES,
  type RunErrorCode,
} from "@ccc/domain";
import { getRun, listJobRuns, startJobRun } from "@ccc/operational-store";
import { extractiveSummary } from "@ccc/research";
import { readReportNote } from "@ccc/vault-repo";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { RUN_BYTE_CAP } from "./fetch/limits.js";
import { createSafeFetcher } from "./fetch/safe-fetch.js";
import { createFakeHttps } from "./fetch/test-support/fake-https.js";
import { SummariserError } from "./summariser-error.js";
import {
  createKit,
  defaultResponses,
  type Kit,
  ok,
  THREE,
  URL_ONE,
  URL_THREE,
  URL_TWO,
} from "./test-support/research-kit.js";

let kit: Kit | undefined;
afterEach(() => {
  kit?.close();
  kit = undefined;
});

function files(k: Kit, folder: string): string[] {
  try {
    return readdirSync(join(k.vaultRoot, folder)).filter((name) => name !== "index.md");
  } catch {
    return [];
  }
}

async function runToEnd(k: Kit): Promise<string> {
  const started = k.services.runNow();
  if (!started.ok) throw new Error(`refused: ${started.code}`);
  await k.services.idle();
  return started.value.runId;
}

function lastRow(k: Kit) {
  return listJobRuns(k.store.db, RESEARCH_JOB_ID, 1)[0];
}

function runNoteOf(k: Kit, runId: string): string {
  return readFileSync(join(k.vaultRoot, "automation-runs", `${runId}.md`), "utf8");
}

const FAIL = (code: "timeout" | "http-status" = "timeout") => ({ ok: false as const, code });

describe("Test 1 (partial): one failed source makes a partial report that says so", () => {
  it("lists the unavailable source with its label and code and counts the rest", async () => {
    kit = createKit({ responses: { ...defaultResponses(), [URL_TWO]: FAIL("timeout") } });
    const runId = await runToEnd(kit);
    const row = lastRow(kit);
    expect(row?.outcome).toBe("partial");
    expect(row?.state).toBe("completed");
    expect(row?.sourceCount).toBe(2);
    expect(row?.sourceTotal).toBe(3);
    expect(row?.errorCode).toBeNull();
    expect(row?.unavailableSources).toHaveLength(1);
    expect(row?.unavailableSources[0]?.code).toBe("timeout");

    const reports = files(kit, "global/output");
    expect(reports).toHaveLength(1);
    const read = readReportNote(kit.vaultRoot, `global/output/${reports[0]}`);
    if (!read.readable) throw new Error("report must be readable");
    expect(read.frontmatter.partial).toBe(true);
    expect(read.frontmatter.sourceTotal).toBe(3);
    expect(read.frontmatter.sourceRefs).toHaveLength(2);
    expect(read.frontmatter.unavailableSources).toEqual([
      { label: "Beta releases", code: "timeout" },
    ]);
    expect(files(kit, "global/raw")).toHaveLength(2);
    expect(runNoteOf(kit, runId)).toContain("Beta releases: unavailable");
    expect(kit.events.at(-1)?.payload).toMatchObject({ state: "completed", outcome: "partial" });
  });

  it("isolates every source: a source that cannot be parsed or is empty is unavailable, not fatal", async () => {
    kit = createKit({
      responses: {
        ...defaultResponses(),
        [URL_ONE]: ok(URL_ONE, "this is not a feed at all"),
        [URL_TWO]: ok(
          URL_TWO,
          '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>',
        ),
      },
    });
    await runToEnd(kit);
    const row = lastRow(kit);
    expect(row?.outcome).toBe("partial");
    expect(row?.sourceCount).toBe(1);
    expect(row?.unavailableSources.map((entry) => entry.code).sort()).toEqual([
      "empty-content",
      "parse-failure",
    ]);
  });
});

describe("Test 2 (all failed): zero successes is a failed run with no notes", () => {
  it("finishes failure all-sources-failed with no raw, wiki or report note", async () => {
    kit = createKit({
      responses: { [URL_ONE]: FAIL(), [URL_TWO]: FAIL("http-status"), [URL_THREE]: FAIL() },
    });
    const runId = await runToEnd(kit);
    const row = lastRow(kit);
    expect(row?.outcome).toBe("failure");
    expect(row?.state).toBe("failed");
    expect(row?.errorCode).toBe("all-sources-failed");
    expect(row?.reportNoteId).toBeNull();
    expect(row?.sourceCount).toBe(0);
    expect(row?.unavailableSources).toHaveLength(3);
    for (const folder of ["global/raw", "global/wiki", "global/output"]) {
      expect(files(kit, folder), folder).toEqual([]);
    }
    expect(kit.transportInputs).toHaveLength(0);
    const note = runNoteOf(kit, runId);
    expect(note).toContain("Outcome: Failure");
    expect(note).toContain("all-sources-failed");
    expect(kit.events.at(-1)?.payload).toMatchObject({ state: "failed", outcome: "failure" });
  });
});

describe("Test 3 (summariser failures): each ends the run with its own code and keeps the raw notes", () => {
  const cases: [string, () => Promise<string>, RunErrorCode][] = [
    [
      "unconfigured",
      async () => {
        throw new SummariserError("summariser-unconfigured");
      },
      "summariser-unconfigured",
    ],
    [
      "failed",
      async () => {
        throw new SummariserError("summariser-failed");
      },
      "summariser-failed",
    ],
    [
      "refused",
      async () => {
        throw new SummariserError("summariser-refused");
      },
      "summariser-refused",
    ],
    [
      "an answer that is not JSON",
      async () => "I will now do something else",
      "summariser-invalid-output",
    ],
    [
      "an answer with an unknown key",
      async () => '{"items":[],"tools":[]}',
      "summariser-invalid-output",
    ],
    [
      "an error that is not a summariser error",
      async () => {
        throw new Error(`secret detail ${["", "Users", "someone"].join("/")}`);
      },
      "summariser-failed",
    ],
  ];
  for (const [name, complete, code] of cases) {
    it(name, async () => {
      kit = createKit({ transport: { complete } });
      const runId = await runToEnd(kit);
      const row = lastRow(kit);
      expect(row?.outcome).toBe("failure");
      expect(row?.errorCode).toBe(code);
      expect(row?.reportNoteId).toBeNull();
      expect(files(kit, "global/raw")).toHaveLength(3);
      expect(files(kit, "global/wiki")).toEqual([]);
      expect(files(kit, "global/output")).toEqual([]);
      expect(row?.stageLog.map((entry) => entry.stage)).toEqual(["capture", "raw"]);
      const note = runNoteOf(kit, runId);
      for (const id of row?.stageLog.find((entry) => entry.stage === "raw")?.noteIds ?? []) {
        expect(note).toContain(id);
      }
      expect(note).toContain(code);
      expect(JSON.stringify(kit.logs)).not.toContain("secret");
      expect(JSON.stringify(kit.logs)).not.toContain(["", "Users"].join("/"));
    });
  }
});

describe("zero surviving items is a failed run, not a success (wave 3 minor)", () => {
  for (const [name, answer] of [
    ["an empty items list", '{"items":[]}'],
    [
      "items that all fail the trusted stage",
      JSON.stringify({
        items: [{ kind: "recommendation", text: "You should upgrade now.", citedSourceIds: [] }],
      }),
    ],
  ] as const) {
    it(name, async () => {
      kit = createKit({ transport: { complete: async () => answer } });
      await runToEnd(kit);
      const row = lastRow(kit);
      expect(row?.outcome).toBe("failure");
      expect(row?.errorCode).toBe("summariser-invalid-output");
      expect(row?.state).toBe("failed");
      expect(files(kit, "global/output")).toEqual([]);
      expect(files(kit, "global/wiki")).toEqual([]);
      expect(row?.stageLog.map((entry) => entry.stage)).toEqual(["capture", "raw"]);
    });
  }
});

describe("Test 4 (vault failure): a write failure is vault-write-failed; a run note failure is not", () => {
  it("a report that cannot be written fails the run and writes no report", async () => {
    kit = createKit();
    rmSync(join(kit.vaultRoot, "global", "output"), { recursive: true });
    writeFileSync(join(kit.vaultRoot, "global", "output"), "a file where a folder belongs");
    await runToEnd(kit);
    const row = lastRow(kit);
    expect(row?.outcome).toBe("failure");
    expect(row?.errorCode).toBe("vault-write-failed");
    expect(row?.reportNoteId).toBeNull();
    expect(files(kit, "global/raw")).toHaveLength(3);
  });

  it("a raw note that cannot be written fails the run and keeps the ones already written", async () => {
    kit = createKit();
    rmSync(join(kit.vaultRoot, "global", "raw"), { recursive: true });
    writeFileSync(join(kit.vaultRoot, "global", "raw"), "a file where a folder belongs");
    await runToEnd(kit);
    const row = lastRow(kit);
    expect(row?.errorCode).toBe("vault-write-failed");
    expect(row?.outcome).toBe("failure");
    expect(kit.transportInputs).toHaveLength(0);
  });

  it("a run note that cannot be written leaves the outcome alone and logs a code only", async () => {
    kit = createKit();
    rmSync(join(kit.vaultRoot, "automation-runs"), { recursive: true });
    writeFileSync(join(kit.vaultRoot, "automation-runs"), "a file where a folder belongs");
    await runToEnd(kit);
    const row = lastRow(kit);
    expect(row?.outcome).toBe("success");
    expect(row?.errorCode).toBeNull();
    const failures = kit.logs.filter((line) => line.event === "research-run-note-failed");
    expect(failures.length).toBeGreaterThan(0);
    for (const line of failures) {
      expect(Object.keys(line).sort()).toEqual(["errorName", "event", "level"]);
    }
    expect(files(kit, "global/output")).toHaveLength(1);
  });
});

describe("Test 5 (in flight and no vault): one run at a time, refused without a vault", () => {
  it("returns the running run id to a second press in the same tick and creates one job run", async () => {
    kit = createKit();
    const first = kit.services.runNow();
    const second = kit.services.runNow();
    if (!first.ok || !second.ok) throw new Error("refused");
    expect(first.value.alreadyRunning).toBe(false);
    expect(second.value.alreadyRunning).toBe(true);
    expect(second.value.runId).toBe(first.value.runId);
    expect(first.value.state).toBe("running");
    expect(listJobRuns(kit.store.db, RESEARCH_JOB_ID, 10)).toHaveLength(1);
    await kit.services.idle();
    expect(listJobRuns(kit.store.db, RESEARCH_JOB_ID, 10)).toHaveLength(1);
    // After the run, the next press starts a new one.
    const third = kit.services.runNow();
    if (!third.ok) throw new Error("refused");
    expect(third.value.alreadyRunning).toBe(false);
    expect(third.value.runId).not.toBe(first.value.runId);
    await kit.services.idle();
    expect(listJobRuns(kit.store.db, RESEARCH_JOB_ID, 10)).toHaveLength(2);
  });

  it("refuses with vault-not-set-up and inserts nothing when there is no vault", () => {
    kit = createKit({ vault: false });
    expect(kit.services.runNow()).toEqual({ ok: false, code: "vault-not-set-up" });
    expect(listJobRuns(kit.store.db, RESEARCH_JOB_ID, 10)).toEqual([]);
    expect(kit.events).toEqual([]);
  });
});

describe("Test 6 (allowlist file) as seen from a run", () => {
  it("fails the run as all-sources-failed with a code-only log line, and never overwrites the file", async () => {
    kit = createKit({ writeConfig: false });
    writeFileSync(kit.sourcesPath, "{ this is not json", { mode: 0o600 });
    const runId = await runToEnd(kit);
    const row = lastRow(kit);
    expect(row?.errorCode).toBe("all-sources-failed");
    expect(row?.outcome).toBe("failure");
    expect(readFileSync(kit.sourcesPath, "utf8")).toBe("{ this is not json");
    const line = kit.logs.find((entry) => entry.event === "research-sources-unusable");
    expect(line).toEqual({ level: "warn", event: "research-sources-unusable", code: "invalid" });
    expect(runNoteOf(kit, runId)).toContain("all-sources-failed");
    expect(kit.fetchCalls).toHaveLength(0);
  });

  it("fails the run as all-sources-failed when zero sources are configured", async () => {
    kit = createKit({ sources: [] });
    await runToEnd(kit);
    const row = lastRow(kit);
    expect(row?.errorCode).toBe("all-sources-failed");
    expect(row?.sourceTotal).toBe(0);
    expect(kit.fetchCalls).toHaveLength(0);
  });

  it("fails the run when the allowlist lists one address twice", async () => {
    kit = createKit({
      sources: [THREE[0], { label: "Alias", url: `${URL_ONE}#again`, kind: "feed" }] as never,
    });
    await runToEnd(kit);
    expect(lastRow(kit)?.errorCode).toBe("all-sources-failed");
    expect(kit.logs.some((entry) => entry.code === "duplicate-source")).toBe(true);
    expect(kit.fetchCalls).toHaveLength(0);
  });

  it("seeds the defaults when the file is absent and fetches only what the file lists", async () => {
    kit = createKit({ writeConfig: false, respond: async () => ({ ok: false, code: "timeout" }) });
    await runToEnd(kit);
    const configured = kit.services.configuredSources();
    expect(configured?.sources.length).toBeGreaterThanOrEqual(3);
    expect(kit.fetchCalls).toHaveLength(1);
    expect(kit.fetchCalls[0]?.urls.length).toBe(configured?.sources.length);
  });

  it("reports the configured sources by label and host only", () => {
    kit = createKit();
    expect(kit.services.configuredSources()).toEqual({
      topicLabel: "Developer tooling",
      sources: [
        { label: "Alpha releases", host: "one.example.invalid" },
        { label: "Beta releases", host: "two.example.invalid" },
        { label: "Gamma releases", host: "three.example.invalid" },
      ],
    });
  });
});

describe("Test 7 (bounds): concurrency, the run byte budget and entries per feed", () => {
  it("hands every source to the fetcher in one call with one fresh 6 MiB budget", async () => {
    kit = createKit();
    await runToEnd(kit);
    expect(kit.fetchCalls).toHaveLength(1);
    expect(kit.fetchCalls[0]?.urls).toEqual([URL_ONE, URL_TWO, URL_THREE]);
    expect(kit.fetchCalls[0]?.budget?.remaining()).toBe(RUN_BYTE_CAP);
    expect(RUN_BYTE_CAP).toBe(6 * 1024 * 1024);
  });

  it("fetches at most three at a time through the real fetcher", async () => {
    const sources = Array.from({ length: 7 }, (_, index) => ({
      label: `Source ${index}`,
      url: `https://s${index}.example.invalid/page`,
      kind: "page" as const,
    }));
    let active = 0;
    let peak = 0;
    const fake = createFakeHttps(
      () => {
        active += 1;
        peak = Math.max(peak, active);
        setTimeout(() => {
          active -= 1;
        }, 50);
        return {
          headers: { "content-type": "text/html; charset=utf-8" },
          body: "<html><body><p>The maintainers confirmed that the page parser is faster in this release.</p></body></html>",
          responseDelayMs: 70,
        };
      },
      { exerciseLookup: false },
    );
    const fetcher = createSafeFetcher({ request: fake.request, env: {}, execArgv: [] });
    kit = createKit({ sources, fetcher });
    await runToEnd(kit);
    expect(fake.calls).toHaveLength(7);
    expect(peak).toBe(3);
    expect(lastRow(kit)?.outcome).toBe("success");
    expect(lastRow(kit)?.sourceCount).toBe(7);
  });

  it("keeps at most five entries of a feed", async () => {
    const entries = Array.from(
      { length: 9 },
      (_, index) =>
        `<entry><title>Entry number ${index}</title><updated>2026-10-0${index + 1}T10:00:00Z</updated><summary>The maintainers confirmed the change number ${index} ships today.</summary></entry>`,
    ).join("");
    const feed = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;
    kit = createKit({ sources: [THREE[0]] as never, responses: { [URL_ONE]: ok(URL_ONE, feed) } });
    await runToEnd(kit);
    const snapshot = files(kit, "global/raw").find((name) => name.endsWith(".md")) ?? "";
    const text = readFileSync(join(kit.vaultRoot, "global/raw", snapshot), "utf8");
    expect(text.match(/Entry number \d/g)).toHaveLength(5);
    expect(text).toContain("Entry number 8");
    expect(text).not.toContain("Entry number 0");
  });
});

describe("the summariser input is trimmed to the transport's cap at source-block boundaries", () => {
  it("drops whole sources that do not fit and reports them as unavailable, never cutting a block", async () => {
    // First learn how long the input is when everything fits, then allow one character less.
    kit = createKit();
    await runToEnd(kit);
    const full = kit.transportInputs[0]?.length ?? 0;
    expect(full).toBeGreaterThan(0);
    kit.close();

    kit = createKit({ maxInputChars: full - 1 });
    await runToEnd(kit);
    const input = kit.transportInputs[0] ?? "";
    expect(input.length).toBeLessThanOrEqual(full - 1);
    const ids = [...input.matchAll(/<<<SRC id=([0-9a-f]{32}) nonce=/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect([...input.matchAll(/<<<END nonce=/g)]).toHaveLength(2);
    expect(input.endsWith(`Source IDs: ${ids.join(", ")}`)).toBe(true);
    const row = lastRow(kit);
    expect(row?.outcome).toBe("partial");
    expect(row?.unavailableSources.map((entry) => entry.code)).toEqual(["oversize"]);
    expect(row?.sourceCount).toBe(2);
    expect(row?.sourceTotal).toBe(3);
    const reports = files(kit, "global/output");
    const read = readReportNote(kit.vaultRoot, `global/output/${reports[0]}`);
    if (!read.readable) throw new Error("report must be readable");
    expect(read.frontmatter.partial).toBe(true);
    expect(read.frontmatter.sourceRefs.map((ref) => ref.id)).toEqual(ids);
    expect(read.frontmatter.unavailableSources).toEqual([
      { label: "Gamma releases", code: "oversize" },
    ]);
    // A dropped source is not written as a raw or wiki note.
    expect(files(kit, "global/raw")).toHaveLength(2);
    expect(files(kit, "global/wiki")).toHaveLength(2);
  });

  it("fails with all-sources-failed, and no model call, when no source fits", async () => {
    kit = createKit({ maxInputChars: 100 });
    await runToEnd(kit);
    const row = lastRow(kit);
    expect(row?.outcome).toBe("failure");
    expect(row?.errorCode).toBe("all-sources-failed");
    expect(row?.unavailableSources.map((entry) => entry.code)).toEqual([
      "oversize",
      "oversize",
      "oversize",
    ]);
    expect(kit.transportInputs).toHaveLength(0);
    expect(files(kit, "global/raw")).toEqual([]);
  });
});

describe("the watchdog: a hung pipeline ends as a failed run with a closed code", () => {
  function manualTimer() {
    const timers: { fire: () => void; ms: number; cancelled: boolean }[] = [];
    return {
      timers,
      schedule(fire: () => void, ms: number): () => void {
        const timer = { fire, ms, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    };
  }

  async function until(condition: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !condition(); i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(condition()).toBe(true);
  }

  it("ends a transport that never answers as summariser-failed and writes nothing afterwards", async () => {
    const timer = manualTimer();
    let release: (answer: string) => void = () => {};
    const hung = new Promise<string>((resolve) => {
      release = resolve;
    });
    kit = createKit({
      transport: { complete: () => hung },
      watchdogMs: 1234,
      scheduleTimeout: (fire, ms) => timer.schedule(fire, ms),
    });
    const started = kit.services.runNow();
    if (!started.ok) throw new Error("refused");
    await until(() => kit?.transportInputs.length === 1);
    expect(timer.timers).toHaveLength(1);
    expect(timer.timers[0]?.ms).toBe(1234);
    timer.timers[0]?.fire();
    await kit.services.idle();

    const row = lastRow(kit);
    expect(row?.outcome).toBe("failure");
    expect(row?.state).toBe("failed");
    expect(row?.errorCode).toBe("summariser-failed");
    expect(RUN_ERROR_CODES).toContain(row?.errorCode);
    expect(kit.events.at(-1)?.payload).toMatchObject({ state: "failed", outcome: "failure" });

    // The hung call finally answers: nothing is written, recorded or announced.
    const eventsBefore = kit.events.length;
    release(extractiveSummary(kit.transportInputs[0] ?? ""));
    await new Promise((r) => setTimeout(r, 30));
    expect(files(kit, "global/output")).toEqual([]);
    expect(files(kit, "global/wiki")).toEqual([]);
    expect(kit.events).toHaveLength(eventsBefore);
    expect(lastRow(kit)?.stageLog.map((e) => e.stage)).toEqual(["capture", "raw"]);
    // The run is no longer in flight: the next press starts a new run.
    const next = kit.services.runNow();
    expect(next.ok && next.value.alreadyRunning).toBe(false);
  });

  it("ends a fetcher that never answers as all-sources-failed and ignores its late answer", async () => {
    const timer = manualTimer();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    kit = createKit({
      respond: async (input) => {
        await gate;
        return defaultResponses()[input.url] ?? { ok: false, code: "network-error" };
      },
      scheduleTimeout: (fire, ms) => timer.schedule(fire, ms),
    });
    const started = kit.services.runNow();
    if (!started.ok) throw new Error("refused");
    await until(() => timer.timers.length === 1);
    timer.timers[0]?.fire();
    await kit.services.idle();
    const row = lastRow(kit);
    expect(row?.outcome).toBe("failure");
    expect(row?.errorCode).toBe("all-sources-failed");
    expect(row?.stageLog.map((e) => e.stage)).toEqual(["capture"]);

    // The fetches finally answer with good feeds: nothing is written, called or announced.
    const eventsBefore = kit.events.length;
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(files(kit, "global/raw")).toEqual([]);
    expect(files(kit, "global/wiki")).toEqual([]);
    expect(files(kit, "global/output")).toEqual([]);
    expect(kit.transportInputs).toHaveLength(0);
    expect(kit.events).toHaveLength(eventsBefore);
    expect(lastRow(kit)?.stageLog.map((e) => e.stage)).toEqual(["capture"]);
  });

  it("cancels the timer when the run ends by itself", async () => {
    const timer = manualTimer();
    kit = createKit({ scheduleTimeout: (fire, ms) => timer.schedule(fire, ms) });
    await runToEnd(kit);
    expect(timer.timers).toHaveLength(1);
    expect(timer.timers[0]?.cancelled).toBe(true);
    expect(lastRow(kit)?.outcome).toBe("success");
  });

  it("uses a bounded default of minutes, not hours", async () => {
    const timer = manualTimer();
    kit = createKit({ scheduleTimeout: (fire, ms) => timer.schedule(fire, ms) });
    await runToEnd(kit);
    expect(timer.timers[0]?.ms).toBeGreaterThanOrEqual(60_000);
    expect(timer.timers[0]?.ms).toBeLessThanOrEqual(15 * 60_000);
  });
});

describe("a run cannot be left in flight by a startup or finish problem", () => {
  it("still runs and finishes when the event bus throws on every publish", async () => {
    kit = createKit({ publishThrows: true });
    await runToEnd(kit);
    expect(lastRow(kit)?.outcome).toBe("success");
    expect(lastRow(kit)?.state).toBe("completed");
  });

  it("finishes as a failure when choosing the summariser throws", async () => {
    kit = createKit({ chooseThrows: true });
    await runToEnd(kit);
    const row = lastRow(kit);
    expect(row?.outcome).toBe("failure");
    expect(row?.errorCode).toBe("summariser-failed");
    expect(row?.state).toBe("failed");
  });

  it("finishes as a failure when the fetcher throws", async () => {
    kit = createKit({
      fetcher: {
        fetchSources: async () => {
          throw new Error("boom");
        },
      },
    });
    await runToEnd(kit);
    const row = lastRow(kit);
    expect(row?.outcome).toBe("failure");
    expect(row?.errorCode).toBe("all-sources-failed");
  });

  it("ends every run with an outcome from the closed set and, on failure, a closed code", async () => {
    kit = createKit({ responses: { [URL_ONE]: FAIL(), [URL_TWO]: FAIL(), [URL_THREE]: FAIL() } });
    await runToEnd(kit);
    const row = lastRow(kit);
    expect(JOB_RUN_OUTCOMES).toContain(row?.outcome);
    expect(RUN_ERROR_CODES).toContain(row?.errorCode);
  });
});

describe("a job run stuck in flight is swept, never completed (wave 3 minor)", () => {
  function leaveStuck(db: Database.Database): string {
    const jobRunId = newRunId();
    startJobRun(db, {
      jobRunId,
      jobKey: RESEARCH_JOB_ID,
      idempotencyKey: `${RESEARCH_JOB_ID}:manual:${jobRunId}`,
      trigger: "manual",
      startedAt: "2026-10-15T08:00:00.000Z",
    });
    return jobRunId;
  }

  it("moves an in-flight job run left by an earlier process to stale when the services start", async () => {
    let stuck = "";
    kit = createKit({
      beforeServices: (db) => {
        stuck = leaveStuck(db);
      },
    });
    const rows = listJobRuns(kit.store.db, RESEARCH_JOB_ID, 5);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.jobRunId).toBe(stuck);
    expect(rows[0]?.state).toBe("stale");
    expect(rows[0]?.outcome).toBeNull();
    expect(rows[0]?.endedAt).toBeNull();
    expect(getRun(kit.store.db, stuck as never)?.state).toBe("stale");
    // It no longer blocks a press.
    const started = kit.services.runNow();
    expect(started.ok && started.value.alreadyRunning).toBe(false);
    await kit.services.idle();
  });

  it("sweeps a job run whose paired run row is already terminal, leaving that row alone", () => {
    let stuck = "";
    kit = createKit({
      beforeServices: (db) => {
        stuck = leaveStuck(db);
        db.prepare("UPDATE runs SET state = 'failed', ended_at = ? WHERE run_id = ?").run(
          "2026-10-15T08:01:00.000Z",
          stuck,
        );
      },
    });
    expect(listJobRuns(kit.store.db, RESEARCH_JOB_ID, 5)[0]?.state).toBe("stale");
    expect(getRun(kit.store.db, stuck as never)?.state).toBe("failed");
  });

  it("starts a new run instead of answering a stuck row that this process is not running", async () => {
    kit = createKit();
    const stuck = leaveStuck(kit.store.db);
    const started = kit.services.runNow();
    if (!started.ok) throw new Error("refused");
    expect(started.value.alreadyRunning).toBe(false);
    expect(started.value.runId).not.toBe(stuck);
    await kit.services.idle();
    const rows = listJobRuns(kit.store.db, RESEARCH_JOB_ID, 5);
    expect(rows.find((row) => row.jobRunId === stuck)?.state).toBe("stale");
    expect(rows.find((row) => row.jobRunId === started.value.runId)?.outcome).toBe("success");
  });
});
