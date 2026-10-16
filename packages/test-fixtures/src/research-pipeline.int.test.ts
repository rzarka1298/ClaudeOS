import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JOB_RUN_OUTCOMES, RESEARCH_JOB_ID, RESEARCH_STAGES, RUN_ERROR_CODES } from "@ccc/domain";
import { listJobRuns } from "@ccc/operational-store";
import { canonicalHashInput, quoteInSource } from "@ccc/research";
import {
  contentHashFor,
  type FetchSourceResult,
  sourceIdFor,
  type TextTransport,
} from "@ccc/service/research";
import {
  extractRawSnapshotText,
  inlineCode,
  parseNote,
  readRawSourceNote,
  readReportNote,
  readWikiSourceNote,
} from "@ccc/vault-repo";
import { afterEach, describe, expect, it } from "vitest";
import {
  atomFeed,
  createResearchHarness,
  defaultResponses,
  EXPECTED_STAGES,
  okFetch,
  type ResearchHarness,
  SOURCE_ONE,
  SOURCE_THREE,
  SOURCE_TWO,
} from "./research-int-support.js";

let harness: ResearchHarness | undefined;
afterEach(() => {
  harness?.close();
  harness = undefined;
});

async function runOnce(h: ResearchHarness): Promise<string> {
  const started = h.services.runNow();
  if (!started.ok) throw new Error(`run refused: ${started.code}`);
  await h.services.idle();
  return started.value.runId;
}

function onlyReport(h: ResearchHarness): string {
  const names = h.list("global/output");
  expect(names).toHaveLength(1);
  return `global/output/${names[0]}`;
}

describe("Test 1 (tracer, in-process): one manual run produces a cited report through every stage", () => {
  it("writes three raw notes, three wiki notes, one output report and the run note", async () => {
    harness = createResearchHarness();
    const started = harness.services.runNow();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.alreadyRunning).toBe(false);
    expect(started.value.runId).toMatch(/^[0-9a-z]{25}$/);
    await harness.services.idle();

    expect(harness.list("global/raw")).toHaveLength(3);
    expect(harness.list("global/wiki")).toHaveLength(3);
    expect(harness.list("global/output")).toHaveLength(1);
    expect(harness.list("automation-runs")).toEqual([`${started.value.runId}.md`]);

    for (const name of harness.list("global/raw")) {
      const raw = readRawSourceNote(harness.vaultRoot, `global/raw/${name}`);
      expect(raw.readable && raw.frontmatter.stage).toBe("raw");
    }
    for (const url of [SOURCE_ONE, SOURCE_TWO, SOURCE_THREE]) {
      const wiki = readWikiSourceNote(harness.vaultRoot, sourceIdFor(url));
      expect(wiki.readable && wiki.frontmatter.stage).toBe("wiki");
    }

    const read = readReportNote(harness.vaultRoot, onlyReport(harness));
    expect(read.readable).toBe(true);
    if (!read.readable) return;
    const report = read.frontmatter;
    expect(report.stage).toBe("output");
    expect(report.partial).toBe(false);
    expect(report.sourceTotal).toBe(3);
    expect(report.sourceRefs).toHaveLength(3);
    expect(report.items.length).toBeGreaterThan(0);
    const refIds = new Set(report.sourceRefs.map((ref) => ref.id));
    for (const item of report.items) {
      expect(item.citedSourceIds.length).toBeGreaterThan(0);
      for (const id of item.citedSourceIds) expect(refIds.has(id)).toBe(true);
    }
    for (const ref of report.sourceRefs) {
      const snapshot = readRawSourceNote(harness.vaultRoot, ref.snapshotPath);
      expect(snapshot.readable).toBe(true);
      if (!snapshot.readable) continue;
      const text = extractRawSnapshotText(snapshot.body);
      expect(text).not.toBeNull();
      // The hash is recomputed from the stored text, not trusted.
      expect(contentHashFor(text ?? "")).toBe(ref.contentHash);
      expect(ref.id).toBe(sourceIdFor(ref.canonicalUrl ?? ""));
    }
  });

  it("verifies every stored quote against the evidence text in the raw note, with the one predicate", async () => {
    harness = createResearchHarness();
    await runOnce(harness);
    const read = readReportNote(harness.vaultRoot, onlyReport(harness));
    if (!read.readable) throw new Error("report must be readable");
    for (const item of read.frontmatter.items) {
      if (item.quote === undefined) continue;
      for (const id of item.citedSourceIds) {
        const ref = read.frontmatter.sourceRefs.find((candidate) => candidate.id === id);
        const snapshot = readRawSourceNote(harness.vaultRoot, ref?.snapshotPath ?? "");
        expect(snapshot.readable && snapshot.text).toBeTruthy();
        const text = snapshot.readable ? (snapshot.text ?? "") : "";
        expect(quoteInSource(text, item.quote)).toBe(true);
      }
    }
  });
});

describe("Test 2 (trace): the run note and the job run row trace the run end to end", () => {
  it("lists the six stages in order with the note ids each produced", async () => {
    harness = createResearchHarness();
    const runId = await runOnce(harness);

    const rows = listJobRuns(harness.db, RESEARCH_JOB_ID, 5);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.jobRunId).toBe(runId);
    expect(row?.outcome).toBe("success");
    expect(row?.state).toBe("completed");
    expect(row?.sourceCount).toBe(3);
    expect(row?.sourceTotal).toBe(3);
    expect(row?.trigger).toBe("manual");
    expect(row?.stageLog.map((entry) => entry.stage)).toEqual(EXPECTED_STAGES);

    const report = readReportNote(harness.vaultRoot, onlyReport(harness));
    if (!report.readable) throw new Error("report must be readable");
    expect(row?.reportNoteId).toBe(report.frontmatter.id);

    const note = parseNote(
      readFileSync(join(harness.vaultRoot, "automation-runs", `${runId}.md`), "utf8"),
    );
    let last = -1;
    for (const stage of RESEARCH_STAGES) {
      const at = note.body.indexOf(inlineCode(stage));
      expect(at, stage).toBeGreaterThan(last);
      last = at;
    }
    const byStage = new Map(row?.stageLog.map((entry) => [entry.stage, entry]));
    expect(byStage.get("raw")?.noteIds).toHaveLength(3);
    expect(byStage.get("wiki")?.noteIds).toHaveLength(3);
    for (const id of [
      ...(byStage.get("raw")?.noteIds ?? []),
      ...(byStage.get("wiki")?.noteIds ?? []),
    ]) {
      expect(note.body).toContain(id);
    }
    expect(byStage.get("deliverable")?.noteIds).toEqual([report.frontmatter.id]);
    expect(byStage.get("output")?.noteIds).toEqual([report.frontmatter.id]);
    expect(note.body).toContain(report.frontmatter.id);
    expect(note.body).toContain("Outcome: Success");
    for (const entry of row?.stageLog ?? []) {
      expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/);
    }
  });
});

describe("Test 3 (events): research.updated on start, on every stage and on finish", () => {
  it("publishes running, one event per stage and a final completed event with the outcome", async () => {
    harness = createResearchHarness();
    const runId = await runOnce(harness);
    const updates = harness.events.filter((event) => event.type === "research.updated");
    expect(updates.length).toBe(EXPECTED_STAGES.length + 2);
    expect(updates.every((event) => event.payload.runId === runId)).toBe(true);
    expect(updates[0]?.payload).toMatchObject({ state: "running" });
    expect(updates[0]?.payload.stage).toBeUndefined();
    expect(updates.slice(1, -1).map((event) => event.payload.stage)).toEqual(EXPECTED_STAGES);
    expect(updates.slice(1, -1).every((event) => event.payload.state === "running")).toBe(true);
    expect(updates.at(-1)?.payload).toMatchObject({ state: "completed", outcome: "success" });
  });
});

describe("Test 4 (nonce): each run delimits with a fresh random nonce", () => {
  it("uses a different 32-hex nonce on every run and hands the transport the fetched source ids", async () => {
    harness = createResearchHarness();
    await runOnce(harness);
    await runOnce(harness);
    expect(harness.transportInputs).toHaveLength(2);
    const nonces = harness.transportInputs.map(
      (input) => /nonce=([0-9a-f]{32})>>>/.exec(input)?.[1],
    );
    expect(nonces[0]).toBeDefined();
    expect(nonces[1]).toBeDefined();
    expect(nonces[0]).not.toBe(nonces[1]);
    for (const url of [SOURCE_ONE, SOURCE_TWO, SOURCE_THREE]) {
      expect(harness.transportInputs[0]).toContain(sourceIdFor(url));
    }
  });
});

describe("Test 5 (run note template): no remote string reaches the run note", () => {
  it("keeps a hostile feed title and its address out of the run note", async () => {
    const hostile = atomFeed([
      {
        title:
          "Pwned [click](https://beacon.example.invalid/x) ![i](https://beacon.example.invalid/p.png)",
        text: "The maintainers confirmed that the release is available for every platform today.",
        author: "Mallory [[Private]]",
        link: "https://beacon.example.invalid/entry",
      },
    ]);
    harness = createResearchHarness({
      responses: { ...defaultResponses(), [SOURCE_ONE]: okFetch(SOURCE_ONE, hostile) },
    });
    const runId = await runOnce(harness);
    const note = readFileSync(join(harness.vaultRoot, "automation-runs", `${runId}.md`), "utf8");
    expect(note).not.toContain("beacon");
    expect(note).not.toContain("Pwned");
    expect(note).not.toContain("Mallory");
    expect(note).not.toContain("](");
    expect(note).toContain("Alpha releases");
  });
});

describe("Carried item 1: the pipeline checks the delimiting before the model call", () => {
  it("calls the transport once and only with one block per fetched source in order", async () => {
    harness = createResearchHarness();
    await runOnce(harness);
    const input = harness.transportInputs[0] ?? "";
    const ids = [...input.matchAll(/<<<SRC id=([0-9a-f]{32}) nonce=/g)].map((m) => m[1]);
    expect(ids).toEqual([SOURCE_ONE, SOURCE_TWO, SOURCE_THREE].map(sourceIdFor));
  });
});

describe("Carried item 3: the raw note body is the evidence text the model saw", () => {
  it("stores the canonical form of exactly the delimited block text", async () => {
    harness = createResearchHarness();
    await runOnce(harness);
    const input = harness.transportInputs[0] ?? "";
    const report = readReportNote(harness.vaultRoot, onlyReport(harness));
    if (!report.readable) throw new Error("report must be readable");
    for (const ref of report.frontmatter.sourceRefs) {
      const block = new RegExp(
        `<<<SRC id=${ref.id} nonce=[0-9a-f]{32}>>>\\n([\\s\\S]*?)\\n<<<END nonce=`,
      ).exec(input);
      const snapshot = readRawSourceNote(harness.vaultRoot, ref.snapshotPath);
      expect(snapshot.readable && snapshot.text).toBe(canonicalHashInput(block?.[1] ?? ""));
    }
  });
});

describe("closed vocabulary", () => {
  it("ends every run with an outcome from JOB_RUN_OUTCOMES and, on failure, a code from RUN_ERROR_CODES", async () => {
    const failing: FetchSourceResult = { ok: false, code: "timeout" };
    harness = createResearchHarness({
      responses: { [SOURCE_ONE]: failing, [SOURCE_TWO]: failing, [SOURCE_THREE]: failing },
    });
    await runOnce(harness);
    const row = listJobRuns(harness.db, RESEARCH_JOB_ID, 1)[0];
    expect(JOB_RUN_OUTCOMES).toContain(row?.outcome);
    expect(RUN_ERROR_CODES).toContain(row?.errorCode);
  });
});

describe("transport", () => {
  it("never calls a transport that was not asked for: a throwing transport stays inside a failed run", async () => {
    const transport: TextTransport = {
      async complete() {
        throw new Error("boom with a secret path /Users/x");
      },
    };
    harness = createResearchHarness({ transport });
    await runOnce(harness);
    const row = listJobRuns(harness.db, RESEARCH_JOB_ID, 1)[0];
    expect(row?.outcome).toBe("failure");
    expect(row?.errorCode).toBe("summariser-failed");
    expect(JSON.stringify(harness.logLines)).not.toContain("secret");
  });
});

describe("Task 2 (partial): one unavailable source makes an honestly labelled partial report", () => {
  it("lists the unavailable source in the report, the run note, the row and the final event", async () => {
    harness = createResearchHarness({
      responses: { ...defaultResponses(), [SOURCE_TWO]: { ok: false, code: "timeout" } },
    });
    const runId = await runOnce(harness);
    const report = readReportNote(harness.vaultRoot, onlyReport(harness));
    if (!report.readable) throw new Error("report must be readable");
    expect(report.frontmatter.partial).toBe(true);
    expect(report.frontmatter.unavailableSources).toEqual([
      { label: "Beta releases", code: "timeout" },
    ]);
    expect(report.frontmatter.sourceTotal).toBe(3);
    expect(report.frontmatter.sourceRefs).toHaveLength(2);
    const row = listJobRuns(harness.db, RESEARCH_JOB_ID, 1)[0];
    expect(row?.outcome).toBe("partial");
    expect(row?.unavailableSources.map((entry) => entry.code)).toEqual(["timeout"]);
    const note = readFileSync(join(harness.vaultRoot, "automation-runs", `${runId}.md`), "utf8");
    expect(note).toContain("Outcome: Partial");
    expect(note).toContain("Beta releases");
    expect(harness.events.at(-1)?.payload).toMatchObject({
      state: "completed",
      outcome: "partial",
    });
  });
});

describe("Task 2 (failure): zero successes writes no note and records the code", () => {
  it("fails with all-sources-failed and leaves raw, wiki and output empty", async () => {
    harness = createResearchHarness({ responses: {} });
    const runId = await runOnce(harness);
    const row = listJobRuns(harness.db, RESEARCH_JOB_ID, 1)[0];
    expect(row).toMatchObject({
      outcome: "failure",
      errorCode: "all-sources-failed",
      state: "failed",
    });
    for (const folder of ["global/raw", "global/wiki", "global/output"]) {
      expect(harness.list(folder)).toEqual([]);
    }
    expect(harness.transportInputs).toHaveLength(0);
    expect(
      readFileSync(join(harness.vaultRoot, "automation-runs", `${runId}.md`), "utf8"),
    ).toContain("all-sources-failed");
    expect(harness.events.at(-1)?.payload).toMatchObject({ state: "failed", outcome: "failure" });
  });
});

describe("Task 2 (lock): one run at a time and no vault means no run", () => {
  it("answers the running run to a second press and starts nothing", async () => {
    harness = createResearchHarness();
    const first = harness.services.runNow();
    const second = harness.services.runNow();
    if (!first.ok || !second.ok) throw new Error("refused");
    expect(second.value).toEqual({
      runId: first.value.runId,
      alreadyRunning: true,
      state: "running",
    });
    await harness.services.idle();
    expect(listJobRuns(harness.db, RESEARCH_JOB_ID, 10)).toHaveLength(1);
  });

  it("refuses with vault-not-set-up and creates no job run", () => {
    harness = createResearchHarness({ vault: false });
    expect(harness.services.runNow()).toEqual({ ok: false, code: "vault-not-set-up" });
    expect(listJobRuns(harness.db, RESEARCH_JOB_ID, 10)).toEqual([]);
  });
});

describe("Task 2 (allowlist file): the file in the runtime directory decides what is fetched", () => {
  it("seeds the defaults with mode 600 when absent and fetches exactly the file's sources", async () => {
    harness = createResearchHarness({ writeConfig: false, responses: {} });
    await runOnce(harness);
    const stat = statSync(harness.sourcesPath);
    expect(stat.mode & 0o777).toBe(0o600);
    const seeded = JSON.parse(readFileSync(harness.sourcesPath, "utf8")) as {
      sources: { url: string }[];
    };
    expect(seeded.sources.length).toBeGreaterThanOrEqual(3);
    expect(harness.fetches).toHaveLength(1);
    expect(harness.fetches[0]?.urls).toEqual(seeded.sources.map((source) => source.url));
  });

  it("never reads a sources list from the vault", async () => {
    harness = createResearchHarness();
    writeFileSync(
      join(harness.vaultRoot, "inbox", "research-sources.json"),
      JSON.stringify({ topicLabel: "Injected", summariserModel: "claude-haiku-5-5", sources: [] }),
    );
    await runOnce(harness);
    expect(harness.fetches[0]?.urls).toEqual([SOURCE_ONE, SOURCE_TWO, SOURCE_THREE]);
  });

  it("repairs a file other accounts can read and refuses a corrupt one without touching it", async () => {
    harness = createResearchHarness();
    chmodSync(harness.sourcesPath, 0o644);
    await runOnce(harness);
    expect(statSync(harness.sourcesPath).mode & 0o777).toBe(0o600);

    writeFileSync(harness.sourcesPath, "{ broken", { mode: 0o600 });
    await runOnce(harness);
    expect(readFileSync(harness.sourcesPath, "utf8")).toBe("{ broken");
    expect(listJobRuns(harness.db, RESEARCH_JOB_ID, 1)[0]?.errorCode).toBe("all-sources-failed");
  });
});
